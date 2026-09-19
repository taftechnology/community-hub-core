import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const testingEntry = path.resolve(import.meta.dirname, "src/testing.ts");

export default defineWorkersConfig({
  resolve: {
    alias: {
      "@community-hub/crypto/testing": testingEntry,
    },
  },
  test: {
    alias: {
      "@community-hub/crypto/testing": testingEntry,
    },
    include: ["src/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
