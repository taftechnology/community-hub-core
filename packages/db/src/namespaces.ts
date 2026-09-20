import { pgSchema } from "drizzle-orm/pg-core";

export const app = pgSchema("app");
export const identity = pgSchema("identity");
export const platform = pgSchema("platform");
