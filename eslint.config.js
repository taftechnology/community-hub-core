import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/fixtures/**",
    ],
  },
  {
    files: ["**/*.{js,ts}"],
    ignores: [
      "**/*.test.ts",
      "**/vitest.config.ts",
      "**/vitest.worker.config.ts",
      "**/global-setup.ts",
      "**/migrate-test.ts",
      "**/schema-test.ts",
      "**/drizzle.config.ts",
      "**/drizzle-test.config.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/global-setup.ts",
      "**/migrate-test.ts",
      "**/schema-test.ts",
      "**/vitest.config.ts",
      "**/vitest.worker.config.ts",
      "**/drizzle.config.ts",
      "**/drizzle-test.config.ts",
    ],
    extends: [...tseslint.configs.recommended],
  },
);
