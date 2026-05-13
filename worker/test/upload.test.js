import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { clearBucket } from "./helpers.js";
import { VALID_SLUGS, INVALID_SLUGS } from "./slug-fixtures.js";

const TOKEN = "devtoken";
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = "http://example.com";

function htmlBlob(text) {
  return new Blob([text], { type: "text/html; charset=utf-8" });
}

function buildForm({
  slug = "test-slug",
  html = "<!doctype html><title>x</title>",
  update,
  trusted,
  omitSlug,
  omitHtml,
  htmlAsString,
  extraSlug,
  extraHtml,
  extraHtmlString,
  extraUpdate,
  extraTrusted,
} = {}) {
  const form = new FormData();
  if (!omitSlug) form.append("slug", slug);
  if (extraSlug !== undefined) form.append("slug", extraSlug);
  if (!omitHtml) {
    if (htmlAsString) {
      form.append("html", html);
    } else {
      form.append("html", htmlBlob(html), "page.html");
    }
  }
  if (extraHtml !== undefined) {
    form.append("html", htmlBlob(extraHtml), "extra.html");
  }
  if (extraHtmlString !== undefined) {
    form.append("html", extraHtmlString);
  }
  if (update !== undefined) form.append("update", update);
  if (extraUpdate !== undefined) form.append("update", extraUpdate);
  if (trusted !== undefined) form.append("trusted", trusted);
  if (extraTrusted !== undefined) form.append("trusted", extraTrusted);
  return form;
}

async function postUpload(form, { headers = {} } = {}) {
  return SELF.fetch(`${ORIGIN}/upload`, {
    method: "POST",
    headers: { Authorization: AUTH, ...headers },
    body: form,
  });
}

async function readKey(slug) {
  return env.WWWSHARE_BUCKET.get(`${slug}/index.html`);
}

// Use head() when we only need metadata/existence. get() returns a body
// stream that has to be consumed before the test ends or the vitest-pool
// fails to pop isolated R2 storage.
async function headKey(slug) {
  return env.WWWSHARE_BUCKET.head(`${slug}/index.html`);
}

describe("/upload — auth", () => {
  beforeEach(() => clearBucket(env));

  it("returns 401 with no Authorization header", async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, {
      method: "POST",
      body: buildForm(),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 401 with wrong bearer token", async () => {
    const res = await postUpload(buildForm(), {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });
});

describe("/upload — content-type / size", () => {
  beforeEach(() => clearBucket(env));

  it("returns 415 for non-multipart Content-Type", async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "abc", html: "<p>x</p>" }),
    });
    expect(res.status).toBe(415);
  });

  it("returns 413 when declared Content-Length exceeds cap", async () => {
    const form = buildForm();
    const res = await SELF.fetch(`${ORIGIN}/upload`, {
      method: "POST",
      headers: {
        Authorization: AUTH,
        "Content-Length": String(26 * 1024 * 1024),
      },
      body: form,
    });
    expect(res.status).toBe(413);
  });

  it("returns 413 via fallback sum when parts exceed cap without Content-Length", async () => {
    const huge = "x".repeat(26 * 1024 * 1024);
    const form = buildForm({ html: huge });
    const res = await postUpload(form);
    expect(res.status).toBe(413);
  });

  it("returns 400 on malformed multipart body", async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, {
      method: "POST",
      headers: {
        Authorization: AUTH,
        "Content-Type": "multipart/form-data; boundary=xyz",
      },
      body: "not actually multipart",
    });
    expect(res.status).toBe(400);
  });
});

describe("/upload — slug part validation", () => {
  beforeEach(() => clearBucket(env));

  it("400 missing slug", async () => {
    const res = await postUpload(buildForm({ omitSlug: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing slug");
  });

  it("400 duplicate slug fields", async () => {
    const res = await postUpload(buildForm({ extraSlug: "another" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("duplicate slug");
  });
});

describe("/upload — html part validation", () => {
  beforeEach(() => clearBucket(env));

  it("400 missing html", async () => {
    const res = await postUpload(buildForm({ omitHtml: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing html");
  });

  it("400 duplicate html parts (two files)", async () => {
    const res = await postUpload(buildForm({ extraHtml: "<p>y</p>" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("duplicate html");
  });

  it("400 mixed-type duplicate html → duplicate, not type error", async () => {
    const res = await postUpload(buildForm({ extraHtmlString: "<p>y</p>" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("duplicate html");
  });

  it("400 html part sent as plain string", async () => {
    const res = await postUpload(buildForm({ htmlAsString: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("html part must be a file");
  });

  it("400 empty html (zero-byte file)", async () => {
    const res = await postUpload(buildForm({ html: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("empty html");
  });
});

describe("/upload — update field", () => {
  beforeEach(() => clearBucket(env));

  it("400 duplicate update fields", async () => {
    const res = await postUpload(
      buildForm({ slug: "abc", update: "1", extraUpdate: "1" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("duplicate update");
  });

  it("update=0 is treated as create → 409 when slug exists", async () => {
    await env.WWWSHARE_BUCKET.put("exists/index.html", "<p>old</p>");
    const res = await postUpload(buildForm({ slug: "exists", update: "0" }));
    expect(res.status).toBe(409);
  });

  it("update=true is treated as create → 409 when slug exists", async () => {
    await env.WWWSHARE_BUCKET.put("exists/index.html", "<p>old</p>");
    const res = await postUpload(buildForm({ slug: "exists", update: "true" }));
    expect(res.status).toBe(409);
  });

  it("missing update is treated as create → 409 when slug exists", async () => {
    await env.WWWSHARE_BUCKET.put("exists/index.html", "<p>old</p>");
    const res = await postUpload(buildForm({ slug: "exists" }));
    expect(res.status).toBe(409);
  });
});

describe("/upload — slug parity (table-driven)", () => {
  beforeEach(() => clearBucket(env));

  for (const slug of VALID_SLUGS) {
    it(`accepts valid slug ${JSON.stringify(slug)}`, async () => {
      const res = await postUpload(buildForm({ slug }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.slug).toBe(slug);
      expect(body.url).toBe(`${ORIGIN}/p/${slug}`);
    });
  }

  for (const [slug, label] of INVALID_SLUGS) {
    it(`rejects invalid slug ${JSON.stringify(slug)} (${label}) with 400`, async () => {
      const res = await postUpload(buildForm({ slug }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid slug");
    });
  }
});

describe("/upload — create happy path", () => {
  beforeEach(() => clearBucket(env));

  it("returns 201, writes R2 with correct Content-Type metadata, response shape correct", async () => {
    const res = await postUpload(
      buildForm({ slug: "first-page", html: "<!doctype html><p>hi</p>" }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ url: `${ORIGIN}/p/first-page`, slug: "first-page" });

    const obj = await readKey("first-page");
    expect(obj).not.toBeNull();
    expect(await obj.text()).toBe("<!doctype html><p>hi</p>");
    expect(obj.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
  });

  it("forces text/html metadata even if client labels the blob differently", async () => {
    const form = new FormData();
    form.append("slug", "metadata-test");
    form.append(
      "html",
      new Blob(["<p>x</p>"], { type: "application/octet-stream" }),
      "page.html",
    );
    const res = await postUpload(form);
    expect(res.status).toBe(201);
    const obj = await headKey("metadata-test");
    expect(obj.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
  });
});

describe("/upload — conflict + update", () => {
  beforeEach(() => clearBucket(env));

  it("409 on create when slug exists", async () => {
    await postUpload(buildForm({ slug: "taken" }));
    const res = await postUpload(buildForm({ slug: "taken", html: "<p>2</p>" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("slug exists");
  });

  it("404 on update when slug doesn't exist", async () => {
    const res = await postUpload(buildForm({ slug: "ghost", update: "1" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no page at slug ghost");
  });

  it("200 on update when slug exists; bytes overwritten", async () => {
    await postUpload(buildForm({ slug: "live", html: "<p>v1</p>" }));
    const res = await postUpload(
      buildForm({ slug: "live", html: "<p>v2</p>", update: "1" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ url: `${ORIGIN}/p/live`, slug: "live" });
    const obj = await readKey("live");
    expect(await obj.text()).toBe("<p>v2</p>");
  });
});

describe("/upload — trusted field", () => {
  beforeEach(() => clearBucket(env));

  it("400 duplicate trusted fields", async () => {
    const res = await postUpload(
      buildForm({ slug: "abc", trusted: "1", extraTrusted: "1" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("duplicate trusted");
  });

  it("missing trusted → R2 object has no customMetadata.trusted (sandboxed)", async () => {
    const res = await postUpload(buildForm({ slug: "default-trust" }));
    expect(res.status).toBe(201);
    const obj = await headKey("default-trust");
    expect(obj.customMetadata?.trusted).toBeUndefined();
  });

  it("trusted=1 → R2 object has customMetadata.trusted === '1'", async () => {
    const res = await postUpload(
      buildForm({ slug: "trusted-page", trusted: "1" }),
    );
    expect(res.status).toBe(201);
    const obj = await headKey("trusted-page");
    expect(obj.customMetadata?.trusted).toBe("1");
  });

  it("trusted=0 → treated as untrusted (no customMetadata.trusted)", async () => {
    const res = await postUpload(
      buildForm({ slug: "zero-trust", trusted: "0" }),
    );
    expect(res.status).toBe(201);
    const obj = await headKey("zero-trust");
    expect(obj.customMetadata?.trusted).toBeUndefined();
  });

  it("trusted=true → treated as untrusted (strict, only '1' counts)", async () => {
    const res = await postUpload(
      buildForm({ slug: "true-trust", trusted: "true" }),
    );
    expect(res.status).toBe(201);
    const obj = await headKey("true-trust");
    expect(obj.customMetadata?.trusted).toBeUndefined();
  });

  it("update without trusted demotes a previously trusted page", async () => {
    await postUpload(buildForm({ slug: "demote", trusted: "1" }));
    let obj = await headKey("demote");
    expect(obj.customMetadata?.trusted).toBe("1");

    const res = await postUpload(buildForm({ slug: "demote", update: "1" }));
    expect(res.status).toBe(200);
    obj = await headKey("demote");
    expect(obj.customMetadata?.trusted).toBeUndefined();
  });

  it("update with trusted=1 promotes a previously sandboxed page", async () => {
    await postUpload(buildForm({ slug: "promote" }));
    let obj = await headKey("promote");
    expect(obj.customMetadata?.trusted).toBeUndefined();

    const res = await postUpload(
      buildForm({ slug: "promote", update: "1", trusted: "1" }),
    );
    expect(res.status).toBe(200);
    obj = await headKey("promote");
    expect(obj.customMetadata?.trusted).toBe("1");
  });
});

describe("/upload — method handling", () => {
  it("405 with Allow: POST on GET", async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("405 with Allow: POST on DELETE", async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, {
      method: "DELETE",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
