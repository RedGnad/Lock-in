import { NextResponse } from "next/server";
import { fetchStatusUrl, verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { getAddress, keccak256, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readJsonBody } from "@/src/api-guard";
import { checkReclaimRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { escrowAddress, lockInPublicClient, monad } from "@/src/chain";
import { attestationExpiry, proofSetHash, signBaseline, signCompletion } from "@/src/completion-attestation";
import { DUOLINGO_XP_MISSION, lockInAbi, STRAVA_RUN_MISSION, type PactTuple } from "@/src/lock-in-abi";
import { loadProofPolicy } from "@/src/pact-server";
import { verifyProofSession, type ProofSession } from "@/src/proof-session";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";
import {
  DUOLINGO_PROVIDER_HASH,
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  validateDuolingoEvidence,
} from "@/src/duolingo-proof-policy";
import {
  assertFreshProofTimestamps,
  canonicalizeStravaProofs,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
  validateStravaEvidence,
  type ReclaimTrustedData,
} from "@/src/strava-proof-policy";
import {
  asDirectDuolingoEvidence,
  asDirectStravaEvidence,
  assertAddress,
  assertDuolingoDirectParity,
  assertHash,
  assertPinnedHybridDeployment,
  assertSdkProofSet,
  assertStravaDirectParity,
  DUOLINGO_MAX_SIGNED_JSON_BYTES,
  duolingoCompletionNullifier,
  duolingoVerifierAbi,
  HybridReleaseUnavailableError,
  ReclaimProofRejectedError,
  sessionIdHash,
  STRAVA_MAX_SIGNED_JSON_BYTES,
  stravaParserAbi,
  stravaVerifierAbi,
  toDirectProofBundle,
  type DirectProofBundle,
} from "@/src/reclaim-onchain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type HybridConfiguration = Readonly<{
  policyHash: Hash;
  stravaVerifier: Address;
  duolingoVerifier: Address;
}>;

function unavailable(message: string): never {
  throw new HybridReleaseUnavailableError(message);
}

async function signerKey(): Promise<Hex> {
  if (!escrowAddress) unavailable("Escrow is absent");
  const privateKey = process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
  if (!privateKey) unavailable("Evidence signer is absent");
  let configured: Address;
  try {
    configured = await lockInPublicClient().readContract({
      address: escrowAddress,
      abi: lockInAbi,
      functionName: "evidenceSigner",
    });
  } catch {
    return unavailable("Evidence signer cannot be read");
  }
  if (privateKeyToAccount(privateKey).address !== getAddress(configured)) unavailable("Evidence signer mismatch");
  return privateKey;
}

async function readHybridConfiguration(token: ProofSession): Promise<HybridConfiguration> {
  if (!escrowAddress) unavailable("Escrow is absent");
  const client = lockInPublicClient();
  try {
    const configuredEscrowCodeHash = assertHash(
      process.env.LOCK_IN_ESCROW_CODE_HASH?.trim(),
      "Configured escrow code hash",
    );
    const configuredStravaVerifier = assertAddress(
      process.env.LOCK_IN_STRAVA_VERIFIER_ADDRESS?.trim(),
      "Configured Strava verifier",
    );
    const configuredDuolingoVerifier = assertAddress(
      process.env.LOCK_IN_DUOLINGO_VERIFIER_ADDRESS?.trim(),
      "Configured Duolingo verifier",
    );
    const configuredStravaParser = assertAddress(
      process.env.LOCK_IN_STRAVA_PARSER_ADDRESS?.trim(),
      "Configured Strava parser",
    );
    const configuredStravaCodeHash = assertHash(
      process.env.LOCK_IN_STRAVA_VERIFIER_CODE_HASH?.trim(),
      "Configured Strava verifier code hash",
    );
    const configuredDuolingoCodeHash = assertHash(
      process.env.LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH?.trim(),
      "Configured Duolingo verifier code hash",
    );
    const configuredParserCodeHash = assertHash(
      process.env.LOCK_IN_STRAVA_PARSER_CODE_HASH?.trim(),
      "Configured Strava parser code hash",
    );
    const configuredWitnessValue = process.env.RECLAIM_WITNESS_ADDRESS?.trim();
    const configuredWitness = configuredWitnessValue
      ? assertAddress(configuredWitnessValue, "Configured Reclaim witness")
      : undefined;
    const [chainId, escrowCode, schemaId, stravaAddressRaw, duolingoAddressRaw, policyHashRaw] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: escrowAddress }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "CONTRACT_SCHEMA_ID" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "stravaVerifier" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "duolingoVerifier" }),
      client.readContract({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "missionPolicyHash",
        args: [token.missionType],
      }),
    ]);
    if (chainId !== monad.id || !escrowCode || escrowCode === "0x" || schemaId !== 1n) unavailable("Escrow schema is absent");
    if (keccak256(escrowCode).toLowerCase() !== configuredEscrowCodeHash.toLowerCase()) {
      unavailable("Escrow bytecode mismatch");
    }
    const stravaVerifier = assertAddress(stravaAddressRaw, "Strava verifier");
    const duolingoVerifier = assertAddress(duolingoAddressRaw, "Duolingo verifier");
    const policyHash = assertHash(policyHashRaw, "Mission policy");

    const [
      stravaCode,
      duoCode,
      stravaLive,
      stravaProviderId,
      stravaProviderVersion,
      stravaWitness,
      parserRaw,
      duoLive,
      duoProviderId,
      duoProviderVersion,
      duoProviderHash,
      duoWitness,
    ] = await Promise.all([
      client.getCode({ address: stravaVerifier }),
      client.getCode({ address: duolingoVerifier }),
      client.readContract({ address: stravaVerifier, abi: stravaVerifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
      client.readContract({ address: stravaVerifier, abi: stravaVerifierAbi, functionName: "STRAVA_PROVIDER_ID" }),
      client.readContract({ address: stravaVerifier, abi: stravaVerifierAbi, functionName: "STRAVA_PROVIDER_VERSION" }),
      client.readContract({ address: stravaVerifier, abi: stravaVerifierAbi, functionName: "WITNESS" }),
      client.readContract({ address: stravaVerifier, abi: stravaVerifierAbi, functionName: "PARSER" }),
      client.readContract({ address: duolingoVerifier, abi: duolingoVerifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
      client.readContract({ address: duolingoVerifier, abi: duolingoVerifierAbi, functionName: "DUOLINGO_PROVIDER_ID" }),
      client.readContract({ address: duolingoVerifier, abi: duolingoVerifierAbi, functionName: "DUOLINGO_PROVIDER_VERSION" }),
      client.readContract({ address: duolingoVerifier, abi: duolingoVerifierAbi, functionName: "DUOLINGO_PROVIDER_HASH" }),
      client.readContract({ address: duolingoVerifier, abi: duolingoVerifierAbi, functionName: "WITNESS" }),
    ]);
    if (!stravaCode || stravaCode === "0x" || !duoCode || duoCode === "0x") unavailable("Verifier code is absent");
    if (
      keccak256(stravaCode).toLowerCase() !== configuredStravaCodeHash.toLowerCase()
        || keccak256(duoCode).toLowerCase() !== configuredDuolingoCodeHash.toLowerCase()
    ) {
      unavailable("Verifier bytecode mismatch");
    }
    if (!stravaLive || !duoLive) unavailable("Live Reclaim schema is not confirmed");
    if (stravaProviderId !== STRAVA_PROVIDER_ID || stravaProviderVersion !== STRAVA_PROVIDER_VERSION) {
      unavailable("Strava schema mismatch");
    }
    if (
      duoProviderId !== DUOLINGO_PROVIDER_ID
        || duoProviderVersion !== DUOLINGO_PROVIDER_VERSION
        || duoProviderHash !== DUOLINGO_PROVIDER_HASH
    ) unavailable("Duolingo schema mismatch");
    if (getAddress(stravaWitness) === zeroAddress || getAddress(duoWitness) === zeroAddress) unavailable("Witness is absent");
    assertPinnedHybridDeployment({
      observedStravaVerifier: stravaVerifier,
      configuredStravaVerifier,
      observedDuolingoVerifier: duolingoVerifier,
      configuredDuolingoVerifier,
      stravaWitness: getAddress(stravaWitness),
      duolingoWitness: getAddress(duoWitness),
      configuredWitness,
    });

    const parser = assertAddress(parserRaw, "Strava parser");
    if (parser !== configuredStravaParser) unavailable("Strava parser address mismatch");
    const [parserCode, parserLive, parserSchema, parserProviderId, parserProviderVersion] = await Promise.all([
      client.getCode({ address: parser }),
      client.readContract({ address: parser, abi: stravaParserAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
      client.readContract({ address: parser, abi: stravaParserAbi, functionName: "SCHEMA_ID" }),
      client.readContract({ address: parser, abi: stravaParserAbi, functionName: "STRAVA_PROVIDER_ID" }),
      client.readContract({ address: parser, abi: stravaParserAbi, functionName: "STRAVA_PROVIDER_VERSION" }),
    ]);
    if (!parserCode || parserCode === "0x" || !parserLive || parserSchema === `0x${"00".repeat(32)}`) {
      unavailable("Strava parser schema is absent");
    }
    if (keccak256(parserCode).toLowerCase() !== configuredParserCodeHash.toLowerCase()) {
      unavailable("Strava parser bytecode mismatch");
    }
    if (parserProviderId !== STRAVA_PROVIDER_ID || parserProviderVersion !== STRAVA_PROVIDER_VERSION) {
      unavailable("Strava parser schema mismatch");
    }

    if (token.pactId !== "0") {
      const pact = await client.readContract({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "pacts",
        args: [BigInt(token.pactId)],
      }) as PactTuple;
      if (pact[0] === zeroAddress || pact[11] !== token.missionType || pact[13] !== policyHash) {
        unavailable("Lock mission policy mismatch");
      }
    }
    return { policyHash, stravaVerifier, duolingoVerifier };
  } catch (error) {
    if (error instanceof HybridReleaseUnavailableError) throw error;
    return unavailable("Hybrid release configuration cannot be verified");
  }
}

async function refetchProofs(token: ProofSession): Promise<Proof[]> {
  let status;
  try {
    status = await fetchStatusUrl(token.sessionId);
  } catch {
    throw new ReclaimProofRejectedError("Reclaim session cannot be fetched");
  }
  if (status.session?.sessionId !== token.sessionId || !status.session?.proofs) {
    throw new ReclaimProofRejectedError("Reclaim session is not complete");
  }
  const isDuolingo = token.missionType === DUOLINGO_XP_MISSION;
  const proofs = assertSdkProofSet(status.session.proofs, {
    expectedCount: isDuolingo ? 1 : 4,
    maxSignedJsonBytes: isDuolingo ? DUOLINGO_MAX_SIGNED_JSON_BYTES : STRAVA_MAX_SIGNED_JSON_BYTES,
  });
  return isDuolingo ? proofs : canonicalizeStravaProofs(proofs);
}

async function directDuolingo(input: {
  verifier: Address;
  directProof: DirectProofBundle;
  token: ProofSession;
}) {
  if (!escrowAddress || input.directProof.proofs.length !== 1) throw new ReclaimProofRejectedError();
  try {
    const output = await lockInPublicClient().readContract({
      address: input.verifier,
      abi: duolingoVerifierAbi,
      functionName: "validateDuolingoProof",
      args: [
        input.directProof.proofs[0],
        getAddress(input.token.walletAddress),
        BigInt(input.token.pactId),
        input.token.phase === "baseline",
        input.token.phase === "baseline" ? 0 : input.token.dayIndex!,
        input.directProof.sessionId,
      ],
    });
    return asDirectDuolingoEvidence(output);
  } catch (error) {
    if (error instanceof ReclaimProofRejectedError) throw error;
    throw new ReclaimProofRejectedError("Direct Duolingo verification reverted");
  }
}

async function directStrava(input: {
  verifier: Address;
  directProof: DirectProofBundle;
  token: ProofSession;
  startsAtMs: number;
  endsAtMs: number;
  dailyTarget: number;
  challenge: string;
}) {
  if (!escrowAddress || input.directProof.proofs.length !== 4 || input.token.dayIndex === undefined) {
    throw new ReclaimProofRejectedError();
  }
  try {
    const output = await lockInPublicClient().readContract({
      address: input.verifier,
      abi: stravaVerifierAbi,
      functionName: "validateStravaProofs",
      args: [input.directProof.proofs, {
        account: getAddress(input.token.walletAddress),
        pactId: BigInt(input.token.pactId),
        dayIndex: input.token.dayIndex,
        expectedSessionId: input.directProof.sessionId,
        challenge: input.challenge,
        startsAt: BigInt(Math.floor(input.startsAtMs / 1_000)),
        endsAt: BigInt(Math.floor(input.endsAtMs / 1_000)),
        minDistanceMeters: BigInt(input.dailyTarget),
      }],
    });
    return asDirectStravaEvidence(output);
  } catch (error) {
    if (error instanceof ReclaimProofRejectedError) throw error;
    throw new ReclaimProofRejectedError("Direct Strava verification reverted");
  }
}

function jsonEvidence(input: Record<string, string | number>) {
  return input;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 32 * 1_024);
    if (Object.keys(body).some((key) => key !== "token")) throw new ReclaimProofRejectedError("Unexpected request fields");
    const token = verifyProofSession(typeof body.token === "string" ? body.token : "");
    requireWalletAuthSession(request, token.walletAddress);
    if (!isProofActionEnabled(readProductFlagState(), token)) {
      return NextResponse.json({ error: "Proof verification is paused. Settlement and claims remain available." }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const rateLimit = checkReclaimRateLimit("verify", request, token.sessionId);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many verification attempts for this proof session." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rateLimit),
      });
    }

    const configuration = await readHybridConfiguration(token);
    const policy = await loadProofPolicy({
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
    ) throw new ReclaimProofRejectedError("Lock policy changed");

    const proofs = await refetchProofs(token);
    const appSecret = process.env.SECRET?.trim();
    if (!appSecret) unavailable("Reclaim secret is absent");
    const isDuolingo = token.missionType === DUOLINGO_XP_MISSION;
    const expectedProvider = isDuolingo ? DUOLINGO_PROVIDER_ID : STRAVA_PROVIDER_ID;
    const expectedVersion = isDuolingo ? DUOLINGO_PROVIDER_VERSION : STRAVA_PROVIDER_VERSION;
    if (token.providerId !== expectedProvider || token.providerVersion !== expectedVersion) {
      throw new ReclaimProofRejectedError("Provider mismatch");
    }
    const verified = await verifyProof(proofs, {
      providerId: expectedProvider,
      providerVersion: expectedVersion,
      allowedTags: [],
      teeAttestation: { appSecret },
    });
    if (!verified.isVerified || !verified.isTeeAttestationVerified) throw new ReclaimProofRejectedError("SDK or TEE verification failed");
    if (!Array.isArray(verified.data) || verified.data.length !== proofs.length) {
      throw new ReclaimProofRejectedError("Trusted data count mismatch");
    }

    const client = lockInPublicClient();
    const latest = await client.getBlock({ blockTag: "latest" });
    const issuedAt = latest.timestamp;
    const timestamps = proofs.map((proof) => Number(proof.claimData.timestampS));
    assertFreshProofTimestamps(timestamps, Number(issuedAt) * 1_000);
    const expiresAt = attestationExpiry(issuedAt, timestamps);
    const directProof = toDirectProofBundle(token.sessionId, proofs);
    const trustedData = verified.data as ReclaimTrustedData[];
    const transformedProofSetHash = proofSetHash(proofs);
    const privateKey = await signerKey();
    if (!escrowAddress) unavailable("Escrow is absent");
    const account = getAddress(token.walletAddress);
    const sessionHash = sessionIdHash(token.sessionId);

    if (isDuolingo) {
      const policyEvidence = validateDuolingoEvidence({
        data: trustedData,
        timestamps,
        providerId: DUOLINGO_PROVIDER_ID,
        policy: {
          walletAddress: policy.walletAddress,
          pactId: policy.pactId,
          phase: policy.phase,
          dayIndex: policy.dayIndex,
          expectedSessionId: token.sessionId,
          expectedOwnershipCode: policy.ownershipCode || "",
        },
      });
      if (policyEvidence.observedAt * 1_000 < policy.startsAtMs || policyEvidence.observedAt * 1_000 >= policy.endsAtMs) {
        throw new ReclaimProofRejectedError("Duolingo snapshot outside policy window");
      }
      const direct = await directDuolingo({ verifier: configuration.duolingoVerifier, directProof, token });
      assertDuolingoDirectParity({ direct, policy: policyEvidence, proofSetHash: transformedProofSetHash });

      if (token.phase === "baseline") {
        const baseline = {
          pactId: BigInt(token.pactId),
          account,
          missionType: token.missionType,
          policyHash: configuration.policyHash,
          sessionIdHash: sessionHash,
          identityHash: direct.identityHash,
          metric: direct.totalXp,
          proofSetHash: direct.proofSetHash,
          observedAt: BigInt(direct.proofTimestamp),
          issuedAt,
          expiresAt,
        };
        return NextResponse.json({
          verified: true,
          phase: "baseline",
          summary: { username: policyEvidence.username, totalXp: policyEvidence.totalXp },
          evidence: jsonEvidence({
            missionType: baseline.missionType,
            policyHash: baseline.policyHash,
            sessionIdHash: baseline.sessionIdHash,
            identityHash: baseline.identityHash,
            metric: baseline.metric.toString(),
            proofSetHash: baseline.proofSetHash,
            observedAt: baseline.observedAt.toString(),
            issuedAt: baseline.issuedAt.toString(),
            expiresAt: baseline.expiresAt.toString(),
            signature: await signBaseline({ privateKey, chainId: monad.id, verifyingContract: escrowAddress, baseline }),
          }),
          directProof,
        }, { headers: { "Cache-Control": "no-store" } });
      }

      const completion = {
        pactId: BigInt(token.pactId),
        account,
        dayIndex: token.dayIndex!,
        missionType: token.missionType,
        policyHash: configuration.policyHash,
        sessionIdHash: sessionHash,
        identityHash: direct.identityHash,
        eventNullifier: duolingoCompletionNullifier({
          identityHash: direct.identityHash,
          totalXp: direct.totalXp,
          proofSetHash: direct.proofSetHash,
        }),
        metric: direct.totalXp,
        proofSetHash: direct.proofSetHash,
        occurredAt: BigInt(direct.proofTimestamp),
        oldestProofTimestamp: direct.proofTimestamp,
        newestProofTimestamp: direct.proofTimestamp,
        movingTimeSeconds: 0n,
        elapsedTimeSeconds: 0n,
        elevationGainMeters: 0n,
        issuedAt,
        expiresAt,
      };
      return NextResponse.json({
        verified: true,
        phase: "completion",
        summary: { username: policyEvidence.username, totalXp: policyEvidence.totalXp },
        evidence: jsonEvidence({
          missionType: completion.missionType,
          policyHash: completion.policyHash,
          sessionIdHash: completion.sessionIdHash,
          identityHash: completion.identityHash,
          eventNullifier: completion.eventNullifier,
          metric: completion.metric.toString(),
          proofSetHash: completion.proofSetHash,
          occurredAt: completion.occurredAt.toString(),
          oldestProofTimestamp: completion.oldestProofTimestamp,
          newestProofTimestamp: completion.newestProofTimestamp,
          movingTimeSeconds: "0",
          elapsedTimeSeconds: "0",
          elevationGainMeters: "0",
          issuedAt: completion.issuedAt.toString(),
          expiresAt: completion.expiresAt.toString(),
          signature: await signCompletion({ privateKey, chainId: monad.id, verifyingContract: escrowAddress, completion }),
        }),
        directProof,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (token.missionType !== STRAVA_RUN_MISSION || token.dayIndex === undefined) {
      throw new ReclaimProofRejectedError("Unsupported proof mission");
    }
    const onchainChallenge = await client.readContract({
      address: escrowAddress,
      abi: lockInAbi,
      functionName: "stravaChallenge",
      args: [BigInt(token.pactId), account, token.dayIndex],
    });
    if (policy.proofCode !== onchainChallenge || token.proofCode !== onchainChallenge) {
      throw new ReclaimProofRejectedError("Strava challenge mismatch");
    }
    const policyEvidence = validateStravaEvidence(trustedData, {
      walletAddress: policy.walletAddress,
      pactId: policy.pactId,
      dayIndex: policy.dayIndex!,
      challenge: onchainChallenge,
      expectedSessionId: token.sessionId,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
      minDistanceMeters: policy.dailyTarget,
    });
    const direct = await directStrava({
      verifier: configuration.stravaVerifier,
      directProof,
      token,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
      dailyTarget: policy.dailyTarget,
      challenge: onchainChallenge,
    });
    assertStravaDirectParity({
      direct,
      policy: policyEvidence,
      proofSetHash: transformedProofSetHash,
      timestamps,
    });

    const completion = {
      pactId: BigInt(token.pactId),
      account,
      dayIndex: token.dayIndex,
      missionType: token.missionType,
      policyHash: configuration.policyHash,
      sessionIdHash: sessionHash,
      identityHash: direct.identityHash,
      eventNullifier: direct.nullifier,
      metric: direct.distanceMeters,
      proofSetHash: direct.proofSetHash,
      occurredAt: direct.startTime,
      oldestProofTimestamp: direct.oldestProofTimestamp,
      newestProofTimestamp: direct.newestProofTimestamp,
      movingTimeSeconds: direct.movingTimeSeconds,
      elapsedTimeSeconds: direct.elapsedTimeSeconds,
      elevationGainMeters: direct.elevationGainMeters,
      issuedAt,
      expiresAt,
    };
    return NextResponse.json({
      verified: true,
      phase: "completion",
      summary: { distanceMeters: policyEvidence.distanceMeters, startTime: policyEvidence.startTime },
      evidence: jsonEvidence({
        missionType: completion.missionType,
        policyHash: completion.policyHash,
        sessionIdHash: completion.sessionIdHash,
        identityHash: completion.identityHash,
        eventNullifier: completion.eventNullifier,
        metric: completion.metric.toString(),
        proofSetHash: completion.proofSetHash,
        occurredAt: completion.occurredAt.toString(),
        oldestProofTimestamp: completion.oldestProofTimestamp,
        newestProofTimestamp: completion.newestProofTimestamp,
        movingTimeSeconds: completion.movingTimeSeconds.toString(),
        elapsedTimeSeconds: completion.elapsedTimeSeconds.toString(),
        elevationGainMeters: completion.elevationGainMeters.toString(),
        issuedAt: completion.issuedAt.toString(),
        expiresAt: completion.expiresAt.toString(),
        signature: await signCompletion({ privateKey, chainId: monad.id, verifyingContract: escrowAddress, completion }),
      }),
      directProof,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authStatus = walletAuthErrorStatus(error);
    const unavailableStatus = error instanceof HybridReleaseUnavailableError;
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : unavailableStatus
          ? "Proof verification is temporarily unavailable."
          : "The proof could not be verified.",
    }, {
      status: authStatus || (unavailableStatus ? 503 : 400),
      headers: { "Cache-Control": "no-store" },
    });
  }
}
