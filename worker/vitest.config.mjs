import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Inject the dev token here so tests get it without committing it
        // to wrangler.toml. .dev.vars covers wrangler dev; production uses
        // `wrangler secret put`.
        miniflare: {
          bindings: { WWWSHARE_UPLOAD_TOKEN: "devtoken" },
        },
      },
    },
  },
});
