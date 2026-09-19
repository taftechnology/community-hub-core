import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./test/schema-test.ts",
  out: "./drizzle-test",
  migrations: {
    schema: "migrator",
    table: "__drizzle_migrations_test",
  },
});
