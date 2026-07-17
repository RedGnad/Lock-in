import assert from "node:assert/strict";
import test from "node:test";
import { DUOLINGO_ESCROW_SCHEMA, loadEscrowSession } from "../src/duolingo-escrow-store.js";

test("the financial store requires DUOLINGO_ESCROW_DATABASE_URL and never falls back to DATABASE_URL", async () => {
  const saved = { escrow: process.env.DUOLINGO_ESCROW_DATABASE_URL, db: process.env.DATABASE_URL };
  delete process.env.DUOLINGO_ESCROW_DATABASE_URL;
  // DATABASE_URL is the Strava production database locally; its presence alone must NOT enable the store.
  process.env.DATABASE_URL = "postgres://strava-prod-must-not-be-used/neondb";
  try {
    await assert.rejects(loadEscrowSession("abcdef"), /DUOLINGO_ESCROW_DATABASE_URL/);
  } finally {
    if (saved.escrow === undefined) delete process.env.DUOLINGO_ESCROW_DATABASE_URL;
    else process.env.DUOLINGO_ESCROW_DATABASE_URL = saved.escrow;
    if (saved.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.db;
  }
});

test("durable baseline and final rows carry no raw Duolingo profile id", () => {
  // The raw id may appear only on the transient sessions table and in the idempotent DROP.
  const occurrences = (DUOLINGO_ESCROW_SCHEMA.match(/duolingo_profile_id/g) || []).length;
  assert.equal(occurrences, 2, "profile id must appear only in the sessions table and the DROP COLUMN");
  assert.match(DUOLINGO_ESCROW_SCHEMA, /ALTER TABLE duolingo_escrow_baselines DROP COLUMN IF EXISTS duolingo_profile_id/);

  const baselines = DUOLINGO_ESCROW_SCHEMA.slice(DUOLINGO_ESCROW_SCHEMA.indexOf("duolingo_escrow_baselines"));
  assert.doesNotMatch(baselines.slice(0, baselines.indexOf("PRIMARY KEY")), /duolingo_profile_id/);
  const finals = DUOLINGO_ESCROW_SCHEMA.slice(DUOLINGO_ESCROW_SCHEMA.indexOf("duolingo_escrow_finals"));
  assert.doesNotMatch(finals.slice(0, finals.indexOf("PRIMARY KEY")), /duolingo_profile_id/);
});
