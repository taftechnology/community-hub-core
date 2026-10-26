import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  build: {
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    manifest: false,
    sourcemap: false,
    cssCodeSplit: false,
  },
});
