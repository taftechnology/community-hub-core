import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const plaintext = path.resolve(root, "../../../packages/db/src/plaintext.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@community-hub/db/plaintext": plaintext,
    },
  },
  test: {
    env: {
      TZ: "Australia/Sydney",
    },
    alias: {
      "@community-hub/db/plaintext": plaintext,
    },
    include: ["domain/**/*.test.ts", "db/**/*.test.ts", "infrastructure/**/*.test.ts"],
    globalSetup: path.resolve(root, "../../../packages/db/test/global-setup.ts"),
    fileParallelism: false,
  },
});
