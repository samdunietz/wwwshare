import { jsonResponse } from "./http.js";
import { checkAuth } from "./auth.js";
import { SLUG_RE } from "./slug.js";

const PAGE_KEY_SUFFIX = "/index.html";

// Defensive filter: keys that don't match the {slug}/index.html shape
// (manual bucket edits, future code) get dropped instead of leaking into
// the listing. SLUG_RE is the same regex upload.js validates against, so
// the filter and the writer cannot disagree on what counts as a page.
function slugFromKey(key) {
  if (!key.endsWith(PAGE_KEY_SUFFIX)) return null;
  const slug = key.slice(0, -PAGE_KEY_SUFFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

export async function handleList(request, env) {
  // Auth FIRST — same posture as handleDelete; an unauth'd caller can't
  // probe how many pages exist via response timing.
  if (!(await checkAuth(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const slugs = [];
  let cursor;
  do {
    const page = await env.WWWSHARE_BUCKET.list({ cursor });
    for (const obj of page.objects) {
      const slug = slugFromKey(obj.key);
      if (slug) slugs.push(slug);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  slugs.sort();
  return jsonResponse({ slugs }, 200);
}
