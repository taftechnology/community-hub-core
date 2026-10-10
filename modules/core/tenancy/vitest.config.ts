import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["domain/**/*.test.ts", "db/**/*.test.ts", "infrastructure/**/*.test.ts"],
  },
});
