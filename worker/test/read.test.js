import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { clearBucket } from "./helpers.js";
import { VALID_SLUGS, INVALID_SLUGS } from "./slug-fixtures.js";

const TOKEN = "devtoken";
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = "http://example.com";

async function seedPage(slug, bytes, { trusted } = {}) {
  const options = {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  };
  if (trusted) options.customMetadata = { trusted: "1" };
  await env.WWWSHARE_BUCKET.put(`${slug}/index.html`, bytes, options);
}

describe("/p/{slug} — GET", () => {
  beforeEach(() => clearBucket(env));

  it("404 on missing slug", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/ghost`);
    expect(res.status).toBe(404);
  });

  it("200 on present page: bytes match, content-type, CSP, cache headers", async () => {
    // Include a high byte and a null byte to confirm no UTF-8 transcoding.
    const bytes = new Uint8Array([
      0x3c, 0x70, 0x3e, 0xc3, 0xa9, 0x00, 0x3c, 0x2f, 0x70, 0x3e,
    ]);
    await seedPage("page-1", bytes);

    const res = await exports.default.fetch(`${ORIGIN}/p/page-1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("ETag")).toMatch(/^".+"$/);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "script-src 'unsafe-inline'",
    );
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );

    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(bytes);
  });

  it("404 on a slug that doesn't match the route regex (route miss)", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/Bad-Slug`);
    expect(res.status).toBe(404);
  });
});

describe("/p/{slug} — HEAD", () => {
  beforeEach(() => clearBucket(env));

  it("200 with same headers and empty body for a present page", async () => {
    await seedPage("head-page", "<p>hi</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/head-page`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
    expect(await res.text()).toBe("");
  });

  it("404 on a missing slug", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/missing`, { method: "HEAD" });
    expect(res.status).toBe(404);
  });
});

describe("/p/{slug} — CSP varies by trust", () => {
  beforeEach(() => clearBucket(env));

  it("default page gets sandboxed CSP (no customMetadata.trusted)", async () => {
    await seedPage("sandboxed-default", "<p>hi</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/sandboxed-default`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy");
    // Drain the body so R2's isolated-storage stack can pop at teardown.
    await res.arrayBuffer();
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("allow-popups");
    expect(csp).toContain("allow-modals");
    expect(csp).toContain("allow-top-navigation-by-user-activation");
    expect(csp).not.toContain("allow-same-origin");
  });

  it("trusted page gets the non-sandbox CSP", async () => {
    await seedPage("trusted", "<p>hi</p>", { trusted: true });
    const res = await exports.default.fetch(`${ORIGIN}/p/trusted`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy");
    await res.arrayBuffer();
    expect(csp).not.toContain("sandbox");
    expect(csp).toContain("script-src 'unsafe-inline'");
  });

  it("HEAD on sandboxed page returns sandbox CSP", async () => {
    await seedPage("sandbox-head", "<p>hi</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/sandbox-head`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("HEAD on trusted page returns non-sandbox CSP", async () => {
    await seedPage("trust-head", "<p>hi</p>", { trusted: true });
    const res = await exports.default.fetch(`${ORIGIN}/p/trust-head`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).not.toContain("sandbox");
  });
});

describe("/p/{slug} — conditional requests (ETag / If-None-Match)", () => {
  beforeEach(() => clearBucket(env));

  // GET a page and return its served ETag, draining the body so R2's
  // isolated-storage stack can pop at teardown.
  async function fetchEtag(slug) {
    const res = await exports.default.fetch(`${ORIGIN}/p/${slug}`);
    await res.arrayBuffer();
    return res.headers.get("ETag");
  }

  it("GET with matching If-None-Match returns 304 with empty body and refreshed headers", async () => {
    await seedPage("cond-get", "<p>v1</p>");
    const etag = await fetchEtag("cond-get");

    const res = await exports.default.fetch(`${ORIGIN}/p/cond-get`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("HEAD with matching If-None-Match returns 304", async () => {
    await seedPage("cond-head", "<p>v1</p>");
    const probe = await exports.default.fetch(`${ORIGIN}/p/cond-head`, {
      method: "HEAD",
    });
    const etag = probe.headers.get("ETag");

    const res = await exports.default.fetch(`${ORIGIN}/p/cond-head`, {
      method: "HEAD",
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
  });

  it("GET with non-matching If-None-Match returns 200 with the full body", async () => {
    await seedPage("cond-miss", "<p>v1</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/cond-miss`, {
      headers: { "If-None-Match": '"bogus"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>v1</p>");
  });

  it("If-None-Match: * returns 304 for an existing page", async () => {
    await seedPage("cond-star", "<p>v1</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/cond-star`, {
      headers: { "If-None-Match": "*" },
    });
    expect(res.status).toBe(304);
  });

  it("comma-separated If-None-Match list containing the etag returns 304", async () => {
    await seedPage("cond-list", "<p>v1</p>");
    const etag = await fetchEtag("cond-list");

    const res = await exports.default.fetch(`${ORIGIN}/p/cond-list`, {
      headers: { "If-None-Match": `"bogus", ${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("weak-prefixed If-None-Match (W/<etag>) returns 304", async () => {
    await seedPage("cond-weak", "<p>v1</p>");
    const etag = await fetchEtag("cond-weak");

    const res = await exports.default.fetch(`${ORIGIN}/p/cond-weak`, {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("GET and HEAD report the same ETag for the same object", async () => {
    await seedPage("cond-parity", "<p>v1</p>");
    const getEtag = await fetchEtag("cond-parity");
    const headRes = await exports.default.fetch(`${ORIGIN}/p/cond-parity`, {
      method: "HEAD",
    });
    expect(headRes.headers.get("ETag")).toBe(getEtag);
  });

  it("content update changes the ETag; a stale If-None-Match gets 200 with the new body", async () => {
    await seedPage("cond-update", "<p>v1</p>");
    const oldEtag = await fetchEtag("cond-update");

    await seedPage("cond-update", "<p>v2</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/cond-update`, {
      headers: { "If-None-Match": oldEtag },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>v2</p>");
    expect(res.headers.get("ETag")).not.toBe(oldEtag);
  });

  it("deleted page: stale If-None-Match gets 404, not 304", async () => {
    await seedPage("cond-gone", "<p>v1</p>");
    const etag = await fetchEtag("cond-gone");
    await env.WWWSHARE_BUCKET.delete("cond-gone/index.html");

    const stale = await exports.default.fetch(`${ORIGIN}/p/cond-gone`, {
      headers: { "If-None-Match": etag },
    });
    expect(stale.status).toBe(404);

    // `*` must not short-circuit the existence check.
    const star = await exports.default.fetch(`${ORIGIN}/p/cond-gone`, {
      headers: { "If-None-Match": "*" },
    });
    expect(star.status).toBe(404);
  });

  // SECURITY-CRITICAL: the trust bit lives in customMetadata, not the
  // body, so a content-only etag would 304 across a trust flip and the
  // browser would keep the cached permissive CSP.
  it("trust demotion changes the served ETag: stale If-None-Match gets 200 with the SANDBOXED CSP", async () => {
    await seedPage("cond-demote", "<p>v1</p>", { trusted: true });
    const trustedEtag = await fetchEtag("cond-demote");
    const rawEtagBefore = (
      await env.WWWSHARE_BUCKET.head("cond-demote/index.html")
    ).etag;

    // Same bytes, trusted flag dropped.
    await seedPage("cond-demote", "<p>v1</p>");
    // The raw R2 etag is content-only and unchanged — proving a
    // content-only served ETag could not catch the flip.
    const rawEtagAfter = (
      await env.WWWSHARE_BUCKET.head("cond-demote/index.html")
    ).etag;
    expect(rawEtagAfter).toBe(rawEtagBefore);

    const res = await exports.default.fetch(`${ORIGIN}/p/cond-demote`, {
      headers: { "If-None-Match": trustedEtag },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("ETag")).not.toBe(trustedEtag);
  });

  it("trust promotion changes the served ETag: stale If-None-Match gets 200 with the trusted CSP", async () => {
    await seedPage("cond-promote", "<p>v1</p>");
    const sandboxedEtag = await fetchEtag("cond-promote");

    await seedPage("cond-promote", "<p>v1</p>", { trusted: true });
    const res = await exports.default.fetch(`${ORIGIN}/p/cond-promote`, {
      headers: { "If-None-Match": sandboxedEtag },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(res.headers.get("Content-Security-Policy")).not.toContain(
      "sandbox",
    );
    expect(res.headers.get("ETag")).not.toBe(sandboxedEtag);
  });
});

describe("/p/{slug} — DELETE", () => {
  beforeEach(() => clearBucket(env));

  it("401 with no Authorization header; R2 object remains", async () => {
    await seedPage("guarded", "<p>x</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/guarded`, { method: "DELETE" });
    expect(res.status).toBe(401);

    // head() avoids leaving an unconsumed R2 body stream open at teardown.
    const obj = await env.WWWSHARE_BUCKET.head("guarded/index.html");
    expect(obj).not.toBeNull();
  });

  it("401 with wrong bearer; R2 object remains", async () => {
    await seedPage("guarded2", "<p>x</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/guarded2`, {
      method: "DELETE",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);

    const obj = await env.WWWSHARE_BUCKET.head("guarded2/index.html");
    expect(obj).not.toBeNull();
  });

  it("404 on auth'd delete of nonexistent slug", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/never`, {
      method: "DELETE",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(404);
  });

  it("204 happy path with no body; R2 key removed", async () => {
    await seedPage("doomed", "<p>x</p>");
    const res = await exports.default.fetch(`${ORIGIN}/p/doomed`, {
      method: "DELETE",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const obj = await env.WWWSHARE_BUCKET.get("doomed/index.html");
    expect(obj).toBeNull();
  });
});

describe("/p/{slug} — method handling", () => {
  it("405 with Allow: GET, HEAD, DELETE on PUT", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/some-slug`, {
      method: "PUT",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, DELETE");
  });

  it("405 with Allow: GET, HEAD, DELETE on PATCH", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/some-slug`, {
      method: "PATCH",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, DELETE");
  });

  it("405 with Allow: GET, HEAD, DELETE on POST to a slug path", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/p/some-slug`, {
      method: "POST",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(405);
  });
});

// Slug parity (route side). VALID-shaped slugs hit the handler — DELETE
// without auth returns 401. INVALID-shaped slugs miss the route — same
// DELETE returns 404. The 401 vs 404 distinction is what proves the
// route regex behaved correctly.
describe("/p/{slug} — slug parity (route matching)", () => {
  for (const slug of VALID_SLUGS) {
    it(`route accepts valid slug ${JSON.stringify(slug)} (DELETE → 401)`, async () => {
      const res = await exports.default.fetch(`${ORIGIN}/p/${slug}`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });
  }

  for (const [slug, label] of INVALID_SLUGS) {
    // Skip the empty case — `/p/` doesn't match the route regex (no slug
    // captured); the test would conflate "route requires at least one
    // char" with "slug regex".
    if (slug === "") continue;
    // Skip "abc/def" — produces /p/abc/def which is a different path
    // shape (3 segments). Route-miss still 404, but for a different
    // reason; outside the slug-parity contract.
    if (slug === "abc/def") continue;
    it(`route rejects invalid slug ${JSON.stringify(slug)} (${label}) (DELETE → 404)`, async () => {
      const res = await exports.default.fetch(`${ORIGIN}/p/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  }
});
