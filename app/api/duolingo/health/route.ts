import { NextResponse } from "next/server";
import { DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION } from "@/src/duolingo-proof-policy";
import { escrowStorageReachable } from "@/src/duolingo-escrow-store";
import { escrowVerifyingContract } from "@/src/duolingo-escrow-attestation";
import { PINNED_DUOLINGO_EVIDENCE_SIGNER } from "@/src/duolingo-escrow-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Health for the FINANCIAL Duolingo escrow, the mode the main app actually runs. It checks the escrow's own
 * configuration and its dedicated database, and never touches the old Live Proof `duolingo_preview_*` tables
 * (which do not exist on the unified deployment). It reports the active mode and the escrow address so a
 * monitor can tell at a glance whether staking is wired.
 */
export async function GET() {
  let escrow: string | null = null;
  try {
    escrow = escrowVerifyingContract();
  } catch {
    escrow = null;
  }
  const checks = {
    escrowAddressConfigured: Boolean(escrow),
    escrowDatabaseConfigured: Boolean(process.env.DUOLINGO_ESCROW_DATABASE_URL?.trim()),
    escrowDatabaseReachable: await escrowStorageReachable(),
    evidenceSignerConfigured: Boolean(
      (process.env.DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY || process.env.DUOLINGO_EVIDENCE_SIGNER_ADDRESS)?.trim(),
    ),
    identityHmacConfigured: (() => {
      try {
        return Buffer.from(process.env.DUOLINGO_IDENTITY_HMAC_KEY?.trim() || "", "base64").length === 32;
      } catch {
        return false;
      }
    })(),
    reclaimConfigured: Boolean(process.env.ID?.trim() && process.env.SECRET?.trim()),
    sessionSigningConfigured: (process.env.SESSION_SIGNING_SECRET?.trim().length ?? 0) >= 32,
    allowlistConfigured: Boolean(process.env.DUOLINGO_ESCROW_ALLOWED_WALLETS?.trim()),
  };
  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json({
    ok,
    service: "duolingo-financial-escrow",
    mode: checks.escrowAddressConfigured ? "financial" : "unconfigured",
    escrow,
    verification: {
      scheme: "DUOLINGO_ZKTLS_DELTA_V1",
      provider: DUOLINGO_PROVIDER_ID,
      providerVersion: DUOLINGO_PROVIDER_VERSION,
      evidenceSigner: PINNED_DUOLINGO_EVIDENCE_SIGNER,
    },
    checks,
  }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
