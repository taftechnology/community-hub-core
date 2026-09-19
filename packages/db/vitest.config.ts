import path from "node:path";
import { defineConfig } from "vitest/config";

const cryptoTesting = path.resolve(import.meta.dirname, "../crypto/src/testing.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@community-hub/crypto/testing": cryptoTesting,
    },
  },
  test: {
    alias: {
      "@community-hub/crypto/testing": cryptoTesting,
    },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false, // pooling tests need exclusive PgBouncer aliases
    globalSetup: "./test/global-setup.ts",
  },
});
