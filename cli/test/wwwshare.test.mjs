import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  uploadPage,
  deletePage,
  listPages,
  removeMany,
  pageUrl,
  browserOpener,
  openInBrowser,
  requireEndpoint,
  readHtmlFile,
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
  it("returns action=remove with a single-slug array", () => {
    expect(parseArgs([...HEAD, "remove", "my-page"])).toEqual({
      action: "remove",
      slugs: ["my-page"],
    });
  });

  it("returns action=remove with all positional slugs in input order", () => {
    expect(parseArgs([...HEAD, "remove", "a", "b", "c"])).toEqual({
      action: "remove",
      slugs: ["a", "b", "c"],
    });
  });

  it("throws usage on missing slug", () => {
    expect(() => parseArgs([...HEAD, "remove"])).toThrow(/usage:/);
  });

  it("rejects an invalid slug anywhere in the list before any network call", () => {
    expect(() =>
      parseArgs([...HEAD, "remove", "good", "BAD_SLUG", "also-good"]),
    ).toThrow(/invalid slug format/);
  });
});

describe("parseArgs — list form", () => {
  it("returns action=list with no other fields", () => {
    expect(parseArgs([...HEAD, "list"])).toEqual({ action: "list" });
  });

  it("throws usage on extra positional", () => {
    expect(() => parseArgs([...HEAD, "list", "extra"])).toThrow(/usage:/);
  });

  it("rejects --trust on list", () => {
    expect(() => parseArgs([...HEAD, "list", "--trust"])).toThrow(
      /--trust is not valid with list/,
    );
  });

  it("rejects --no-cp on list", () => {
    expect(() => parseArgs([...HEAD, "list", "--no-cp"])).toThrow(
      /--no-cp is not valid with list/,
    );
  });
});

describe("parseArgs — open form", () => {
  it("returns action=open with the slug", () => {
    expect(parseArgs([...HEAD, "open", "my-page"])).toEqual({
      action: "open",
      slug: "my-page",
    });
  });

  it("throws usage on missing slug", () => {
    expect(() => parseArgs([...HEAD, "open"])).toThrow(/usage:/);
  });

  it("throws usage on extra positional", () => {
    expect(() => parseArgs([...HEAD, "open", "a", "b"])).toThrow(/usage:/);
  });

  it("rejects an invalid slug before any launch", () => {
    expect(() => parseArgs([...HEAD, "open", "BAD_SLUG"])).toThrow(
      /invalid slug format/,
    );
  });

  it("rejects --trust on open", () => {
    expect(() => parseArgs([...HEAD, "open", "abc", "--trust"])).toThrow(
      /--trust is not valid with open/,
    );
  });

  it("rejects --no-cp on open", () => {
    expect(() => parseArgs([...HEAD, "open", "abc", "--no-cp"])).toThrow(
      /--no-cp is not valid with open/,
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
        slugs: [slug],
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

const NO_CONTENT = {
  ok: true,
  status: 204,
  statusText: "No Content",
  text: async () => "",
  json: async () => ({}),
};

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
    const fetchImpl = makeFetchMock(NO_CONTENT);
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

describe("removeMany", () => {
  // Per-call response queue — different from makeFetchMock, which returns the
  // same response forever. Throwing when exhausted catches "called more times
  // than expected" bugs (e.g. failing to bail on 401).
  function makeFetchQueue(responses) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      if (responses.length === 0) {
        throw new Error("fetch called more times than responses queued");
      }
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    fn.calls = calls;
    return fn;
  }

  function buf() {
    const chunks = [];
    return {
      chunks,
      write: (s) => {
        chunks.push(s);
      },
    };
  }

  it("removes every slug in input order on all-204; failures=0", async () => {
    const fetchImpl = makeFetchQueue([NO_CONTENT, NO_CONTENT, NO_CONTENT]);
    const stdout = buf();
    const stderr = buf();
    const result = await removeMany({
      endpoint: "https://x.example",
      token: "tok",
      slugs: ["a", "b", "c"],
      fetchImpl,
      stdout,
      stderr,
    });
    expect(result).toEqual({ failures: 0 });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      "https://x.example/p/a",
      "https://x.example/p/b",
      "https://x.example/p/c",
    ]);
    expect(stdout.chunks.join("")).toBe(
      `✓ Removed "a"\n  https://x.example/p/a\n` +
        `✓ Removed "b"\n  https://x.example/p/b\n` +
        `✓ Removed "c"\n  https://x.example/p/c\n`,
    );
    expect(stderr.chunks.join("")).toBe("");
  });

  it("continues past a mid-list 404; reports failures=1 and still attempts every slug", async () => {
    const fetchImpl = makeFetchQueue([
      NO_CONTENT,
      err(404, "Not Found", { error: "not found" }),
      NO_CONTENT,
    ]);
    const stdout = buf();
    const stderr = buf();
    const result = await removeMany({
      endpoint: "https://x.example",
      token: "tok",
      slugs: ["a", "b", "c"],
      fetchImpl,
      stdout,
      stderr,
    });
    expect(result).toEqual({ failures: 1 });
    expect(fetchImpl.calls).toHaveLength(3);
    expect(stdout.chunks.join("")).toBe(
      `✓ Removed "a"\n  https://x.example/p/a\n` +
        `✓ Removed "c"\n  https://x.example/p/c\n`,
    );
    expect(stderr.chunks.join("")).toMatch(
      /✗ Remove failed: no page at slug b/,
    );
  });

  it("bails on 401: stops processing, prints token hint, never attempts later slugs", async () => {
    const fetchImpl = makeFetchQueue([
      NO_CONTENT,
      err(401, "Unauthorized", { error: "unauthorized" }),
      // c's response is intentionally absent — if removeMany doesn't bail,
      // the queue will throw and the test will fail with a clear message.
    ]);
    const stdout = buf();
    const stderr = buf();
    const result = await removeMany({
      endpoint: "https://x.example",
      token: "tok",
      slugs: ["a", "b", "c"],
      fetchImpl,
      stdout,
      stderr,
    });
    expect(result).toEqual({ failures: 1 });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(stdout.chunks.join("")).toBe(
      `✓ Removed "a"\n  https://x.example/p/a\n`,
    );
    const errText = stderr.chunks.join("");
    expect(errText).toMatch(/✗ Remove failed: 401/);
    expect(errText).toMatch(/  Check WWWSHARE_UPLOAD_TOKEN/);
  });

  it("propagates non-HTTP errors (no .status) instead of swallowing them per-slug", async () => {
    const fetchImpl = makeFetchQueue([
      new Error("fetch failed"),
      // b's response is intentionally absent.
    ]);
    const stdout = buf();
    const stderr = buf();
    await expect(
      removeMany({
        endpoint: "https://x.example",
        token: "tok",
        slugs: ["a", "b"],
        fetchImpl,
        stdout,
        stderr,
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(stderr.chunks.join("")).toBe("");
  });
});

describe("listPages", () => {
  it("GETs /list with Authorization and returns the slugs array", async () => {
    const fetchImpl = makeFetchMock(ok(200, { slugs: ["a", "b", "c"] }));
    const result = await listPages({
      endpoint: "https://x.example",
      token: "tok",
      fetchImpl,
    });
    expect(result).toEqual(["a", "b", "c"]);

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, init } = fetchImpl.calls[0];
    expect(url).toBe("https://x.example/list");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("returns an empty array when the server returns {slugs: []}", async () => {
    const fetchImpl = makeFetchMock(ok(200, { slugs: [] }));
    const result = await listPages({
      endpoint: "https://x.example",
      token: "tok",
      fetchImpl,
    });
    expect(result).toEqual([]);
  });

  it("on 401: throws Error with status 401", async () => {
    const fetchImpl = makeFetchMock(
      err(401, "Unauthorized", { error: "unauthorized" }),
    );
    await expect(
      listPages({
        endpoint: "https://x.example",
        token: "tok",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("on 500: throws Error with status and detail", async () => {
    const fetchImpl = makeFetchMock(
      err(500, "Internal Server Error", { error: "boom" }),
    );
    await expect(
      listPages({
        endpoint: "https://x.example",
        token: "tok",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("boom"),
    });
  });

  it("throws on malformed response (missing slugs array)", async () => {
    const fetchImpl = makeFetchMock(ok(200, { not: "slugs" }));
    await expect(
      listPages({
        endpoint: "https://x.example",
        token: "tok",
        fetchImpl,
      }),
    ).rejects.toThrow(/malformed response/);
  });
});

describe("pageUrl", () => {
  it("builds the public /p/<slug> URL", () => {
    expect(pageUrl("https://x.example", "foo")).toBe(
      "https://x.example/p/foo",
    );
  });

  it("handles a trailing slash on the endpoint", () => {
    expect(pageUrl("https://x.example/", "foo")).toBe(
      "https://x.example/p/foo",
    );
  });

  it("resolves origin-relative, stripping any path on the endpoint", () => {
    expect(pageUrl("https://x.example/base", "foo")).toBe(
      "https://x.example/p/foo",
    );
  });

  it("works against a custom domain", () => {
    expect(pageUrl("https://share.example.com", "foo")).toBe(
      "https://share.example.com/p/foo",
    );
  });
});

// Endpoint validation fixture. CAREFUL rows are annotated — URL parsing has
// surprising successes ("localhost:8787" parses with scheme "localhost:"),
// so the protocol allowlist, not the try/catch, is the load-bearing check.
const VALID_ENDPOINTS = [
  "https://wwwshare.example.com",
  "http://localhost:8787", // local dev
  "https://x.example:8443", // explicit port
  "https://x.example/", // trailing slash
  // Scheme shorthand: parses + normalizes; new URL(path, endpoint) resolves
  // correctly downstream, so rejecting it would be pure pedantry.
  "https:example.com",
];
const INVALID_ENDPOINTS = [
  [undefined, "unset", /WWWSHARE_ENDPOINT is not set/],
  ["", "empty", /WWWSHARE_ENDPOINT is not set/],
  [
    "wwwshare.foo.workers.dev",
    "bare hostname",
    /must be an http\(s\) URL .*"wwwshare\.foo\.workers\.dev"/,
  ],
  // Parses on current Node (protocol "localhost:") but throws on some builds;
  // both paths produce the same allowlist error, so this row is version-proof.
  [
    "localhost:8787",
    "scheme-less host:port",
    /must be an http\(s\) URL .*"localhost:8787"/,
  ],
  ["localhost", "bare word", /must be an http\(s\) URL/],
  [
    "ftp://x.example",
    "non-http protocol",
    /must be an http\(s\) URL .*"ftp:\/\/x\.example"/,
  ],
  ["   ", "whitespace-only", /must be an http\(s\) URL/],
  [
    "https://user:pass@x.example",
    "embedded credentials",
    /must not embed credentials/,
  ],
];

describe("requireEndpoint", () => {
  for (const endpoint of VALID_ENDPOINTS) {
    it(`accepts valid endpoint ${JSON.stringify(endpoint)} and returns it unchanged`, () => {
      expect(requireEndpoint(endpoint)).toBe(endpoint);
    });
  }

  for (const [endpoint, label, messageRe] of INVALID_ENDPOINTS) {
    it(`rejects invalid endpoint ${JSON.stringify(endpoint)} (${label})`, () => {
      // Every row's regex names WWWSHARE_ENDPOINT (directly or via the shared
      // message prefix), so a bad value can never surface as a bare error.
      expect(() => requireEndpoint(endpoint)).toThrow(messageRe);
    });
  }
});

// Spawns the real CLI script as a child process — exercises the main()
// wiring the unit tests can't reach. Injected env vars beat any user config
// because dotenv never overrides existing vars — hermetic.
function runCli(args, env) {
  const script = fileURLToPath(new URL("../src/wwwshare.mjs", import.meta.url));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, ...env } },
      (error, _stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stderr });
      },
    );
  });
}

// One spawned-CLI test so the main() wiring itself is exercised — the unit
// tests above would stay green if requireEndpoint existed but main() never
// called it, leaving the user-facing bug alive. `open` needs no token and
// makes no network call, so a bad endpoint must fail before anything else.
describe("CLI endpoint validation (integration)", () => {
  it("fails fast with an actionable message on a scheme-less endpoint", async () => {
    const { code, stderr } = await runCli(["open", "abc"], {
      WWWSHARE_ENDPOINT: "localhost:8787",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/WWWSHARE_ENDPOINT/);
    expect(stderr).toMatch(/localhost:8787/);
    expect(stderr).toMatch(/https:\/\/wwwshare\.example\.com/);
  });
});

// Resolves with the rejection of `promise` (fails loudly if it resolves), so
// one call can back multiple assertions — message, code, cause — without
// re-running the operation.
function rejectionOf(promise) {
  return promise.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (err) => err,
  );
}

describe("readHtmlFile — real filesystem", () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wwwshare-test-"));
  });
  afterAll(() => {
    // Cleanup works even for the chmod-000 fixture: unlink needs only
    // directory write permission, not permission on the file itself.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the file's exact bytes (including high-bit bytes) on success", async () => {
    const bytes = Buffer.from([
      0x3c, 0x70, 0x3e, 0xc3, 0xa9, 0x00, 0x3c, 0x2f, 0x70, 0x3e,
    ]);
    const file = path.join(dir, "page.html");
    fs.writeFileSync(file, bytes);
    expect(await readHtmlFile(file)).toEqual(bytes);
  });

  it("throws 'file not found: <path>' with code ENOENT for a missing path", async () => {
    const missing = path.join(dir, "definitely-missing.html");
    const err = await rejectionOf(readHtmlFile(missing));
    expect(err.message).toMatch(/^file not found: .*definitely-missing\.html$/);
    expect(err.code).toBe("ENOENT");
  });

  it("throws 'is a directory, not a file: <path>' when the path is a directory", async () => {
    const err = await rejectionOf(readHtmlFile(dir));
    expect(err.message).toMatch(/^is a directory, not a file: /);
    expect(err.code).toBe("EISDIR");
  });

  it("throws 'empty file: <path>' for a zero-byte file", async () => {
    const file = path.join(dir, "empty.html");
    fs.writeFileSync(file, "");
    await expect(readHtmlFile(file)).rejects.toThrow(`empty file: ${file}`);
  });

  // Root bypasses mode bits and Windows lacks POSIX modes (the CLI only
  // targets macOS/Linux; the guard is belt-and-braces).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws 'permission denied reading file: <path>' for a chmod-000 file",
    async () => {
      const file = path.join(dir, "locked.html");
      fs.writeFileSync(file, "<p>secret</p>");
      fs.chmodSync(file, 0o000);
      await expect(readHtmlFile(file)).rejects.toThrow(
        /^permission denied reading file: /,
      );
    },
  );
});

// The deterministic cross-platform contract: every mapped code produces the
// friendly message via an injected readFileImpl, so no test depends on the
// host OS actually producing that errno.
describe("readHtmlFile — error-code mapping (table-driven)", () => {
  const throwing = (code) => async () => {
    throw Object.assign(new Error("raw node message"), { code });
  };

  const ROWS = [
    ["ENOENT", "file not found"],
    ["ENOTDIR", "file not found"],
    ["EISDIR", "is a directory, not a file"],
    ["EACCES", "permission denied reading file"],
    ["EPERM", "permission denied reading file"],
  ];

  for (const [code, friendly] of ROWS) {
    it(`maps ${code} to a friendly message, preserving code and cause`, async () => {
      const err = await rejectionOf(readHtmlFile("talk.html", throwing(code)));
      expect(err.message).toBe(`${friendly}: talk.html`);
      expect(err.code).toBe(code);
      expect(err.cause).toMatchObject({ message: "raw node message" });
    });
  }

  it("rethrows the original error for an unmapped code (e.g. EMFILE)", async () => {
    const original = Object.assign(new Error("raw node message"), {
      code: "EMFILE",
    });
    await expect(
      readHtmlFile("talk.html", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("rethrows a code-less error untouched", async () => {
    const original = new Error("boom");
    await expect(
      readHtmlFile("talk.html", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});

// Locks the main() wiring: the helper-only tests above would stay green if
// main() still called fsp.readFile directly. Hermetic — main() reads the
// file before uploadPage, so the (valid but unreachable) endpoint is never
// contacted.
describe("CLI file-read errors (integration)", () => {
  it("prints the friendly message, not the raw Node error, for a missing file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wwwshare-test-"));
    const missing = path.join(dir, "definitely-missing.html");
    try {
      const { code, stderr } = await runCli([missing, "some-slug"], {
        WWWSHARE_ENDPOINT: "http://127.0.0.1:1",
        WWWSHARE_UPLOAD_TOKEN: "test-token",
      });
      expect(code).toBe(1);
      expect(stderr).toMatch(/✗ file not found: .*definitely-missing\.html/);
      expect(stderr).not.toMatch(/no such file or directory/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("browserOpener", () => {
  it("maps darwin to open", () => {
    expect(browserOpener("darwin")).toEqual({ cmd: "open", args: [] });
  });

  it("maps linux to xdg-open", () => {
    expect(browserOpener("linux")).toEqual({ cmd: "xdg-open", args: [] });
  });

  it("falls through to xdg-open on unsupported platforms", () => {
    expect(browserOpener("win32")).toEqual({ cmd: "xdg-open", args: [] });
  });
});

describe("openInBrowser", () => {
  it("resolves false (without throwing) when the launcher is missing", async () => {
    const result = await openInBrowser("https://x.example/p/foo", {
      cmd: "definitely-no-such-binary-xyz",
      args: [],
    });
    expect(result).toBe(false);
  });
});
