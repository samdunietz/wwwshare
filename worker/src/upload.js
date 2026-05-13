import { jsonResponse, TEXT_HTML } from "./http.js";
import { checkAuth } from "./auth.js";
import { SLUG_RE } from "./slug.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// POST /upload — single-file HTML publish. Auth-gated; the bearer-token
// holder can publish arbitrary same-origin JavaScript at this Worker's
// origin. That's by design — wwwshare is for hand-authored HTML with
// inline script/style — but it's a meaningful trust grant. Keep this
// origin separate from any cookie-authenticated surface.
export async function handleUpload(request, env) {
  if (!(await checkAuth(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return jsonResponse({ error: "unsupported media type" }, 415);
  }

  const declaredLen = parseContentLength(request.headers.get("Content-Length"));
  if (declaredLen !== null && declaredLen > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: "payload too large" }, 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "invalid multipart" }, 400);
  }

  // Fallback size cap: catch missing Content-Length or padded part headers
  // by summing every parsed entry's bytes.
  let totalBytes = 0;
  for (const [, value] of form.entries()) {
    if (value && typeof value.size === "number") {
      totalBytes += value.size;
    } else if (typeof value === "string") {
      totalBytes += byteLength(value);
    }
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: "payload too large" }, 413);
  }

  // Count first, then type — so `html=<File> + html=<string>` reports as
  // `duplicate html`, not as a type error on the first entry.
  const slugFields = form.getAll("slug");
  if (slugFields.length === 0) {
    return jsonResponse({ error: "missing slug" }, 400);
  }
  if (slugFields.length > 1) {
    return jsonResponse({ error: "duplicate slug" }, 400);
  }
  if (typeof slugFields[0] !== "string") {
    return jsonResponse({ error: "invalid slug" }, 400);
  }
  const slug = slugFields[0];
  if (!SLUG_RE.test(slug)) {
    return jsonResponse({ error: "invalid slug" }, 400);
  }

  const htmlFields = form.getAll("html");
  if (htmlFields.length === 0) {
    return jsonResponse({ error: "missing html" }, 400);
  }
  if (htmlFields.length > 1) {
    return jsonResponse({ error: "duplicate html" }, 400);
  }
  const htmlPart = htmlFields[0];
  if (!isFilePart(htmlPart)) {
    return jsonResponse({ error: "html part must be a file" }, 400);
  }
  if (htmlPart.size === 0) {
    return jsonResponse({ error: "empty html" }, 400);
  }

  const updateFields = form.getAll("update");
  if (updateFields.length > 1) {
    return jsonResponse({ error: "duplicate update" }, 400);
  }
  // Strict: only the literal "1" means update. Anything else ("0", "true",
  // "", non-string) is treated as create. Keeps `update=2` from silently
  // overwriting.
  const isUpdate = updateFields.length === 1 && updateFields[0] === "1";

  const key = `${slug}/index.html`;
  const existing = await env.WWWSHARE_BUCKET.head(key);
  if (isUpdate && !existing) {
    return jsonResponse({ error: `no page at slug ${slug}` }, 404);
  }
  if (!isUpdate && existing) {
    return jsonResponse({ error: "slug exists" }, 409);
  }

  // HEAD-then-PUT is NOT atomic across concurrent writers — two creates
  // for the same slug can both pass the HEAD and last-write-wins.
  // Acceptable for single-user CLI; documented, not solved.
  await env.WWWSHARE_BUCKET.put(key, await htmlPart.arrayBuffer(), {
    httpMetadata: { contentType: TEXT_HTML },
  });

  const url = `${new URL(request.url).origin}/p/${slug}`;
  return jsonResponse({ url, slug }, isUpdate ? 200 : 201);
}

function parseContentLength(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

const encoder = new TextEncoder();
function byteLength(str) {
  return encoder.encode(str).length;
}

function isFilePart(part) {
  return Boolean(
    part &&
      typeof part === "object" &&
      typeof part.size === "number" &&
      typeof part.stream === "function" &&
      typeof part.text === "function",
  );
}
