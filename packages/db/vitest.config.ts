import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false, // pooling tests need exclusive PgBouncer aliases
    globalSetup: "./test/global-setup.ts",
  },
});
