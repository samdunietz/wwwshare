# wwwshare

Publish a single, self-contained HTML file to a short URL.

```sh
wwwshare ./talk.html my-talk
# ✓ Published "my-talk"
#   https://wwwshare.example.com/p/my-talk
```

That's it. The bytes go to R2 verbatim and are served back with an inline-script/style CSP — perfect for hand-authored documents with SVG diagrams, embedded styles, and inline JavaScript.

## Why

There are plenty of ways to host a static page, but most of them either require a build step, expect a folder, or strip the inline `<script>`/`<style>` that make a self-contained HTML doc actually self-contained. `wwwshare` accepts one file, gives you a short URL, and gets out of the way.

It pairs naturally with tooling that produces single-file HTML — design mockups, generated reports, slides, one-off explainers.

## Layout

This is a Cloudflare Workers app with two npm workspaces:

- `worker/` — the Cloudflare Worker (HTTP + R2). No bundler.
- `cli/` — the `wwwshare` Node CLI that uploads via `POST /upload`.

The Worker has four endpoints:

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `POST` | `/upload` | Bearer | Multipart upload (`slug`, `html`, optional `update=1`). 201 create / 200 update / 409 conflict / 404 missing-for-update. |
| `GET` / `HEAD` | `/p/{slug}` | none | Serve the page with the `wwwshare` CSP. |
| `DELETE` | `/p/{slug}` | Bearer | Remove the page. 204 on success, 404 if missing. |
| `GET` | `/` | none | Tiny landing page. |

Slugs match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (1–64 chars, lowercase + digits + dash, no leading/trailing dash).

## Local development

```sh
git clone https://github.com/sdunietz/wwwshare.git
cd wwwshare
npm install
```

You need a dev bearer token. Anything works for local — pick a string:

```sh
echo "WWWSHARE_UPLOAD_TOKEN=devtoken" > worker/.dev.vars
```

Run the worker:

```sh
npm run dev
# → http://localhost:8787
```

Configure the CLI to talk to it:

```sh
cp cli/.env.example cli/.env
# the example already points at http://localhost:8787 with token=devtoken
```

Run the CLI:

```sh
node cli/src/wwwshare.mjs ./some-file.html my-slug
```

Run the tests:

```sh
npm test
```

## Deploying to Cloudflare

You'll need a Cloudflare account with Workers + R2 enabled.

### 1. Create the R2 bucket

```sh
npx wrangler r2 bucket create wwwshare-content
```

The dev config (`worker/wrangler.toml`) uses `wwwshare-content-dev`; production should use a different bucket name. Create a `worker/wrangler.prod.toml` (gitignored secrets, committed config) that points at the prod bucket:

```toml
name = "wwwshare"
main = "src/index.js"
compatibility_date = "2026-05-13"

[[r2_buckets]]
binding = "WWWSHARE_BUCKET"
bucket_name = "wwwshare-content"
```

### 2. Generate and set the upload secret

Generate a strong random token locally:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then store it as a Worker secret:

```sh
cd worker
npx wrangler secret put WWWSHARE_UPLOAD_TOKEN --config wrangler.prod.toml
# paste the token when prompted
```

You'll use the same token from the CLI side.

### 3. Deploy

```sh
cd worker
npx wrangler deploy --config wrangler.prod.toml
```

By default this serves on `https://wwwshare.<your-account>.workers.dev`. To put it on a real domain (recommended — see Security below), bind a route in the Cloudflare dashboard or via `wrangler`.

### 4. Configure the CLI for production

The CLI loads config from a `.env` file in one of two places (whichever
it finds first; shell env vars always win):

1. `cli/.env` — next to the script, for hacking on the repo.
2. `~/.config/wwwshare/.env` (or `$XDG_CONFIG_HOME/wwwshare/.env`) — for
   the symlinked-into-PATH install.

Pick whichever fits your workflow:

```sh
# Installed-CLI layout (recommended):
mkdir -p ~/.config/wwwshare
cat > ~/.config/wwwshare/.env <<EOF
WWWSHARE_ENDPOINT=https://wwwshare.example.com
WWWSHARE_UPLOAD_TOKEN=<the token you generated>
EOF
chmod 600 ~/.config/wwwshare/.env
```

### 5. (Optional) Install the CLI on your PATH

Either `npm link` from `cli/`, or symlink the script:

```sh
ln -s "$PWD/cli/src/wwwshare.mjs" ~/bin/wwwshare
```

## Usage

```sh
wwwshare <html-file> <slug>            # publish a new page
wwwshare update <slug> <html-file>     # overwrite an existing page
wwwshare remove <slug>                 # delete a page
```

On success the URL is printed and copied to the system clipboard (via `pbcopy` / `wl-copy` / `xclip`, in that order).

### HTML constraints

- **UTF-8.** Pages are served with `Content-Type: text/html; charset=utf-8`. Non-UTF-8 input is uploaded verbatim but will render with the wrong charset.
- **Self-contained.** The default CSP is:

  ```
  default-src 'self'; img-src 'self' data: blob:;
  style-src 'unsafe-inline'; script-src 'unsafe-inline';
  object-src 'none'; base-uri 'self'; form-action 'none'
  ```

  Inline `<script>` and `<style>` work. External CDNs, fonts, scripts, and remote images are blocked. Embed everything as inline CSS / inline JS / `data:` URIs.

- **25 MB cap** per upload.

## Security model

This is a single-user tool. The threat model is "one person, one bearer token, public reads."

**The upload token can do a lot.** A holder can:

- Publish arbitrary same-origin JavaScript at this Worker's URLs.
- Read, overwrite, and delete any `/p/{slug}` page.
- Build same-origin phishing UI or stage drive-by attacks against any other site you eventually host on the same origin.

Practical implications:

1. **Use a separate origin/subdomain from anything cookie-authenticated.** A dedicated subdomain (e.g. `pages.example.com`) keeps the script grant from leaking into your main site's cookie scope.
2. **Generate a strong token** (the snippet above gives ~256 bits) and rotate it if it ever leaks. To rotate, `wrangler secret put WWWSHARE_UPLOAD_TOKEN --config wrangler.prod.toml` again.
3. **Reads are unauthenticated, "unlisted by obscurity."** Anyone who knows or guesses a slug can fetch the page. Short, human-readable slugs are easier to guess than `kshare`-style 8-char random ones — use longer or less guessable slugs for anything you want to keep semi-private.

For more on the trust boundary, see comments in `worker/src/upload.js` and `worker/src/read.js`.

## How it's stored

```
WWWSHARE_BUCKET/
└── {slug}/
    └── index.html
```

That's the whole R2 layout. The directory shape leaves room to grow per-page assets (e.g. `{slug}/img/foo.png`) without a key migration; today, nothing else lives there.

Upload writes a single R2 object atomically. Readers either see the page or 404 — no partial states. (Concurrent writers can still last-write-win on the same slug; for single-user CLI use that's fine.)

## License

MIT.
