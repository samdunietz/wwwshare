#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// SLUG_PATTERN must match worker/src/slug.js — they're the single
// contract for slug shape. The slug-parity tests in
// worker/test/upload.test.js and this package's tests lock the
// behavior. If you change one, change the other.
const SLUG_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const SLUG_RE = new RegExp(`^${SLUG_PATTERN}$`);

const USAGE =
  "usage:\n" +
  "  wwwshare <html-file> <slug>            publish a new page\n" +
  "  wwwshare update <slug> <html-file>     overwrite an existing page\n" +
  "  wwwshare remove <slug>                 delete a page\n" +
  "\n" +
  "Flags (create / update):\n" +
  "  --trust    skip the default CSP sandbox; grant the page same-origin\n" +
  "             powers (localStorage, cookies, same-origin fetch).\n" +
  "             Use only for HTML you wrote or audited.";

export function parseArgs(argv) {
  // Reject unknown --flags so a typo like `--trsut` fails loudly instead
  // of falling through to positional parsing as a wrong-arity error.
  let trust = false;
  const args = [];
  for (const arg of argv.slice(2)) {
    if (arg === "--trust") {
      trust = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}\n\n${USAGE}`);
    } else {
      args.push(arg);
    }
  }
  const verb = args[0];

  if (verb === "update") {
    if (args.length !== 3) throw new Error(USAGE);
    const slug = args[1];
    const file = args[2];
    requireSlug(slug);
    return { action: "update", slug, file, trust };
  }

  if (verb === "remove") {
    if (args.length !== 2) throw new Error(USAGE);
    if (trust) {
      throw new Error(`--trust is not valid with remove\n\n${USAGE}`);
    }
    const slug = args[1];
    requireSlug(slug);
    return { action: "remove", slug };
  }

  if (args.length !== 2) throw new Error(USAGE);
  const [file, slug] = args;
  requireSlug(slug);
  return { action: "create", slug, file, trust };
}

function requireSlug(slug) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug format: ${JSON.stringify(slug)} — must be 1–64 chars [a-z0-9-], no leading/trailing dash`,
    );
  }
}

export async function uploadPage({
  endpoint,
  token,
  html,
  slug,
  update,
  trust,
  fetchImpl = globalThis.fetch,
}) {
  if (!endpoint) throw new Error("uploadPage: endpoint is required");
  if (!token) throw new Error("uploadPage: token is required");
  if (!(html instanceof Uint8Array) && !Buffer.isBuffer(html)) {
    throw new TypeError("uploadPage: html must be a Buffer/Uint8Array");
  }
  if (typeof slug !== "string") {
    throw new TypeError("uploadPage: slug must be a string");
  }

  const form = new FormData();
  form.append("slug", slug);
  // Blob type is set for politeness — the server ignores it and forces
  // text/html; charset=utf-8 on the stored object.
  form.append("html", new Blob([html], { type: "text/html" }), "page.html");
  if (update) form.append("update", "1");
  if (trust) form.append("trusted", "1");

  const url = new URL("/upload", endpoint).toString();
  // No Content-Type — fetch derives the multipart boundary from FormData.
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!response.ok) {
    throw await buildHttpError(response, "Upload failed");
  }

  const body = await response.json();
  return { url: body.url, slug: body.slug };
}

export async function deletePage({
  endpoint,
  token,
  slug,
  fetchImpl = globalThis.fetch,
}) {
  if (!endpoint) throw new Error("deletePage: endpoint is required");
  if (!token) throw new Error("deletePage: token is required");
  if (typeof slug !== "string") {
    throw new TypeError("deletePage: slug must be a string");
  }

  const url = new URL(`/p/${slug}`, endpoint).toString();
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 204) return { url };
  if (response.status === 404) {
    const err = new Error(`Remove failed: no page at slug ${slug}`);
    err.status = 404;
    throw err;
  }
  throw await buildHttpError(response, "Remove failed");
}

async function buildHttpError(response, prefix) {
  const bodyText = await response.text().catch(() => "");
  let parsed = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
  }
  const detail = parsed?.error ?? bodyText ?? "";
  const err = new Error(
    `${prefix}: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
  );
  err.status = response.status;
  err.body = parsed ?? bodyText;
  return err;
}

// Clipboard is best-effort: pbcopy on macOS, then wl-copy (Wayland),
// then xclip (X11). spawn + stdin pipe handles arbitrary content without
// escaping concerns.
const CLIPBOARD_COMMANDS = [
  { cmd: "pbcopy", args: [] },
  { cmd: "wl-copy", args: [] },
  { cmd: "xclip", args: ["-selection", "clipboard"] },
];

function tryClipboardCommand(text, cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

export async function copyToClipboard(text, commands = CLIPBOARD_COMMANDS) {
  for (const { cmd, args } of commands) {
    if (await tryClipboardCommand(text, cmd, args)) return true;
  }
  return false;
}

// Config lookup order (first hit wins per var; shell env always wins over
// both, via dotenv's "don't override existing" default):
//
//   1. cli/.env (next to script)  — for hacking on the repo
//   2. $XDG_CONFIG_HOME/wwwshare/.env (default: ~/.config/wwwshare/.env)
//                                  — for the symlinked-into-PATH install
//
// Exported for tests.
export function loadEnv() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  dotenv.config({ path: path.resolve(scriptDir, "../.env"), quiet: true });
  dotenv.config({
    path: path.join(xdgConfigHome, "wwwshare", ".env"),
    quiet: true,
  });
}

async function main() {
  loadEnv();
  const parsed = parseArgs(process.argv);

  const token = process.env.WWWSHARE_UPLOAD_TOKEN;
  if (!token) {
    throw new Error(
      "WWWSHARE_UPLOAD_TOKEN is not set (copy cli/.env.example to cli/.env or export it in your shell)",
    );
  }
  const endpoint = process.env.WWWSHARE_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "WWWSHARE_ENDPOINT is not set (e.g. https://wwwshare.example.com)",
    );
  }

  if (parsed.action === "remove") {
    const { url } = await deletePage({ endpoint, token, slug: parsed.slug });
    process.stdout.write(`✓ Removed "${parsed.slug}"\n  ${url}\n`);
    return;
  }

  // Read bytes, not utf-8 text — preserves the file's exact bytes on the
  // wire. The server stores them verbatim and serves with charset=utf-8.
  // (Use UTF-8-encoded HTML; non-UTF-8 will render with the wrong charset
  // declaration.)
  const html = await fsp.readFile(parsed.file);
  if (html.length === 0) {
    throw new Error(`empty file: ${parsed.file}`);
  }

  const { url, slug } = await uploadPage({
    endpoint,
    token,
    html,
    slug: parsed.slug,
    update: parsed.action === "update",
    trust: parsed.trust,
  });

  // Sanity check: catch a server that silently ignores the slug field.
  if (slug !== parsed.slug) {
    throw new Error(
      `server returned slug ${slug} instead of ${parsed.slug} — ` +
        `check WWWSHARE_ENDPOINT and worker version`,
    );
  }

  const copied = await copyToClipboard(url);
  const verb = parsed.action === "update" ? "Updated" : "Published";
  const trustNote = parsed.trust ? " (trusted, no sandbox)" : "";
  process.stdout.write(
    `✓ ${verb} "${parsed.slug}"${trustNote}\n  ${url}\n` +
      (copied ? "  (copied to clipboard)\n" : ""),
  );
}

// Guard so tests can import the helpers without main() running.
function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main().catch((err) => {
    process.stderr.write(`✗ ${err.message}\n`);
    if (err.status === 401) {
      process.stderr.write("  Check WWWSHARE_UPLOAD_TOKEN\n");
    }
    process.exit(1);
  });
}
