import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  parseArgs,
  uploadPage,
  deletePage,
} from "../src/wwwshare.mjs";

// Slug-parity fixture — must agree with worker/test/upload.test.js. If
// they drift, the slug contract is broken across worker validation,
// worker route matching, and CLI argv parsing.
const VALID_SLUGS = [
  "a",
  "ab",
  "a-b",
  "abc-123",
  "12345",
  "a".repeat(64),
  "a-b-c-d",
];
const INVALID_SLUGS = [
  ["", "empty"],
  ["A", "uppercase"],
  ["-abc", "leading dash"],
  ["abc-", "trailing dash"],
  ["a_b", "underscore"],
  ["a.b", "dot"],
  ["a!b", "bang"],
  ["a".repeat(65), "65 chars"],
  ["abc def", "space"],
  ["abc/def", "slash"],
];

const HEAD = ["node", "wwwshare.mjs"];

describe("parseArgs — create form (2 args)", () => {
  it("returns action=create with file and slug; trust=false by default", () => {
    expect(parseArgs([...HEAD, "./page.html", "my-page"])).toEqual({
      action: "create",
      slug: "my-page",
      file: "./page.html",
      trust: false,
      noCp: false,
    });
  });

  it("throws usage on too few args", () => {
    expect(() => parseArgs([...HEAD])).toThrow(/usage:/);
    expect(() => parseArgs([...HEAD, "./page.html"])).toThrow(/usage:/);
  });
});

describe("parseArgs — update form", () => {
  it("returns action=update with slug and file; trust=false by default", () => {
    expect(parseArgs([...HEAD, "update", "my-page", "./page.html"])).toEqual({
      action: "update",
      slug: "my-page",
      file: "./page.html",
      trust: false,
      noCp: false,
    });
  });

  it("throws usage on missing args", () => {
    expect(() => parseArgs([...HEAD, "update"])).toThrow(/usage:/);
    expect(() => parseArgs([...HEAD, "update", "my-page"])).toThrow(/usage:/);
  });

  it("throws usage on extra args", () => {
    expect(() =>
      parseArgs([...HEAD, "update", "my-page", "./page.html", "extra"]),
    ).toThrow(/usage:/);
  });
});

describe("parseArgs — remove form", () => {
  it("returns action=remove with slug", () => {
    expect(parseArgs([...HEAD, "remove", "my-page"])).toEqual({
      action: "remove",
      slug: "my-page",
    });
  });

  it("throws usage on missing slug", () => {
    expect(() => parseArgs([...HEAD, "remove"])).toThrow(/usage:/);
  });

  it("throws usage on extra args", () => {
    expect(() => parseArgs([...HEAD, "remove", "my-page", "extra"])).toThrow(
      /usage:/,
    );
  });
});

describe("parseArgs — --trust flag", () => {
  it("sets trust=true on create when --trust appears", () => {
    expect(parseArgs([...HEAD, "./f.html", "abc", "--trust"])).toEqual({
      action: "create",
      slug: "abc",
      file: "./f.html",
      trust: true,
      noCp: false,
    });
  });

  it("accepts --trust before positionals", () => {
    expect(parseArgs([...HEAD, "--trust", "./f.html", "abc"])).toEqual({
      action: "create",
      slug: "abc",
      file: "./f.html",
      trust: true,
      noCp: false,
    });
  });

  it("accepts --trust between positionals", () => {
    expect(parseArgs([...HEAD, "./f.html", "--trust", "abc"])).toEqual({
      action: "create",
      slug: "abc",
      file: "./f.html",
      trust: true,
      noCp: false,
    });
  });

  it("sets trust=true on update when --trust appears", () => {
    expect(
      parseArgs([...HEAD, "update", "abc", "./f.html", "--trust"]),
    ).toEqual({
      action: "update",
      slug: "abc",
      file: "./f.html",
      trust: true,
      noCp: false,
    });
  });

  it("rejects --trust on remove", () => {
    expect(() => parseArgs([...HEAD, "remove", "abc", "--trust"])).toThrow(
      /--trust is not valid with remove/,
    );
  });

  it("rejects unknown --flags", () => {
    expect(() => parseArgs([...HEAD, "./f.html", "abc", "--bogus"])).toThrow(
      /unknown flag: --bogus/,
    );
  });
});

describe("parseArgs — --no-cp flag", () => {
  it("sets noCp=true on create when --no-cp appears", () => {
    expect(parseArgs([...HEAD, "./f.html", "abc", "--no-cp"])).toEqual({
      action: "create",
      slug: "abc",
      file: "./f.html",
      trust: false,
      noCp: true,
    });
  });

  it("sets noCp=true on update when --no-cp appears", () => {
    expect(
      parseArgs([...HEAD, "update", "abc", "./f.html", "--no-cp"]),
    ).toEqual({
      action: "update",
      slug: "abc",
      file: "./f.html",
      trust: false,
      noCp: true,
    });
  });

  it("accepts --no-cp before positionals", () => {
    expect(parseArgs([...HEAD, "--no-cp", "./f.html", "abc"])).toEqual({
      action: "create",
      slug: "abc",
      file: "./f.html",
      trust: false,
      noCp: true,
    });
  });

  it("combines with --trust on create", () => {
    expect(
      parseArgs([...HEAD, "./f.html", "abc", "--trust", "--no-cp"]),
    ).toEqual({
      action: "create",
      slug: "abc",
      file: "./f.html",
      trust: true,
      noCp: true,
    });
  });

  it("rejects --no-cp on remove", () => {
    expect(() => parseArgs([...HEAD, "remove", "abc", "--no-cp"])).toThrow(
      /--no-cp is not valid with remove/,
    );
  });
});

describe("parseArgs — slug parity (table-driven)", () => {
  for (const slug of VALID_SLUGS) {
    it(`accepts valid slug ${JSON.stringify(slug)} (create)`, () => {
      expect(parseArgs([...HEAD, "./f.html", slug])).toEqual({
        action: "create",
        slug,
        file: "./f.html",
        trust: false,
        noCp: false,
      });
    });
    it(`accepts valid slug ${JSON.stringify(slug)} (update)`, () => {
      expect(parseArgs([...HEAD, "update", slug, "./f.html"])).toEqual({
        action: "update",
        slug,
        file: "./f.html",
        trust: false,
        noCp: false,
      });
    });
    it(`accepts valid slug ${JSON.stringify(slug)} (remove)`, () => {
      expect(parseArgs([...HEAD, "remove", slug])).toEqual({
        action: "remove",
        slug,
      });
    });
  }

  for (const [slug, label] of INVALID_SLUGS) {
    if (slug === "") continue; // empty would parse as wrong arity, not slug format
    it(`rejects invalid slug ${JSON.stringify(slug)} (${label})`, () => {
      expect(() => parseArgs([...HEAD, "./f.html", slug])).toThrow(
        /invalid slug format/,
      );
    });
  }
});

// FormData reader: drains a FormData instance back into a structure we
// can assert against.
async function readForm(form) {
  const out = { strings: {}, files: {} };
  for (const [name, value] of form) {
    if (value && typeof value === "object" && "arrayBuffer" in value) {
      out.files[name] = {
        type: value.type,
        bytes: new Uint8Array(await value.arrayBuffer()),
      };
    } else {
      out.strings[name] = String(value);
    }
  }
  return out;
}

function makeFetchMock(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  fn.calls = calls;
  return fn;
}

function ok(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function err(status, statusText, body) {
  return {
    ok: false,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("uploadPage", () => {
  it("POSTs /upload with Authorization, slug, and html parts", async () => {
    const fetchImpl = makeFetchMock(
      ok(201, { url: "https://x.example/p/abc", slug: "abc" }),
    );
    const html = Buffer.from("<p>hi</p>");
    const result = await uploadPage({
      endpoint: "https://x.example",
      token: "tok",
      html,
      slug: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ url: "https://x.example/p/abc", slug: "abc" });

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, init } = fetchImpl.calls[0];
    expect(url).toBe("https://x.example/upload");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");

    const form = await readForm(init.body);
    expect(form.strings.slug).toBe("abc");
    expect(form.strings.update).toBeUndefined();
    expect(form.files.html).toBeDefined();
    expect(form.files.html.bytes).toEqual(new Uint8Array(html));
  });

  it("includes update=1 when update is truthy", async () => {
    const fetchImpl = makeFetchMock(
      ok(200, { url: "https://x.example/p/abc", slug: "abc" }),
    );
    await uploadPage({
      endpoint: "https://x.example",
      token: "tok",
      html: Buffer.from("<p>v2</p>"),
      slug: "abc",
      update: true,
      fetchImpl,
    });
    const form = await readForm(fetchImpl.calls[0].init.body);
    expect(form.strings.update).toBe("1");
  });

  it("includes trusted=1 when trust is truthy", async () => {
    const fetchImpl = makeFetchMock(
      ok(201, { url: "https://x.example/p/abc", slug: "abc" }),
    );
    await uploadPage({
      endpoint: "https://x.example",
      token: "tok",
      html: Buffer.from("<p>hi</p>"),
      slug: "abc",
      trust: true,
      fetchImpl,
    });
    const form = await readForm(fetchImpl.calls[0].init.body);
    expect(form.strings.trusted).toBe("1");
  });

  it("omits trusted when trust is falsy (default sandboxed)", async () => {
    const fetchImpl = makeFetchMock(
      ok(201, { url: "https://x.example/p/abc", slug: "abc" }),
    );
    await uploadPage({
      endpoint: "https://x.example",
      token: "tok",
      html: Buffer.from("<p>hi</p>"),
      slug: "abc",
      fetchImpl,
    });
    const form = await readForm(fetchImpl.calls[0].init.body);
    expect(form.strings.trusted).toBeUndefined();
  });

  it("round-trips arbitrary bytes (high-bit + null byte) without utf-8 mangling", async () => {
    const fetchImpl = makeFetchMock(
      ok(201, { url: "https://x.example/p/abc", slug: "abc" }),
    );
    const bytes = Buffer.from([
      0x3c, 0x70, 0x3e, 0xc3, 0xa9, 0x00, 0x3c, 0x2f, 0x70, 0x3e,
    ]);
    await uploadPage({
      endpoint: "https://x.example",
      token: "tok",
      html: bytes,
      slug: "abc",
      fetchImpl,
    });
    const form = await readForm(fetchImpl.calls[0].init.body);
    expect(form.files.html.bytes).toEqual(new Uint8Array(bytes));
  });

  it("on 409 response: throws Error with status + parsed body, message includes detail", async () => {
    const fetchImpl = makeFetchMock(
      err(409, "Conflict", { error: "slug exists" }),
    );
    await expect(
      uploadPage({
        endpoint: "https://x.example",
        token: "tok",
        html: Buffer.from("<p>x</p>"),
        slug: "abc",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("slug exists"),
      body: { error: "slug exists" },
    });
  });
});

describe("deletePage", () => {
  it("DELETEs /p/{slug} with Authorization on 204 success", async () => {
    const fetchImpl = makeFetchMock({
      ok: true,
      status: 204,
      statusText: "No Content",
      text: async () => "",
      json: async () => ({}),
    });
    const result = await deletePage({
      endpoint: "https://x.example",
      token: "tok",
      slug: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ url: "https://x.example/p/abc" });

    const { url, init } = fetchImpl.calls[0];
    expect(url).toBe("https://x.example/p/abc");
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("on 404: throws Error mentioning the slug", async () => {
    const fetchImpl = makeFetchMock(
      err(404, "Not Found", { error: "not found" }),
    );
    await expect(
      deletePage({
        endpoint: "https://x.example",
        token: "tok",
        slug: "ghost",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("ghost"),
    });
  });

  it("on 401: throws Error with status 401", async () => {
    const fetchImpl = makeFetchMock(
      err(401, "Unauthorized", { error: "unauthorized" }),
    );
    await expect(
      deletePage({
        endpoint: "https://x.example",
        token: "tok",
        slug: "abc",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
