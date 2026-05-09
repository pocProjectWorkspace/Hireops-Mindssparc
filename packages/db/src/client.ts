import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Add it to your .env file.");
}

// Runtime client: pooled connection (transaction mode, port 6543)
// `prepare: false` is required because transaction-mode pooling does not support prepared statements
const queryClient = postgres(databaseUrl, { prepare: false });
export const db = drizzle(queryClient, { schema });

export type Database = typeof db;
