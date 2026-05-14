import { handleUpload } from "./upload.js";
import { handleRead, handleDelete } from "./read.js";
import { handleList } from "./list.js";
import { SLUG_PATTERN } from "./slug.js";
import { methodNotAllowed, notFound, TEXT_HTML } from "./http.js";

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>wwwshare</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>wwwshare</h1>
<p>wwwshare publishes single-file HTML documents at short unlisted URLs.</p>
</body>
</html>
`;

// Built once at module load from the shared SLUG_PATTERN so route matching
// and slug validation can't drift.
const PAGE_ROUTE_RE = new RegExp(`^/p/(${SLUG_PATTERN})$`);
const READ_METHODS = ["GET", "HEAD"];
const UPLOAD_METHODS = ["POST"];
const LIST_METHODS = ["GET"];
const PAGE_METHODS = ["GET", "HEAD", "DELETE"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/") {
      if (!READ_METHODS.includes(method)) return methodNotAllowed(READ_METHODS);
      return new Response(LANDING_HTML, {
        status: 200,
        headers: { "Content-Type": TEXT_HTML },
      });
    }

    if (path === "/upload") {
      if (!UPLOAD_METHODS.includes(method))
        return methodNotAllowed(UPLOAD_METHODS);
      return handleUpload(request, env);
    }

    if (path === "/list") {
      if (!LIST_METHODS.includes(method)) return methodNotAllowed(LIST_METHODS);
      return handleList(request, env);
    }

    // Malformed /p/ paths (e.g. /p/Bad-Slug) miss the regex and fall
    // through to the global 404. 405 only fires for method-mismatches on
    // well-shaped slugs.
    const pageMatch = path.match(PAGE_ROUTE_RE);
    if (pageMatch) {
      const slug = pageMatch[1];
      if (method === "GET" || method === "HEAD") {
        return handleRead(slug, request, env);
      }
      if (method === "DELETE") {
        return handleDelete(slug, request, env);
      }
      return methodNotAllowed(PAGE_METHODS);
    }

    return notFound();
  },
};
