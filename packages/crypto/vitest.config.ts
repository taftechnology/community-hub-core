import path from "node:path";
import { defineConfig } from "vitest/config";

const testingEntry = path.resolve(import.meta.dirname, "src/testing.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@community-hub/crypto/testing": testingEntry,
    },
  },
  test: {
    alias: {
      "@community-hub/crypto/testing": testingEntry,
    },
    include: ["src/**/*.test.ts", "test/dist-absence.test.ts"],
  },
});
