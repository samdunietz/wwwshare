import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Inject the dev token here so tests get it without committing it
      // to wrangler.toml. .dev.vars covers wrangler dev; production uses
      // `wrangler secret put`.
      miniflare: {
        bindings: { WWWSHARE_UPLOAD_TOKEN: "devtoken" },
      },
    }),
  ],
});
