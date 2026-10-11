import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle.schema.ts",
  out: "./drizzle",
  migrations: {
    schema: "migrator",
    table: "__drizzle_migrations",
  },
});
