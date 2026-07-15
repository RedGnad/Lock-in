import { NextResponse } from "next/server";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { readJsonBody } from "@/src/api-guard";
import { checkReclaimRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { proofSetHash, signBaseline, signCompletion } from "@/src/completion-attestation";
import { DUOLINGO_XP_MISSION, lockInAbi } from "@/src/lock-in-abi";
import { loadProofPolicyV5 } from "@/src/pact-server-v5";
import { verifyProofSessionV5 } from "@/src/proof-session-v5";
import {
  DUOLINGO_PROVIDER_VERSION,
  validateDuolingoEvidence,
} from "@/src/duolingo-proof-policy";
import {
  assertFreshProofTimestamps,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
  validateStravaEvidence,
  type ReclaimTrustedData,
} from "@/src/strava-proof-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function signerKey(): Promise<Hex> {
  if (!escrowAddress) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS is not configured");
  const privateKey = process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
  if (!privateKey) throw new Error("EVIDENCE_SIGNER_PRIVATE_KEY is not configured");
  const configured = await lockInPublicClient().readContract({
    address: escrowAddress,
    abi: lockInAbi,
    functionName: "evidenceSigner",
  });
  if (privateKeyToAccount(privateKey).address !== getAddress(configured)) {
    throw new Error("EVIDENCE_SIGNER_PRIVATE_KEY does not match the escrow contract");
  }
  return privateKey;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ token?: string; proofs?: Proof | Proof[] }>(request, 2 * 1_024 * 1_024);
    const token = verifyProofSessionV5(body.token || "");
    const rateLimit = checkReclaimRateLimit("verify", request, token.sessionId);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many verification attempts for this proof session." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rateLimit),
      });
    }
    const proofs = Array.isArray(body.proofs) ? body.proofs : body.proofs ? [body.proofs] : [];
    const expectedCount = token.missionType === DUOLINGO_XP_MISSION ? 1 : 4;
    if (proofs.length !== expectedCount) throw new Error(`This provider must return exactly ${expectedCount} proof${expectedCount === 1 ? "" : "s"}`);

    const policy = await loadProofPolicyV5({
      walletAddress: token.walletAddress,
      pactId: token.pactId,
      phase: token.phase,
      intent: token.intent,
      dayIndex: token.dayIndex,
      missionType: token.missionType,
    });
    if (
      policy.missionType !== token.missionType || policy.dailyTarget !== token.dailyTarget
        || policy.ownershipCode !== token.ownershipCode || policy.proofCode !== token.proofCode
    ) throw new Error("The onchain pact policy changed");

    const appSecret = process.env.SECRET?.trim();
    if (!appSecret) throw new Error("SECRET is not configured");
    const expectedVersion = token.missionType === DUOLINGO_XP_MISSION
      ? DUOLINGO_PROVIDER_VERSION
      : STRAVA_PROVIDER_VERSION;
    const expectedProvider = token.missionType === DUOLINGO_XP_MISSION ? token.providerId : STRAVA_PROVIDER_ID;
    if (token.providerVersion !== expectedVersion) throw new Error("Unexpected provider version");
    const result = await verifyProof(proofs, {
      providerId: expectedProvider,
      providerVersion: expectedVersion,
      allowedTags: [],
      teeAttestation: { appSecret },
    });
    if (!result.isVerified || !result.isTeeAttestationVerified) {
      throw new Error(result.error?.message || "Reclaim or TEE verification failed");
    }
    const timestamps = proofs.map((proof) => Number(proof.claimData.timestampS));
    assertFreshProofTimestamps(timestamps);
    const trustedData = result.data as ReclaimTrustedData[];
    const hash = proofSetHash(proofs);
    const privateKey = await signerKey();
    if (!escrowAddress) throw new Error("Escrow is not configured");
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = BigInt(now + 5 * 60);

    if (token.missionType === DUOLINGO_XP_MISSION) {
      const evidence = validateDuolingoEvidence({
        data: trustedData,
        timestamps,
        providerId: token.providerId,
        policy: {
          walletAddress: policy.walletAddress,
          pactId: policy.pactId,
          phase: policy.phase,
          dayIndex: policy.dayIndex,
          expectedSessionId: token.sessionId,
          expectedOwnershipCode: policy.ownershipCode || "",
        },
      });
      if (evidence.observedAt * 1_000 < policy.startsAtMs || evidence.observedAt * 1_000 >= policy.endsAtMs) {
        throw new Error("The Duolingo snapshot is outside the accepted window");
      }
      if (token.phase === "baseline") {
        const baseline = {
          pactId: BigInt(token.pactId),
          account: getAddress(token.walletAddress),
          identityHash: evidence.identityHash,
          totalMetric: BigInt(evidence.totalXp),
          proofHash: hash,
          observedAt: BigInt(evidence.observedAt),
          expiresAt,
        };
        return NextResponse.json({
          verified: true,
          phase: "baseline",
          summary: { username: evidence.username, totalXp: evidence.totalXp },
          evidence: {
            identityHash: baseline.identityHash,
            totalMetric: baseline.totalMetric.toString(),
            proofHash: baseline.proofHash,
            observedAt: baseline.observedAt.toString(),
            expiresAt: baseline.expiresAt.toString(),
            signature: await signBaseline({ privateKey, chainId: 143, verifyingContract: escrowAddress, baseline }),
          },
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const completion = {
        pactId: BigInt(token.pactId),
        account: getAddress(token.walletAddress),
        dayIndex: token.dayIndex!,
        missionType: token.missionType,
        identityHash: evidence.identityHash,
        eventNullifier: evidence.eventNullifier,
        metric: BigInt(evidence.totalXp),
        proofHash: hash,
        occurredAt: BigInt(evidence.observedAt),
        expiresAt,
      };
      return NextResponse.json({
        verified: true,
        phase: "completion",
        summary: { username: evidence.username, totalXp: evidence.totalXp },
        evidence: {
          identityHash: completion.identityHash,
          eventNullifier: completion.eventNullifier,
          metric: completion.metric.toString(),
          proofHash: completion.proofHash,
          occurredAt: completion.occurredAt.toString(),
          expiresAt: completion.expiresAt.toString(),
          signature: await signCompletion({ privateKey, chainId: 143, verifyingContract: escrowAddress, completion }),
        },
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const evidence = validateStravaEvidence(trustedData, {
      walletAddress: policy.walletAddress,
      pactId: policy.pactId,
      dayIndex: policy.dayIndex!,
      challenge: policy.proofCode || "",
      expectedSessionId: token.sessionId,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
      minDistanceMeters: policy.dailyTarget,
    });
    const completion = {
      pactId: BigInt(token.pactId),
      account: getAddress(token.walletAddress) as Address,
      dayIndex: token.dayIndex!,
      missionType: token.missionType,
      identityHash: evidence.identityHash,
      eventNullifier: evidence.nullifier,
      metric: BigInt(evidence.distanceMeters),
      proofHash: hash,
      occurredAt: BigInt(Math.floor(evidence.startTimeMs / 1_000)),
      expiresAt,
    };
    return NextResponse.json({
      verified: true,
      phase: "completion",
      summary: { distanceMeters: evidence.distanceMeters, startTime: evidence.startTime },
      evidence: {
        identityHash: completion.identityHash,
        eventNullifier: completion.eventNullifier,
        metric: completion.metric.toString(),
        proofHash: completion.proofHash,
        occurredAt: completion.occurredAt.toString(),
        expiresAt: completion.expiresAt.toString(),
        signature: await signCompletion({ privateKey, chainId: 143, verifyingContract: escrowAddress, completion }),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Proof verification failed" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
