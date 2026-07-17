import { NextResponse } from "next/server";
import { fetchStatusUrl, verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { readJsonBody } from "@/src/api-guard";
import {
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  validateDuolingoDelta,
  validateDuolingoEvidence,
} from "@/src/duolingo-proof-policy";
import {
  consumeAndSaveBaseline,
  consumeAndSaveFinal,
  loadPreviewIdentity,
  loadPreviewRun,
  loadPreviewSession,
} from "@/src/duolingo-preview-store";
import { assertSdkProofSet } from "@/src/reclaim-onchain";
import type { ReclaimTrustedData } from "@/src/strava-proof-policy";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Verifies one phase of DUOLINGO_ZKTLS_DELTA_V1 and, on a final, rules on the delta.
 *
 * Everything the athlete could otherwise lie about is taken from the SERVER's session row, never from the
 * request: which wallet, which phase, which Duolingo profile. The browser only says "session X finished".
 *
 * The AI fallback is refused by requiring a TEE attestation, not by reading the self-reported isAiProof
 * flag: that flag lives in a context a liar controls, the attestation is cryptographic.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const sessionId = String(body.sessionId || "").trim();
    if (!/^[a-zA-Z0-9_-]{6,200}$/.test(sessionId)) throw new Error("Invalid Reclaim session");

    const session = await loadPreviewSession(sessionId);
    if (!session) throw new Error("Unknown Reclaim session");
    // The caller must own the wallet the session was opened for. Without this, anyone who learns a session
    // id could poll it to completion and bank the proof against that wallet.
    requireWalletAuthSession(request, session.walletAddress);

    const status = await fetchStatusUrl(sessionId);
    const proofs = (status?.session?.proofs || []) as Proof[];
    if (proofs.length === 0) throw new Error("Reclaim has not returned a proof yet");

    // Shape first: a proof with no teeAttestation is the AI fallback, and it stops here.
    assertSdkProofSet(proofs, { expectedCount: 2, maxSignedJsonBytes: 20_000 } as never);

    const appSecret = process.env.SECRET?.trim();
    if (!appSecret) throw new Error("The Reclaim application is not configured");
    const verified = await verifyProof(proofs, {
      providerId: DUOLINGO_PROVIDER_ID,
      providerVersion: DUOLINGO_PROVIDER_VERSION,
      allowedTags: [],
      teeAttestation: { appSecret },
    } as never);
    if (!verified.isVerified || !(verified as { isTeeAttestationVerified?: boolean }).isTeeAttestationVerified) {
      throw new Error("The proof failed SDK or TEE verification");
    }

    const evidence = validateDuolingoEvidence({
      data: verified.data as ReclaimTrustedData[],
      timestamps: proofs.map((proof) => Number(proof.claimData.timestampS)),
      providerId: DUOLINGO_PROVIDER_ID,
      policy: {
        walletAddress: session.walletAddress,
        pactId: "0",
        phase: session.phase,
        expectedSessionId: sessionId,
        expectedProfileId: session.duolingoProfileId,
      },
    });

    if (session.phase === "baseline") {
      // The target came from the session, fixed at creation, so polling could not have lowered it. The
      // consume and the write happen in one statement, so a burned session can never leave a missing
      // baseline; a replay finds it already consumed and is refused.
      const targetXp = session.targetXp;
      if (!Number.isSafeInteger(targetXp) || targetXp <= 0) throw new Error("Choose an XP target");
      if (!(await consumeAndSaveBaseline({
        sessionId,
        walletAddress: session.walletAddress,
        targetXp,
        identityHash: evidence.identityHash,
        baselineXp: evidence.totalXp,
        baselineObservedAt: evidence.observedAt,
        duolingoProfileId: evidence.profileId,
      }))) {
        throw new Error("This proof has already been recorded");
      }
      return NextResponse.json({
        phase: "baseline",
        targetXp,
        baselineXp: evidence.totalXp,
        observedAt: evidence.observedAt,
        // The account is verified; its pseudonymous identity stays on the server and never reaches here.
        account: "verified",
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const run = await loadPreviewRun(session.walletAddress);
    const identity = await loadPreviewIdentity(session.walletAddress);
    if (!run || !identity) throw new Error("Verify your starting XP before your final XP");

    // Every pairwise rule lives here: identity swapped, proof reused, XP gone backwards, final not newer.
    // The baseline identity comes from the server-held row, so a final on a different account is caught.
    const delta = validateDuolingoDelta({
      baseline: {
        profileId: run.duolingoProfileId,
        totalXp: run.baselineXp,
        identityHash: identity,
        eventNullifier: `0x${"0".repeat(64)}`,
        observedAt: run.baselineObservedAt,
        sessionId,
        phase: "baseline",
      },
      final: evidence,
      targetXp: run.targetXp,
    });

    // Validation passed; commit the result and consume the session together.
    if (!(await consumeAndSaveFinal({
      sessionId,
      walletAddress: session.walletAddress,
      finalXp: delta.finalXp,
      earnedXp: delta.earnedXp,
      finalObservedAt: evidence.observedAt,
    }))) {
      throw new Error("This proof has already been recorded");
    }

    return NextResponse.json({
      phase: "final",
      targetXp: run.targetXp,
      baselineXp: delta.baselineXp,
      finalXp: delta.finalXp,
      earnedXp: delta.earnedXp,
      passed: true,
      observedAt: evidence.observedAt,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // The reason is the product here: "no" without a reason is what makes people distrust a proof system.
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : error instanceof Error ? error.message : "The Duolingo proof was rejected",
    }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
  }
}
