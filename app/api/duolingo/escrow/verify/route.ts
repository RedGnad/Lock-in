import { NextResponse } from "next/server";
import { fetchStatusUrl, verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import type { Hex } from "viem";
import { readJsonBody } from "@/src/api-guard";
import {
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  DuolingoPolicyError,
  validateDuolingoDelta,
  validateDuolingoEvidence,
} from "@/src/duolingo-proof-policy";
import { duolingoIdentityHash } from "@/src/duolingo-attestation";
import {
  buildBaselineAttestation,
  buildFinalAttestation,
  escrowVerifyingContract,
} from "@/src/duolingo-escrow-attestation";
import { assertEscrowWalletAllowed, EscrowAccessError } from "@/src/duolingo-escrow-access";
import { assertEscrowFinalOpen, EscrowChainUnavailableError, readEscrowPact } from "@/src/duolingo-escrow-chain";
import {
  consumeAndSaveBaseline,
  consumeAndSaveFinal,
  loadEscrowBaseline,
  loadEscrowSession,
} from "@/src/duolingo-escrow-store";
import { assertSdkProofSet } from "@/src/reclaim-onchain";
import type { ReclaimTrustedData } from "@/src/strava-proof-policy";
import { checkRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

/**
 * Verifies one phase of the FINANCIAL Duolingo escrow and returns the EIP-712 attestation the client
 * submits on-chain. Everything the athlete could lie about is taken from the SERVER session and the CHAIN,
 * never from the request: which wallet, which phase, which profile, which Lock terms and target. The AI
 * fallback is refused by requiring a verified TEE attestation, not by trusting a self-reported flag.
 *
 * This route is the trusted evidence signer. It signs only after: the proof is TEE-verified and bound to
 * this wallet, session and profile; and, for a final, the on-chain pact confirms the wallet joined, its
 * bound identity is the same account, the delta clears the pact's target, and the proof falls inside the
 * challenge window.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const sessionId = String(body.sessionId || "").trim();
    if (!/^[a-zA-Z0-9_-]{6,200}$/.test(sessionId)) throw new Error("Invalid Reclaim session");

    const session = await loadEscrowSession(sessionId);
    if (!session) throw new Error("Unknown Reclaim session");
    requireWalletAuthSession(request, session.walletAddress);
    assertEscrowWalletAllowed(session.walletAddress);
    try {
      escrowVerifyingContract();
    } catch {
      throw new EscrowChainUnavailableError("The Duolingo escrow is not available yet");
    }
    const rate = checkRateLimit("verify", request, session.walletAddress);
    if (!rate.allowed) {
      return NextResponse.json({ error: "Too many attempts. Try again shortly." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rate),
      });
    }

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
        pactId: session.pactId ?? "0",
        phase: session.phase,
        expectedSessionId: sessionId,
        expectedProfileId: session.duolingoProfileId,
        expectedContextMessage: session.contextMessage,
      },
    });

    if (session.phase === "baseline") {
      if (session.intent !== "create" && session.intent !== "join") throw new Error("Invalid baseline session");
      if (!session.configHash) throw new Error("Invalid baseline session");
      const attestation = session.intent === "create"
        ? await buildBaselineAttestation({
            account: session.walletAddress as Hex,
            profileId: evidence.profileId,
            configHash: session.configHash as Hex,
            intent: "create",
            createNonce: (session.createNonce ?? "") as Hex,
          })
        : await buildBaselineAttestation({
            account: session.walletAddress as Hex,
            profileId: evidence.profileId,
            configHash: session.configHash as Hex,
            intent: "join",
            pactId: BigInt(session.pactId as string),
          });

      // Consume the session and record the baseline together. It is written once per (wallet, configHash)
      // and never overwritten: a staked baseline that could be lowered would break the whole delta.
      if (!(await consumeAndSaveBaseline({
        sessionId,
        walletAddress: session.walletAddress,
        configHash: session.configHash,
        intent: session.intent,
        pactId: session.pactId,
        createNonce: session.createNonce,
        identityHash: attestation.identityHash,
        targetXp: session.targetXp,
        baselineXp: evidence.totalXp,
        baselineObservedAt: evidence.observedAt,
        nullifier: attestation.nullifier,
      }))) {
        throw new Error("This baseline has already been recorded. Start a new one to try again.");
      }

      return NextResponse.json({
        phase: "baseline",
        intent: session.intent,
        baselineXp: evidence.totalXp,
        targetXp: session.targetXp,
        observedAt: evidence.observedAt,
        createNonce: session.createNonce,
        attestation: serialiseBaseline(attestation),
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // --- final ---------------------------------------------------------------------------------------
    const pactId = BigInt(session.pactId as string);
    const pact = await readEscrowPact(pactId, session.walletAddress);
    if (!pact) throw new Error("That Lock does not exist");
    // Refuse anything the contract's submitFinal would already reject: not joined, already completed,
    // closed, underfilled, or past the submission deadline.
    assertEscrowFinalOpen(pact, "submit");

    const baseline = await loadEscrowBaseline(session.walletAddress, pact.configHash);
    if (!baseline) throw new Error("Verify your starting XP before your final XP");

    // The final proof must be the SAME Duolingo account that was bound on-chain: its HMAC identity has to
    // equal both the stored baseline identity and the identity the contract holds for this participant.
    // No raw profile id is stored, so this account check is purely over the HMAC pseudonym.
    const finalIdentity = duolingoIdentityHash(evidence.profileId);
    if (
      finalIdentity !== (baseline.identityHash as Hex)
        || pact.participantIdentity !== (baseline.identityHash as Hex)
    ) {
      throw new Error("The final proof is a different Duolingo account than the baseline");
    }

    // The final must have been observed inside the challenge window; the contract enforces this too, so
    // this only avoids signing a doomed attestation.
    const endsAt = pact.startsAt + pact.durationSeconds;
    if (evidence.observedAt < pact.startsAt || evidence.observedAt > endsAt) {
      throw new Error("The final proof is outside the challenge window");
    }

    const delta = validateDuolingoDelta({
      baseline: {
        // Same account as the final, already proven above via the HMAC identity; the delta validator only
        // uses totalXp, observedAt and the identity/nullifier, never a raw profile id.
        profileId: evidence.profileId,
        totalXp: baseline.baselineXp,
        identityHash: evidence.identityHash,
        eventNullifier: ZERO_HASH,
        observedAt: baseline.baselineObservedAt,
        sessionId,
        phase: "baseline",
      },
      final: evidence,
      targetXp: pact.targetXp,
    });

    const attestation = await buildFinalAttestation({
      account: session.walletAddress as Hex,
      profileId: evidence.profileId,
      pactId,
      earnedXp: delta.earnedXp,
      targetXp: pact.targetXp,
      occurredAt: evidence.observedAt,
    });

    if (!(await consumeAndSaveFinal({
      sessionId,
      walletAddress: session.walletAddress,
      pactId: session.pactId as string,
      identityHash: attestation.identityHash,
      earnedXp: delta.earnedXp,
      targetXp: pact.targetXp,
      finalXp: delta.finalXp,
      finalObservedAt: evidence.observedAt,
      nullifier: attestation.nullifier,
    }))) {
      throw new Error("This proof has already been recorded. Start a new final to try again.");
    }

    return NextResponse.json({
      phase: "final",
      targetXp: pact.targetXp,
      baselineXp: delta.baselineXp,
      finalXp: delta.finalXp,
      earnedXp: delta.earnedXp,
      passed: true,
      observedAt: evidence.observedAt,
      pactId: session.pactId,
      attestation: serialiseFinal(attestation),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EscrowAccessError || error instanceof EscrowChainUnavailableError) {
      const status = error instanceof EscrowAccessError ? error.status : 503;
      return NextResponse.json({ error: error.message }, { status, headers: { "Cache-Control": "no-store" } });
    }
    const authStatus = walletAuthErrorStatus(error);
    const message = authStatus
      ? walletAuthPublicMessage(error)
      : error instanceof DuolingoPolicyError || error instanceof Error
        ? error.message
        : "The Duolingo proof was rejected";
    return NextResponse.json({ error: message }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
  }
}

// bigint is not JSON-serialisable; the client submits these as strings and viem parses them back.
function serialiseBaseline(a: {
  configHash: Hex; identityHash: Hex; nullifier: Hex; issuedAt: bigint; expiresAt: bigint; signature: Hex;
}) {
  return {
    configHash: a.configHash,
    identityHash: a.identityHash,
    nullifier: a.nullifier,
    issuedAt: a.issuedAt.toString(),
    expiresAt: a.expiresAt.toString(),
    signature: a.signature,
  };
}

function serialiseFinal(a: {
  identityHash: Hex; earnedXp: number; targetXp: number; nullifier: Hex; occurredAt: bigint; issuedAt: bigint; expiresAt: bigint; signature: Hex;
}) {
  return {
    identityHash: a.identityHash,
    earnedXp: a.earnedXp,
    targetXp: a.targetXp,
    nullifier: a.nullifier,
    occurredAt: a.occurredAt.toString(),
    issuedAt: a.issuedAt.toString(),
    expiresAt: a.expiresAt.toString(),
    signature: a.signature,
  };
}
