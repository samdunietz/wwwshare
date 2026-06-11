// Pure helpers for the CLI config at $XDG_CONFIG_HOME/wwwshare/.env.
// No node: imports — keeps this loadable from the workers-pool tests.
// The CLI loads this file via dotenv, which accepts `export KEY = value`
// spacing forms and resolves duplicate keys last-wins — so matching must be
// tolerant and replacement must hit EVERY line for a key, or a later stale
// line would win over the rewritten one.
// [^\S\n] instead of \s: with the m flag, \s crosses newlines, which would
// let an empty endpoint value match the next line's first char and let the
// line match swallow preceding blank lines.

const ENDPOINT_RE =
  /^[^\S\n]*(?:export[^\S\n]+)?WWWSHARE_ENDPOINT[^\S\n]*=[^\S\n]*\S/m;
const ENDPOINT_LINE_RE =
  /^([^\S\n]*(?:export[^\S\n]+)?)WWWSHARE_ENDPOINT[^\S\n]*=.*$/gm;
const TOKEN_LINE_RE =
  /^([^\S\n]*(?:export[^\S\n]+)?)WWWSHARE_UPLOAD_TOKEN[^\S\n]*=.*$/gm;

export function hasEndpoint(content) {
  return ENDPOINT_RE.test(content);
}

// Replaces every line for the key in place (appends if absent), keeping any
// `export ` prefix — the file is shell-sourceable — and leaving all other
// lines byte-for-byte intact.
function withLine(content, lineRe, line) {
  let found = false;
  const replaced = content.replace(lineRe, (_, prefix) => {
    found = true;
    return prefix + line;
  });
  if (found) return replaced;
  if (!content) return line + "\n";
  return content.replace(/\n*$/, "\n") + line + "\n";
}

export function withEndpoint(content, endpoint) {
  return withLine(content, ENDPOINT_LINE_RE, `WWWSHARE_ENDPOINT=${endpoint}`);
}

export function withNewToken(content, token) {
  return withLine(content, TOKEN_LINE_RE, `WWWSHARE_UPLOAD_TOKEN=${token}`);
}
