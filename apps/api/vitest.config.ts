import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // The pool must not open a remote proxy for `KMS_BROKER`.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
