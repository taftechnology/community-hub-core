import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

import communityHub from "./tooling/eslint-plugin-community-hub/index.js";

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
      "**/src/testing.ts",
      "**/vitest.config.ts",
      "**/vitest.worker.config.ts",
      "**/global-setup.ts",
      "**/migrate-test.ts",
      "**/schema-test.ts",
      "**/drizzle.config.ts",
      "**/drizzle-test.config.ts",
      "tooling/eslint-plugin-community-hub/**",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@community-hub": communityHub,
    },
    rules: {
      "@community-hub/no-encrypted-column-query": "error",
      "@community-hub/no-event-payload": "error",
      "@community-hub/no-kms-port-outside-crypto": "error",
      "@community-hub/no-restricted-disable": "error",
      "@community-hub/no-ts-ignore": "error",
      "@community-hub/no-crypto-testing-import": "error",
    },
  },
  {
    files: ["**/packages/kernel/**/*.{js,ts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@community-hub/db",
              message: "kernel must not import @community-hub/db (including import type).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/apps/gateway/**/*.{js,ts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@community-hub/db",
              message: "gateway must not import @community-hub/db (including import type).",
            },
            {
              name: "@community-hub/kernel/module",
              message: "gateway must not import @community-hub/kernel/module.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/src/testing.ts",
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
