// Page slugs: lowercase alnum + dash, 1–64 chars, no leading or trailing
// dash. Internal consecutive dashes (`a--b`) are intentionally allowed —
// if you want to disallow them, this is the spot.
//
// SLUG_PATTERN is the single source of truth: index.js builds the /p/
// route regex from it, and cli/src/wwwshare.mjs re-declares the same
// string with a cross-ref comment. Slug-parity tests in
// worker/test/upload.test.js lock the contract across all three sites.
export const SLUG_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
export const SLUG_RE = new RegExp(`^${SLUG_PATTERN}$`);
