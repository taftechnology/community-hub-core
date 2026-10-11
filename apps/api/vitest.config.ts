import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const plaintext = path.resolve(root, "../../packages/db/src/plaintext.ts");
const cryptoTesting = path.resolve(root, "../../packages/crypto/src/testing.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@community-hub/db/plaintext": plaintext,
      "@community-hub/crypto/testing": cryptoTesting,
    },
  },
  test: {
    alias: {
      "@community-hub/db/plaintext": plaintext,
      "@community-hub/crypto/testing": cryptoTesting,
    },
    include: ["src/**/*.test.ts"],
    globalSetup: path.resolve(root, "../../packages/db/test/global-setup.ts"),
    fileParallelism: false,
  },
});
