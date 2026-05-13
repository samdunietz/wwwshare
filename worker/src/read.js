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
  "Cache-Control": "public, max-age=3600",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": TEXT_HTML,
};

function pageHeaders(trusted) {
  return {
    ...BASE_PAGE_HEADERS,
    "Content-Security-Policy": trusted ? TRUSTED_PAGE_CSP : SANDBOXED_PAGE_CSP,
  };
}

const PAGE_KEY = (slug) => `${slug}/index.html`;

function isTrusted(obj) {
  return obj?.customMetadata?.trusted === "1";
}

export async function handleRead(slug, request, env) {
  const key = PAGE_KEY(slug);
  // Explicit HEAD/GET branches — don't rely on the runtime to strip a
  // body from a HEAD response, since miniflare/cloudflare:test may
  // differ from the production edge.
  if (request.method === "HEAD") {
    const head = await env.WWWSHARE_BUCKET.head(key);
    if (!head) return notFound();
    return new Response(null, { headers: pageHeaders(isTrusted(head)) });
  }
  const obj = await env.WWWSHARE_BUCKET.get(key);
  if (!obj) return notFound();
  return new Response(obj.body, { headers: pageHeaders(isTrusted(obj)) });
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
