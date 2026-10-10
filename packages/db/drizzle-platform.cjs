/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- drizzle-kit loads this entry with require() */
const { pgSchema } = require("drizzle-orm/pg-core");

module.exports = { platform: pgSchema("platform") };
