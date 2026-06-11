#!/usr/bin/env node
// Rotates the upload token: sets the Worker secret first, and only on
// success rewrites the local CLI config, so a failed wrangler call (e.g.
// not logged in) leaves the old token usable everywhere.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cliConfigPath } from "./cli-config.mjs";
import { hasEndpoint, withNewToken } from "./env-file.mjs";

const workerDir = fileURLToPath(new URL("..", import.meta.url));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const envPath = cliConfigPath();

const SEE_DEPLOY = `Rotation needs an existing deployment — see "Deploying to Cloudflare" in README.md.`;

let content;
try {
  content = fs.readFileSync(envPath, "utf8");
} catch (err) {
  if (err?.code === "ENOENT") fail(`No CLI config at ${envPath}. ${SEE_DEPLOY}`);
  fail(`Cannot read CLI config: ${err.message}`); // message names code and path
}
if (!hasEndpoint(content)) {
  fail(`${envPath} has no WWWSHARE_ENDPOINT. ${SEE_DEPLOY}`);
}

// Preflight writability BEFORE rotating the remote secret, so a read-only
// config can't strand the deploy on a token the local file doesn't have.
try {
  fs.accessSync(envPath, fs.constants.W_OK);
} catch {
  fail(`${envPath} is not writable — fix permissions before rotating.`);
}

const token = randomBytes(32).toString("base64url");

// node_modules/.bin is on PATH because this runs via the workspace npm
// script; cwd is the worker dir so --config resolves from anywhere.
const result = spawnSync(
  "wrangler",
  ["secret", "put", "WWWSHARE_UPLOAD_TOKEN", "--config", "wrangler.prod.toml"],
  { cwd: workerDir, input: token, stdio: ["pipe", "inherit", "inherit"] },
);
if (result.error) {
  fail(
    `Could not run wrangler (${result.error.message}) — use \`npm run rotate-token\`. Local config untouched.`,
  );
}
if (result.status !== 0) {
  fail("wrangler secret put failed — local config untouched, the old token still works.");
}

// chmod BEFORE writing the new token: the file exists (read above), and
// writeFileSync ignores `mode` on existing files. Keeps the README's
// umask-077 posture (0600) with no wider-mode window for the new token.
// Non-fatal: chmod needs ownership (not W_OK), so a group-writable file
// owned by someone else would throw here yet still accept the write below.
try {
  fs.chmodSync(envPath, 0o600);
} catch (err) {
  console.error(`⚠ Could not chmod ${envPath} to 0600 (${err.message}).`);
}
try {
  fs.writeFileSync(envPath, withNewToken(content, token), { mode: 0o600 });
} catch (err) {
  fail(
    `The Worker secret WAS rotated, but writing ${envPath} failed (${err.message}). ` +
      `Save this token now and update the file by hand: ${token}`,
  );
}

console.log(
  `✓ New token: ${token} — copy to any other machines using this deploy.`,
);
