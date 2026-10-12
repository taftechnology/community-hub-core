import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    env: {
      VITE_API_ORIGIN: "https://au.api.example.test",
      VITE_AUTH_ORIGIN: "https://auth.au.example.test",
    },
  },
});
