import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { DUOLINGO_PREVIEW_SCHEMA } from "../src/duolingo-preview-store.js";

/*
 * Creates the Duolingo Live Proof Beta tables.
 *
 * Additive only: two new tables with CREATE TABLE IF NOT EXISTS. It never reads or touches
 * strava_connections, so it is safe to run against the same Neon database the Strava production uses,
 * though the Preview should ideally point at its own DATABASE_URL.
 *
 * DDL runs over DATABASE_URL_UNPOOLED for the same reason the Strava migration does: the pooled endpoint
 * sits behind PgBouncer in transaction mode, the wrong place for schema changes. The statements are
 * idempotent.
 *
 * Usage: pnpm db:migrate:duolingo
 */

const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required to migrate");
if (!process.env.DATABASE_URL_UNPOOLED?.trim()) {
  console.warn("DATABASE_URL_UNPOOLED is unset; running DDL over the pooled endpoint.");
}

const sql = neon(url);
// Strip `--` comments before splitting: a prose semicolon inside a comment would otherwise cut a
// statement in half and send the second half to Postgres on its own.
const statements = DUOLINGO_PREVIEW_SCHEMA
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

for (const table of ["duolingo_preview_sessions", "duolingo_preview_runs"]) {
  const columns = (await sql.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  )) as { column_name: string; data_type: string }[];
  if (columns.length === 0) throw new Error(`${table} was not created`);
  console.log(`\n${table}: ${columns.map((c) => c.column_name).join(", ")}`);
}
