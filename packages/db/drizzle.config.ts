import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  migrations: {
    schema: "migrator",
    table: "__drizzle_migrations",
  },
});
