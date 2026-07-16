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
// Strip `--` comments BEFORE splitting: a prose semicolon inside a comment would otherwise cut a
// statement in half and send the second half to Postgres on its own.
const statements = STRAVA_TOKENS_SCHEMA
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
for (const statement of statements) {
  await sql.query(statement);
  console.log("applied:", statement.split("\n")[0].trim().slice(0, 70));
}

for (const table of ["strava_connections", "strava_oauth_states"]) {
  const columns = (await sql.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  )) as { column_name: string; data_type: string }[];
  if (columns.length === 0) throw new Error(`${table} was not created`);
  console.log(`\n${table}: ${columns.map((c) => c.column_name).join(", ")}`);
}
