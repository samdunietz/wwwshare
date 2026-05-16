# wwwshare

Publish a single, self-contained HTML file to a short URL, hosted for free on Cloudflare.

```sh
wwwshare ./talk.html my-talk
# ✓ Published "my-talk"
#   https://wwwshare.yourname.workers.dev/p/my-talk
```

That's it. 

## Why

There are plenty of ways to host a static page, but `wwwshare` accepts one file, gives you a short URL, and gets out of the way.

Inspired by the Twitter thread, ["Using Claude Code: The Unreasonable Effectiveness of HTML"](https://x.com/trq212/status/2052809885763747935), and a growing pile of SingleFile HTML pages I have saved on my laptop.

Prepare a vacation proposal, or a date-night invitation, for your special someone. Text a personalized landing page to your talking stage. Draft a project proposal at the bus stop, all from your phone with [Remote Control](https://code.claude.com/docs/en/remote-control)!

`wwwshare` supports all your single-page web deployment needs, from first draft to shareable URL.

## Install

This script is intended for macOS and Linux.

Install `npm` and `node` if not already. Then:

```sh
git clone https://github.com/samdunietz/wwwshare.git
cd wwwshare
npm install
```

Verify the local setup:

```sh
npm test
```

Now install the CLI onto your PATH:

```sh
( cd cli && npm link )
```

You now have the wwwshare command, but it needs a deployed Cloudflare Worker to host your web page - see next section.

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
if [ -z "$DEPLOY_URL" ]; then
  echo "❌ Could not find a workers.dev URL in the deploy output above. Skipping token generation — re-check the output and re-run this block." >&2
else
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
fi
```

`wwwshare` away!

## Usage

```sh
wwwshare <html-file> <slug>                  # publish a new page (sandboxed)
wwwshare <html-file> <slug> --trust          # publish without the sandbox
wwwshare update <slug> <html-file> [--trust] # overwrite an existing page
wwwshare remove <slug>...                    # delete one or more pages
wwwshare list                                # list every live slug, one per line
```

On a successful publish/update, the URL is printed (and copied to the system clipboard unless `--no-cp` is added). To download a page, hit `/p/{slug}` directly — e.g. `wget "$WWWSHARE_ENDPOINT/p/<slug>"`.

By default the page is loaded in a CSP `sandbox` so its scripts run but can't touch cookies or localStorage on the wwwshare origin (see below for details); pass `--trust` to opt out.

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

## Using the CLI from another machine

If you've already deployed and just want to publish from a new box, **don't** re-run the deploy block above — it mints a fresh token and silently invalidates the existing one. Instead, get the CLI source on disk and recreate the config:

```sh
git clone https://github.com/samdunietz/wwwshare.git
cd wwwshare
npm install
```

On the new machine, recreate `~/.config/wwwshare/.env` with values from the original (replace `<your-subdomain>` and `<your-token>`):

```sh
mkdir -p ~/.config/wwwshare
( umask 077 && cat > ~/.config/wwwshare/.env <<EOF
WWWSHARE_ENDPOINT=https://wwwshare.<your-subdomain>.workers.dev
WWWSHARE_UPLOAD_TOKEN=<your-token>
EOF
)
```

Then put the CLI on your PATH:

```sh
( cd cli && npm link )
```


## Local development

Start the dev server:

```sh
echo "WWWSHARE_UPLOAD_TOKEN=devtoken" > worker/.dev.vars
npm run dev
```

In another shell, publish to the dev worker. Replace `<port>` below with the `npm run dev` port.

```sh
alias wwwshare-dev='WWWSHARE_ENDPOINT=http://localhost:<port> WWWSHARE_UPLOAD_TOKEN=devtoken wwwshare'
wwwshare-dev ./some-file.html my-slug
```

Inline env vars override `~/.config/wwwshare/.env` so they don't touch a prod config; using an alias avoids accidentally hitting prod.

## Layout

This is a Cloudflare Workers app with two npm workspaces:

- `worker/` — the Cloudflare Worker (HTTP + R2). No bundler.
- `cli/` — the `wwwshare` Node CLI that talks to the Worker over the HTTP API.

The Worker has five endpoints:

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `POST` | `/upload` | Bearer | Multipart upload (`slug`, `html`, optional `update=1`, optional `trusted=1`). 201 create / 200 update / 409 conflict / 404 missing-for-update. |
| `GET` / `HEAD` | `/p/{slug}` | none | Serve the page with the `wwwshare` CSP. |
| `DELETE` | `/p/{slug}` | Bearer | Remove the page. 204 on success, 404 if missing. |
| `GET` | `/list` | Bearer | Return `{slugs: [...]}` sorted ascending. |
| `GET` | `/` | none | Tiny landing page. |

Slugs match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (1–64 chars, lowercase + digits + dash, no leading/trailing dash).

### How it's stored

```
WWWSHARE_BUCKET/
└── {slug}/
    └── index.html
```

Upload writes a single R2 object atomically. (If there are concurrent writers, last-write-wins on the same slug.)

## Security model

This is a single-user tool. The threat model is "one person, one bearer token, public reads."

### Two trust levels per page

Every uploaded page lands at one of two trust levels, chosen at upload time:

- **Sandboxed (default).** The page is served with `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-top-navigation-by-user-activation` appended to the CSP. The browser gives the document an *opaque origin*, so:
  - `localStorage`, `sessionStorage`, and `document.cookie` for the wwwshare origin are unavailable.
  - Same-origin `fetch` back to the worker becomes cross-origin (and is still blocked by `default-src 'self'`).
  - `<a>` clicks to external sites still navigate; `<a target="_blank">` still opens new tabs; `alert/confirm/prompt` still work.
  - Scripts can't auto-redirect the tab (`window.location =` is blocked unless triggered by a user click).

- **Trusted (`--trust` flag).** The page runs in the real wwwshare origin. `localStorage`, cookies, and same-origin requests work normally. Only use this when necessary for HTML you wrote or audited.

### Trust model for the bearer token

A token holder can:

- Publish arbitrary same-origin JavaScript at this Worker's URLs (especially with `--trust`).
- Read, overwrite, and delete any `/p/{slug}` page.
- Enumerate every live slug via `GET /list`.
- Build same-origin phishing UI or stage drive-by attacks against any other site you eventually host on the same origin.

Practical implications:

1. **Use a separate origin/subdomain from anything cookie-authenticated.** A dedicated subdomain (e.g. `pages.example.com`) keeps the script grant from leaking into your main site's cookie scope. The sandbox mitigates this by default but a `--trust` upload still gets full same-origin powers.
2. **Generate a strong token** (the snippet above gives ~256 bits) and rotate it if it ever leaks — see the rotation recipe below.
3. **Reads are unauthenticated.** Anyone who knows or guesses a slug can fetch the page. Short, human-readable slugs are easy to guess — use longer or less guessable slugs for anything you want to keep semi-private. `/list` is bearer-gated, because enumerating every live slug is a stronger power than fetching any one.

To rotate the token (e.g. if it leaks), from the repo root:

```sh
cd worker
. ~/.config/wwwshare/.env  # preserve the existing endpoint

NEW_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
printf '%s' "$NEW_TOKEN" | npx wrangler secret put WWWSHARE_UPLOAD_TOKEN --config wrangler.prod.toml

( umask 077 && cat > ~/.config/wwwshare/.env <<EOF
WWWSHARE_ENDPOINT=$WWWSHARE_ENDPOINT
WWWSHARE_UPLOAD_TOKEN=$NEW_TOKEN
EOF
)

echo "✓ New token: $NEW_TOKEN — copy to any other machines using this deploy."
```

This invalidates every other machine still holding the old token; push the new one to them too.

For more on the trust boundary, see comments in `worker/src/upload.js` and `worker/src/read.js`.
