import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/coverage/**"],
  },
  {
    files: ["**/*.{js,ts}"],
    ignores: ["**/*.test.ts", "**/vitest.config.ts", "**/global-setup.ts", "**/drizzle.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/global-setup.ts", "**/vitest.config.ts", "**/drizzle.config.ts"],
    extends: [...tseslint.configs.recommended],
  },
);
