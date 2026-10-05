import path from "node:path";
import { defineConfig } from "vitest/config";

const cryptoTesting = path.resolve(import.meta.dirname, "../crypto/src/testing.ts");
const dbPlaintext = path.resolve(import.meta.dirname, "./src/plaintext.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@community-hub/crypto/testing": cryptoTesting,
      "@community-hub/db/plaintext": dbPlaintext,
    },
  },
  test: {
    alias: {
      "@community-hub/crypto/testing": cryptoTesting,
      "@community-hub/db/plaintext": dbPlaintext,
    },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false, // pooling tests need exclusive PgBouncer aliases
    globalSetup: "./test/global-setup.ts",
  },
});
