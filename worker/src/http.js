const TEXT_PLAIN = "text/plain; charset=utf-8";
export const TEXT_HTML = "text/html; charset=utf-8";
export const APPLICATION_JSON = "application/json";

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": APPLICATION_JSON },
  });
}

export function notFound() {
  return new Response("not found", {
    status: 404,
    headers: { "Content-Type": TEXT_PLAIN },
  });
}

export function methodNotAllowed(allowed) {
  return new Response("method not allowed", {
    status: 405,
    headers: {
      "Content-Type": TEXT_PLAIN,
      Allow: allowed.join(", "),
    },
  });
}
