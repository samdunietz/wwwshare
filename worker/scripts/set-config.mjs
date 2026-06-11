#!/usr/bin/env node
// Writes the CLI config: the endpoint always, the token when given. An
// endpoint-only run preserves any existing token line, so the deploy block
// can seed the endpoint and leave minting the token to rotate-token.
import fs from "node:fs";
import path from "node:path";
import { cliConfigPath } from "./cli-config.mjs";
import { withEndpoint, withNewToken } from "./env-file.mjs";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const [endpoint, token, ...extra] = process.argv.slice(2);
if (!endpoint || extra.length > 0) {
  fail("Usage: npm run set-config -- <endpoint> [token]");
}

// Same rules as the CLI's requireEndpoint(), so a bad value fails here
// instead of on the first publish.
let parsed = null;
try {
  parsed = new URL(endpoint);
} catch {}
if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
  fail(
    `<endpoint> must be an http(s) URL like "https://wwwshare.example.com" — got ${JSON.stringify(endpoint)}`,
  );
}
if (parsed.username || parsed.password) {
  fail(`<endpoint> must not embed credentials — got ${JSON.stringify(endpoint)}`);
}

const envPath = cliConfigPath();
let content = "";
let exists = true;
try {
  content = fs.readFileSync(envPath, "utf8");
} catch (err) {
  if (err?.code !== "ENOENT") fail(`Cannot read ${envPath}: ${err.message}`);
  exists = false;
}

let next = withEndpoint(content, endpoint);
if (token) next = withNewToken(next, token);

fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
// chmod BEFORE writing: writeFileSync ignores `mode` on existing files, and
// the file may hold a secret after this write. Non-fatal, same posture as
// rotate-token.
if (exists) {
  try {
    fs.chmodSync(envPath, 0o600);
  } catch (err) {
    console.error(`⚠ Could not chmod ${envPath} to 0600 (${err.message}).`);
  }
}
fs.writeFileSync(envPath, next, { mode: 0o600 });

console.log(`✓ CLI config at ${envPath} (mode 0600)`);
