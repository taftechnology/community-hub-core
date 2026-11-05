import { defineConfig } from "vitest/config";

// Task 3 adds the shared globalSetup when the first database test arrives; Docker is down and this task has no database.
export default defineConfig({
  test: {
    env: {
      TZ: "Australia/Sydney",
    },
    include: ["domain/**/*.test.ts"],
  },
});
