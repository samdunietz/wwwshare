import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearBucket } from "./helpers.js";

const TOKEN = "devtoken";
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = "http://example.com";

async function seedPage(key, bytes = "<p>x</p>") {
  await env.WWWSHARE_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
}

describe("/list — auth", () => {
  beforeEach(() => clearBucket(env));

  it("returns 401 with no Authorization header", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/list`);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 401 with wrong bearer token", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });
});

describe("/list — happy path", () => {
  beforeEach(() => clearBucket(env));

  it("returns {slugs: []} on empty bucket", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ slugs: [] });
  });

  it("returns slugs sorted ascending regardless of insertion order", async () => {
    await seedPage("c/index.html");
    await seedPage("a/index.html");
    await seedPage("b/index.html");
    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slugs: ["a", "b", "c"] });
  });
});

describe("/list — stray-key filter", () => {
  beforeEach(() => clearBucket(env));

  // The bucket should only ever contain {slug}/index.html objects after
  // upload-side validation, but a manual edit or future code could create
  // a stray key. The handler must reject anything that doesn't satisfy
  // SLUG_RE on the prefix and "/index.html" as the suffix.
  it("returns only the keys matching {slug}/index.html with SLUG_RE-valid prefix", async () => {
    await seedPage("foo/index.html"); // valid
    await seedPage("random-key"); // no slash
    await seedPage("foo/other.html"); // wrong suffix
    await seedPage("Bad/index.html"); // uppercase fails SLUG_RE
    await seedPage("abc/def/index.html"); // multi-level path; "abc/def" fails SLUG_RE
    await seedPage("abc-/index.html"); // trailing dash fails SLUG_RE

    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slugs: ["foo"] });
  });
});

describe("/list — pagination", () => {
  beforeEach(() => clearBucket(env));
  // Restore unconditionally so a failed assertion in the spy test can't
  // leak the mock onto env.WWWSHARE_BUCKET for any subsequent test.
  afterEach(() => vi.restoreAllMocks());

  // The handler must follow the cursor when R2 marks the response
  // truncated. Stubbing `env.WWWSHARE_BUCKET.list` is faster (and more
  // deterministic) than seeding >1000 objects to hit the real cap.
  it("follows the cursor across multiple R2 pages", async () => {
    const spy = vi.spyOn(env.WWWSHARE_BUCKET, "list");
    spy.mockImplementationOnce(async () => ({
      objects: [{ key: "alpha/index.html" }, { key: "beta/index.html" }],
      truncated: true,
      cursor: "cursor-1",
    }));
    spy.mockImplementationOnce(async () => ({
      objects: [{ key: "gamma/index.html" }, { key: "delta/index.html" }],
      truncated: false,
    }));

    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slugs: ["alpha", "beta", "delta", "gamma"],
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]?.cursor).toBeUndefined();
    expect(spy.mock.calls[1][0]?.cursor).toBe("cursor-1");
  });
});

describe("/list — method handling", () => {
  it("405 with Allow: GET on POST", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      method: "POST",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("405 with Allow: GET on DELETE", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/list`, {
      method: "DELETE",
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});
