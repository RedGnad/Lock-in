import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { STRAVA_TOKENS_SCHEMA } from "../src/strava-token-store.js";

/*
 * Creates the Strava connection table.
 *
 * DDL runs over DATABASE_URL_UNPOOLED: the pooled endpoint sits behind PgBouncer in transaction mode,
 * which is fine for the app's queries but the wrong place to run schema changes. The statements are
 * idempotent, so re-running this is safe.
 *
 * Usage: pnpm db:migrate
 */

const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required to migrate");
if (!process.env.DATABASE_URL_UNPOOLED?.trim()) {
  console.warn("DATABASE_URL_UNPOOLED is unset; running DDL over the pooled endpoint.");
}

const sql = neon(url);
for (const statement of STRAVA_TOKENS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
  await sql.query(statement);
  console.log("applied:", statement.split("\n")[0].trim());
}

const columns = (await sql.query(
  `SELECT column_name, data_type, is_nullable FROM information_schema.columns
   WHERE table_name = 'strava_connections' ORDER BY ordinal_position`,
)) as { column_name: string; data_type: string; is_nullable: string }[];

console.log("\nstrava_connections:");
for (const column of columns) {
  console.log(`  ${column.column_name.padEnd(24)} ${column.data_type} ${column.is_nullable === "NO" ? "NOT NULL" : ""}`);
}
if (columns.length === 0) throw new Error("The table was not created");
