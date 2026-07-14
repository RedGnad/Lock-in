import { NextResponse } from "next/server";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  transformForOnchain,
  verifyProof,
  type Proof,
} from "@reclaimprotocol/js-sdk";
import { loadOnchainPactPolicy } from "@/src/pact-server";
import { verifyProofSessionToken } from "@/src/session-token";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { proofSetHash, signCompletion } from "@/src/completion-attestation";
import { lockInAbi } from "@/src/lock-in-abi";
import { readJsonBody } from "@/src/api-guard";
import {
  assertFreshProofTimestamps,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
  validateStravaEvidence,
} from "@/src/strava-proof-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function assertConfiguredEvidenceSigner(privateKey: Hex, contract: Address): Promise<void> {
  const configured = await lockInPublicClient().readContract({
    address: contract,
    abi: lockInAbi,
    functionName: "evidenceSigner",
  });
  if (privateKeyToAccount(privateKey).address !== getAddress(configured)) {
    throw new Error("EVIDENCE_SIGNER_PRIVATE_KEY does not match the escrow contract");
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ token?: string; proofs?: Proof | Proof[] }>(request, 2 * 1_024 * 1_024);
    const token = verifyProofSessionToken(body.token || "");
    const proofs = Array.isArray(body.proofs) ? body.proofs : body.proofs ? [body.proofs] : [];
    if (proofs.length !== 4) throw new Error("The Strava v2 provider must return exactly four proofs");

    const policy = await loadOnchainPactPolicy(token);
    const appSecret = process.env.SECRET?.trim();
    if (!appSecret) throw new Error("SECRET is not configured");
    const result = await verifyProof(proofs, {
      providerId: STRAVA_PROVIDER_ID,
      providerVersion: STRAVA_PROVIDER_VERSION,
      allowedTags: [],
      teeAttestation: { appSecret },
    });
    if (!result.isVerified || !result.isTeeAttestationVerified) {
      throw new Error(result.error?.message || "Reclaim or TEE verification failed");
    }
    assertFreshProofTimestamps(proofs.map((proof) => Number(proof.claimData.timestampS)));
    const evidence = validateStravaEvidence(result.data, {
      ...policy,
      challenge: policy.proofCode,
      expectedSessionId: token.sessionId,
    });
    if (!escrowAddress) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS is not configured");
    const signerPrivateKey = (
      process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() ||
      process.env.RECLAIM_PRIVATE_KEY?.trim()
    ) as Hex | undefined;
    if (!signerPrivateKey) throw new Error("EVIDENCE_SIGNER_PRIVATE_KEY is not configured");
    await assertConfiguredEvidenceSigner(signerPrivateKey, escrowAddress);
    const expiresAt = BigInt(Math.min(
      Math.floor(Date.now() / 1_000) + 5 * 60,
      Math.floor(policy.claimDeadlineMs / 1_000),
    ));
    const completion = {
      pactId: BigInt(policy.pactId),
      account: getAddress(policy.walletAddress),
      dayIndex: policy.dayIndex,
      activityNullifier: evidence.nullifier,
      proofSetHash: proofSetHash(proofs),
      expiresAt,
    };
    const validatorSignature = await signCompletion({
      privateKey: signerPrivateKey,
      chainId: 143,
      verifyingContract: escrowAddress,
      completion,
    });

    return NextResponse.json({
      verified: true,
      evidence: {
        distanceMeters: evidence.distanceMeters,
        startTime: evidence.startTime,
        flagged: evidence.flagged,
        movingTimeSeconds: evidence.movingTimeSeconds,
        elapsedTimeSeconds: evidence.elapsedTimeSeconds,
        elevationGainMeters: evidence.elevationGainMeters,
        hasGps: evidence.hasGps,
        trainer: evidence.trainer,
      },
      onchainProofs: proofs.map(transformForOnchain),
      attestation: {
        proofSetHash: completion.proofSetHash,
        expiresAt: expiresAt.toString(),
        validatorSignature,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proof verification failed" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
