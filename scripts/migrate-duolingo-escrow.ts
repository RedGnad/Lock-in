import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { DUOLINGO_ESCROW_SCHEMA } from "../src/duolingo-escrow-store.js";

/*
 * Creates the financial Duolingo escrow tables (contract B, real USDC).
 *
 * Additive only: three tables with CREATE TABLE IF NOT EXISTS, distinct from the Live Proof Beta's
 * duolingo_preview_* tables and from anything Strava. It must run against the Duolingo escrow database,
 * NEVER the Strava production database.
 *
 * DDL runs over the unpooled endpoint for the same reason the other migrations do: the pooled endpoint sits
 * behind PgBouncer in transaction mode, the wrong place for schema changes. The statements are idempotent.
 *
 * Usage: pnpm db:migrate:escrow
 * Env:   DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL_UNPOOLED2 (the local Duolingo
 *        Neon), then the pooled DUOLINGO_ESCROW_DATABASE_URL / DATABASE_URL2.
 *
 * It DELIBERATELY never falls back to DATABASE_URL / DATABASE_URL_UNPOOLED: locally those point at the
 * Strava production database, which this migration must never touch. As a second line of defence it aborts
 * if the target database contains any Strava table.
 */

const url =
  process.env.DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED?.trim() ||
  process.env.DATABASE_URL_UNPOOLED2?.trim() ||
  process.env.DUOLINGO_ESCROW_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL2?.trim();
if (!url) {
  throw new Error(
    "Set DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED (or DATABASE_URL_UNPOOLED2) to the Duolingo Neon. " +
      "Refusing to guess, and never using DATABASE_URL (Strava production).",
  );
}

const sql = neon(url);

// Defence in depth: if this database holds any Strava table, it is the wrong one. Abort before any DDL.
const stravaTables = (await sql.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('strava_connections', 'strava_tokens')`,
)) as { table_name: string }[];
if (stravaTables.length > 0) {
  throw new Error(
    `Refusing to migrate: this database contains Strava tables (${stravaTables.map((t) => t.table_name).join(", ")}). ` +
      "Point at the separate Duolingo Neon, never the Strava production database.",
  );
}
const statements = DUOLINGO_ESCROW_SCHEMA
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

for (const table of ["duolingo_escrow_sessions", "duolingo_escrow_baselines", "duolingo_escrow_finals"]) {
  const columns = (await sql.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  )) as { column_name: string }[];
  if (columns.length === 0) throw new Error(`${table} was not created`);
  console.log(`\n${table}: ${columns.map((c) => c.column_name).join(", ")}`);
}
