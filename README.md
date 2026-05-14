# wwwshare

Publish a single, self-contained HTML file to a short URL, hosted on Cloudflare.

```sh
wwwshare ./talk.html my-talk
# ✓ Published "my-talk"
#   https://wwwshare.yourname.workers.dev/p/my-talk
```

That's it. 

By default the page is loaded in a CSP `sandbox` so its scripts run but can't touch cookies or localStorage on the wwwshare origin; pass `--trust` to opt out.

## Why

There are plenty of ways to host a static page, but `wwwshare` accepts one file, gives you a short URL, and gets out of the way.

It pairs naturally with tooling that produces single-file HTML — design mockups, generated reports, slides, one-off explainers.

## Layout

This is a Cloudflare Workers app with two npm workspaces:

- `worker/` — the Cloudflare Worker (HTTP + R2). No bundler.
- `cli/` — the `wwwshare` Node CLI that uploads via `POST /upload`.

The Worker has four endpoints:

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `POST` | `/upload` | Bearer | Multipart upload (`slug`, `html`, optional `update=1`, optional `trusted=1`). 201 create / 200 update / 409 conflict / 404 missing-for-update. |
| `GET` / `HEAD` | `/p/{slug}` | none | Serve the page with the `wwwshare` CSP. |
| `DELETE` | `/p/{slug}` | Bearer | Remove the page. 204 on success, 404 if missing. |
| `GET` | `/` | none | Tiny landing page. |

Slugs match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (1–64 chars, lowercase + digits + dash, no leading/trailing dash).

## Install and local development

This script is intended for macOS and Linux.

Intall `npm` and `node` if not already. Then:

```sh
git clone https://github.com/samdunietz/wwwshare.git
cd wwwshare
npm install
echo "WWWSHARE_UPLOAD_TOKEN=devtoken" > worker/.dev.vars
cp cli/.env.example cli/.env
```

Both `worker/.dev.vars` and `cli/.env` are gitignored. `cli/.env.example` already points at `http://localhost:8787` with `token=devtoken`, matching `worker/.dev.vars`.

```sh
npm test
npm run dev
```

In another shell:

```sh
node cli/src/wwwshare.mjs ./some-file.html my-slug
```

## Deploying to Cloudflare

Prerequisites: a Cloudflare account with Workers + R2 enabled, and `npx wrangler login` already run.

The prod setup creates the bucket, deploys the Worker, generates a 256-bit random token, and sets it both as a Worker secret and in your local CLI config.

```sh
cd worker

# Create the prod R2 bucket. Edit wrangler.prod.toml if you want a
# different bucket name.
npx wrangler r2 bucket create wwwshare-content

# Deploy. Captures the workers.dev URL for the CLI config below.
# Safe to deploy before setting the secret: src/auth.js fails closed
# while WWWSHARE_UPLOAD_TOKEN is unset, so the Worker 401s on every
# upload until the secret is in place.
DEPLOY_OUT=$(npx wrangler deploy --config wrangler.prod.toml 2>&1 | tee /dev/tty)
DEPLOY_URL=$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

# Generate token, set as Worker secret, write local CLI config.
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
printf '%s' "$TOKEN" | npx wrangler secret put WWWSHARE_UPLOAD_TOKEN --config wrangler.prod.toml

mkdir -p ~/.config/wwwshare
( umask 077 && cat > ~/.config/wwwshare/.env <<EOF
WWWSHARE_ENDPOINT=$DEPLOY_URL
WWWSHARE_UPLOAD_TOKEN=$TOKEN
EOF
)

echo "✓ Deployed to $DEPLOY_URL"
echo "✓ CLI config at ~/.config/wwwshare/.env (mode 0600)"
```

To rotate the token later, re-run the `TOKEN=…` line through the `~/.config/wwwshare/.env` write.

### Install the CLI on your PATH

```sh
ln -s "$(pwd)/../cli/src/wwwshare.mjs" ~/bin/wwwshare   # from worker/
# or: ln -s "$PWD/cli/src/wwwshare.mjs" ~/bin/wwwshare   # from repo root
```

## Usage

```sh
wwwshare <html-file> <slug>                  # publish a new page (sandboxed)
wwwshare <html-file> <slug> --trust          # publish without the sandbox
wwwshare update <slug> <html-file> [--trust] # overwrite an existing page
wwwshare remove <slug>                       # delete a page
```

On success the URL is printed. The URL is also copied to the system clipboard unless the --no-cp flag is added.

`--trust` toggles per-upload: omitting it on an `update` demotes a previously trusted page back to sandboxed; passing it on `update` promotes a sandboxed page. The trust bit is stored as R2 `customMetadata` on the object.

### HTML constraints

- **UTF-8.** Pages are served with `Content-Type: text/html; charset=utf-8`. Non-UTF-8 input is uploaded verbatim but will render with the wrong charset.
- **Self-contained.** Both CSPs share the same script/style/img rules:

  ```
  default-src 'self'; img-src 'self' data: blob:;
  style-src 'unsafe-inline'; script-src 'unsafe-inline';
  object-src 'none'; base-uri 'self'; form-action 'none'
  ```

  Inline `<script>` and `<style>` work. External CDNs, fonts, scripts, and remote images are blocked. Embed everything as inline CSS / inline JS / `data:` URIs.

- **25 MB cap** per upload.

## Security model

This is a single-user tool. The threat model is "one person, one bearer token, public reads."

### Two trust levels per page

Every uploaded page lands at one of two trust levels, chosen at upload time:

- **Sandboxed (default).** The page is served with `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-top-navigation-by-user-activation` appended to the CSP. The browser gives the document an *opaque origin*, so:
  - `localStorage`, `sessionStorage`, and `document.cookie` for the wwwshare origin are unavailable.
  - Same-origin `fetch` back to the worker becomes cross-origin (and is still blocked by `default-src 'self'`).
  - `<a>` clicks to external sites still navigate; `<a target="_blank">` still opens new tabs; `alert/confirm/prompt` still work.
  - Scripts can't auto-redirect the tab (`window.location =` is blocked unless triggered by a user click).

  Use this for HTML you don't fully trust — friends' vibecoded pages, generated reports from untrusted tools, anything you haven't audited line-by-line.

- **Trusted (`--trust` flag).** The page runs in the real wwwshare origin. `localStorage`, cookies, and same-origin requests work normally. Use this when necessary for HTML you wrote or audited.

### Trust model for the bearer token

A token holder can:

- Publish arbitrary same-origin JavaScript at this Worker's URLs (especially with `--trust`).
- Read, overwrite, and delete any `/p/{slug}` page.
- Build same-origin phishing UI or stage drive-by attacks against any other site you eventually host on the same origin.

Practical implications:

1. **Use a separate origin/subdomain from anything cookie-authenticated.** A dedicated subdomain (e.g. `pages.example.com`) keeps the script grant from leaking into your main site's cookie scope. The sandbox default mitigates this for unaudited pages but a `--trust` upload still gets full same-origin powers. To set up a custom domain, bind a route in the Cloudflare dashboard and update `WWWSHARE_ENDPOINT` in `~/.config/wwwshare/.env`.
2. **Generate a strong token** (the snippet above gives ~256 bits) and rotate it if it ever leaks. To rotate, `wrangler secret put WWWSHARE_UPLOAD_TOKEN --config wrangler.prod.toml` again.
3. **Reads are unauthenticated, "unlisted by obscurity."** Anyone who knows or guesses a slug can fetch the page. Short, human-readable slugs are easy to guess — use longer or less guessable slugs for anything you want to keep semi-private.

For more on the trust boundary, see comments in `worker/src/upload.js` and `worker/src/read.js`.

## How it's stored

```
WWWSHARE_BUCKET/
└── {slug}/
    └── index.html
```

Upload writes a single R2 object atomically. Readers either see the page or 404 — no partial states. (Concurrent writers can still last-write-win on the same slug; for single-user CLI use that's fine.)
