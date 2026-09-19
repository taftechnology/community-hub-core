import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["selftest.ts", "**/*.selftest.ts"],
    testTimeout: 60_000,
  },
});
