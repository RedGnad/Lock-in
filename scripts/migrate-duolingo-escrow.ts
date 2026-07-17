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
 * Env:   DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL_UNPOOLED, falling back to the
 *        pooled DUOLINGO_ESCROW_DATABASE_URL / DATABASE_URL with a warning.
 */

const url =
  process.env.DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED?.trim() ||
  process.env.DATABASE_URL_UNPOOLED?.trim() ||
  process.env.DUOLINGO_ESCROW_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED (or DATABASE_URL_UNPOOLED) is required to migrate");
if (!process.env.DUOLINGO_ESCROW_DATABASE_URL_UNPOOLED?.trim() && !process.env.DATABASE_URL_UNPOOLED?.trim()) {
  console.warn("No unpooled URL set; running DDL over a pooled endpoint.");
}

const sql = neon(url);
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
