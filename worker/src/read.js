import { jsonResponse, notFound, TEXT_HTML } from "./http.js";
import { checkAuth } from "./auth.js";

// CSPs for /p/{slug}, picked per-object by `customMetadata.trusted`.
// Sandboxed pages run in an opaque origin (no localStorage / cookies /
// same-origin fetch). `allow-popups-to-escape-sandbox` prevents
// target=_blank links from inheriting the sandbox onto their destination.
const TRUSTED_PAGE_CSP =
  "default-src 'self'; img-src 'self' data: blob:; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "object-src 'none'; base-uri 'self'; form-action 'none'";

const SANDBOX_DIRECTIVE =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox " +
  "allow-modals allow-top-navigation-by-user-activation";

const SANDBOXED_PAGE_CSP = `${TRUSTED_PAGE_CSP}; ${SANDBOX_DIRECTIVE}`;

const BASE_PAGE_HEADERS = {
  // no-cache = store but revalidate on every use. The CSP is a security
  // control and must never be served stale (a trust demotion has to take
  // effect immediately); revalidation costs one cheap 304 round-trip.
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": TEXT_HTML,
};

function pageHeaders(trusted, etag) {
  return {
    ...BASE_PAGE_HEADERS,
    ETag: etag,
    "Content-Security-Policy": trusted ? TRUSTED_PAGE_CSP : SANDBOXED_PAGE_CSP,
  };
}

const PAGE_KEY = (slug) => `${slug}/index.html`;

function isTrusted(obj) {
  return obj?.customMetadata?.trusted === "1";
}

// R2's etag identifies only the body bytes (treat it as opaque). The CSP
// is chosen by customMetadata.trusted, so a trust flip with unchanged
// bytes MUST change the served ETag — otherwise a conditional GET would
// 304 and the browser would keep the stale (possibly permissive) CSP.
function pageEtag(obj) {
  return `"${obj.etag}-${isTrusted(obj) ? "t" : "s"}"`;
}

// Weak comparison (RFC 9110 13.1.2): strip W/ prefix, compare opaque
// tags. Comma-split parsing is safe here: etags we mint contain no
// commas, and a foreign tag that fails to parse simply won't match —
// yielding a full 200, the safe direction.
function ifNoneMatchMatches(headerValue, etag) {
  if (!headerValue) return false;
  if (headerValue.trim() === "*") return true;
  return headerValue
    .split(",")
    .some((t) => t.trim().replace(/^W\//, "") === etag);
}

export async function handleRead(slug, request, env) {
  const key = PAGE_KEY(slug);
  const ifNoneMatch = request.headers.get("If-None-Match");
  // Existence is checked before If-None-Match so `If-None-Match: *` on a
  // deleted slug returns 404, not 304.
  //
  // Explicit HEAD/GET branches — don't rely on the runtime to strip a
  // body from a HEAD response, since miniflare/cloudflare:test may
  // differ from the production edge.
  if (request.method === "HEAD") {
    const head = await env.WWWSHARE_BUCKET.head(key);
    if (!head) return notFound();
    const etag = pageEtag(head);
    const headers = pageHeaders(isTrusted(head), etag);
    const status = ifNoneMatchMatches(ifNoneMatch, etag) ? 304 : 200;
    return new Response(null, { status, headers });
  }
  const obj = await env.WWWSHARE_BUCKET.get(key);
  if (!obj) return notFound();
  const etag = pageEtag(obj);
  // 304 carries the full header set (ETag, Cache-Control, CSP, ...):
  // RFC 9111 4.3.4 makes caches update stored headers from a 304, so
  // even this path refreshes the CSP — belt-and-suspenders, since a
  // trust flip never 304s (the etag changes).
  const headers = pageHeaders(isTrusted(obj), etag);
  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    // cancel() is async — await it so the R2 stream is released before
    // teardown (the runtime also requires a null body on a 304).
    await obj.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
}

export async function handleDelete(slug, request, env) {
  // Auth FIRST, before any R2 lookup — an unauth'd caller can't probe
  // slug existence by timing the response.
  if (!(await checkAuth(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const key = PAGE_KEY(slug);
  const head = await env.WWWSHARE_BUCKET.head(key);
  if (!head) return notFound();
  // HEAD→delete is racy with a concurrent update. Same write-side
  // limitation as create/update — acceptable for single-user CLI.
  await env.WWWSHARE_BUCKET.delete(key);
  return new Response(null, { status: 204 });
}
