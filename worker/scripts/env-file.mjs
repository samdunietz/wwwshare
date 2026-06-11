// Pure helpers for the CLI config at $XDG_CONFIG_HOME/wwwshare/.env.
// No node: imports — keeps this loadable from the workers-pool tests.
// The CLI loads this file via dotenv, which accepts `export KEY = value`
// spacing forms and resolves duplicate keys last-wins — so matching must be
// tolerant and replacement must hit EVERY token line, or a later stale line
// would win over the rotated one.
// [^\S\n] instead of \s: with the m flag, \s crosses newlines, which would
// let an empty endpoint value match the next line's first char and let the
// token match swallow preceding blank lines.

const ENDPOINT_RE =
  /^[^\S\n]*(?:export[^\S\n]+)?WWWSHARE_ENDPOINT[^\S\n]*=[^\S\n]*\S/m;
const TOKEN_RE = /^([^\S\n]*(?:export[^\S\n]+)?)WWWSHARE_UPLOAD_TOKEN[^\S\n]*=.*$/gm;

export function hasEndpoint(content) {
  return ENDPOINT_RE.test(content);
}

// Replaces every WWWSHARE_UPLOAD_TOKEN line in place (appends if absent),
// keeping any `export ` prefix — the file is shell-sourceable — and leaving
// all other lines — endpoint included — byte-for-byte intact.
export function withNewToken(content, token) {
  const line = `WWWSHARE_UPLOAD_TOKEN=${token}`;
  // .match, not .test: /g/ regexes are stateful via lastIndex under .test.
  if (content.match(TOKEN_RE)) {
    return content.replace(TOKEN_RE, (_, prefix) => prefix + line);
  }
  return content.replace(/\n*$/, "\n") + line + "\n";
}
