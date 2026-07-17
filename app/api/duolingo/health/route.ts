import { NextResponse } from "next/server";
import { DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION } from "@/src/duolingo-proof-policy";
import { previewStorageReachable } from "@/src/duolingo-preview-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Health for the Duolingo Live Proof Beta, scoped to what the Preview actually depends on.
 *
 * No chain, no escrow, no Strava: this project has none of those and must not import their secrets to
 * satisfy an old check. It reports the database, the Reclaim configuration, the pinned provider version,
 * and whether the allowlist is set. Anything unproven answers 503, so an unconfigured Preview never looks
 * open.
 */
export async function GET() {
  const checks = {
    databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    databaseReachable: await previewStorageReachable(),
    reclaimConfigured: Boolean(process.env.ID?.trim() && process.env.SECRET?.trim()),
    sessionSigningConfigured: (process.env.SESSION_SIGNING_SECRET?.trim().length ?? 0) >= 32,
    allowlistConfigured: Boolean(process.env.DUOLINGO_PREVIEW_ALLOWED_WALLETS?.trim()),
  };
  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json({
    ok,
    service: "duolingo-live-proof-beta",
    verification: { scheme: "DUOLINGO_ZKTLS_DELTA_V1", provider: DUOLINGO_PROVIDER_ID, providerVersion: DUOLINGO_PROVIDER_VERSION },
    checks,
  }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
