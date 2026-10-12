import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle.schema.ts",
  // generate.test.ts points this at a scratch copy of ./drizzle; leave it unset for real work.
  out: process.env.DRIZZLE_GENERATE_OUT ?? "./drizzle",
  migrations: {
    schema: "migrator",
    table: "__drizzle_migrations",
  },
});
