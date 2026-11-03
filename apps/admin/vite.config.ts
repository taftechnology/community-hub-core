import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    assetsInlineLimit: (filePath) =>
      /\.(woff2?|eot|ttf|otf)$/i.test(filePath) ? false : undefined,
  },
});
