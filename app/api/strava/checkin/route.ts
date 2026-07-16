import { NextResponse } from "next/server";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readJsonBody } from "@/src/api-guard";
import { escrowAddress, lockInPublicClient, monad } from "@/src/chain";
import { signCompletion } from "@/src/completion-attestation";
import { lockInAbi, STRAVA_RUN_MISSION } from "@/src/lock-in-abi";
import { loadProofPolicy } from "@/src/pact-server";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";
import { checkRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import {
  fetchStravaActivities,
  selectQualifyingRun,
  StravaActivityError,
  STRAVA_ATTESTATION_SCHEME,
} from "@/src/strava-activities";
import { refreshStravaTokens } from "@/src/strava-oauth";
import { getUsableStravaAccessToken } from "@/src/strava-token-store";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Checks a Lock day in, reading the run from Strava over the athlete's OAuth grant.
 *
 * This is the whole of the verification. Under STRAVA_OAUTH_V1 there is no independent on-chain witness to
 * cross-check us, so the escrow accepts this signature as sufficient. The evidence signer is therefore a
 * trusted party for Strava completions, which the zkTLS path it replaced deliberately avoided.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 8 * 1_024);
    const walletSession = requireWalletAuthSession(request, String(body.walletAddress || ""));
    const rateLimit = checkRateLimit("verify", request, walletSession.walletAddress);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many check-ins. Try again shortly." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rateLimit),
      });
    }
    if (!isProofActionEnabled(readProductFlagState(), { phase: "completion" })) {
      return NextResponse.json({ error: "Check-ins are paused. Settlement and claims remain available." }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!escrowAddress) throw new Error("The escrow is not configured");

    // The Lock decides the day window and the target, read from chain: never from the caller.
    const policy = await loadProofPolicy({
      walletAddress: walletSession.walletAddress,
      pactId: String(body.pactId || ""),
      phase: "completion",
      dayIndex: body.dayIndex === undefined ? undefined : Number(body.dayIndex),
      missionType: STRAVA_RUN_MISSION,
    });
    if (policy.missionType !== STRAVA_RUN_MISSION || policy.dayIndex === undefined) {
      throw new Error("This Lock is not a Strava run");
    }

    const connection = await getUsableStravaAccessToken(
      walletSession.walletAddress,
      (refreshToken) => refreshStravaTokens(refreshToken),
    );

    const activities = await fetchStravaActivities({
      accessToken: connection.accessToken,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
    });
    const run = selectQualifyingRun(activities, {
      athleteId: connection.athleteId,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
      minDistanceMeters: policy.dailyTarget,
    });

    const account = getAddress(walletSession.walletAddress) as Address;
    const pactId = BigInt(policy.pactId);
    const policyHash = await lockInPublicClient().readContract({
      address: escrowAddress,
      abi: lockInAbi,
      functionName: "missionPolicyHash",
      args: [STRAVA_RUN_MISSION],
    });

    const privateKey = process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
    if (!privateKey) throw new Error("The evidence signer is not configured");
    const configured = await lockInPublicClient().readContract({
      address: escrowAddress,
      abi: lockInAbi,
      functionName: "evidenceSigner",
    });
    if (privateKeyToAccount(privateKey).address !== getAddress(configured)) {
      throw new Error("The evidence signer does not match the deployed escrow");
    }

    const observedAt = BigInt(Math.floor(Date.now() / 1_000));
    const occurredAt = BigInt(Math.floor(run.startTimeMs / 1_000));
    const completion = {
      pactId,
      account,
      dayIndex: policy.dayIndex,
      missionType: STRAVA_RUN_MISSION,
      policyHash: policyHash as Hex,
      // No Reclaim session exists any more; this names the scheme that produced the evidence.
      sessionIdHash: keccak256(stringToHex(`${STRAVA_ATTESTATION_SCHEME}:${run.activityId}`)),
      identityHash: run.identityHash,
      eventNullifier: run.nullifier,
      metric: BigInt(run.distanceMeters),
      proofSetHash: run.activityHash,
      occurredAt,
      // These bounded the freshness of a zkTLS proof. Here they record when WE observed Strava's answer.
      oldestProofTimestamp: Number(observedAt),
      newestProofTimestamp: Number(observedAt),
      movingTimeSeconds: BigInt(run.movingTimeSeconds),
      elapsedTimeSeconds: BigInt(run.elapsedTimeSeconds),
      elevationGainMeters: BigInt(run.elevationGainMeters),
      issuedAt: observedAt,
      expiresAt: observedAt + 600n,
    };

    const signature = await signCompletion({
      privateKey,
      chainId: monad.id,
      verifyingContract: escrowAddress,
      completion,
    });

    return NextResponse.json({
      evidence: {
        ...completion,
        pactId: completion.pactId.toString(),
        metric: completion.metric.toString(),
        occurredAt: completion.occurredAt.toString(),
        movingTimeSeconds: completion.movingTimeSeconds.toString(),
        elapsedTimeSeconds: completion.elapsedTimeSeconds.toString(),
        elevationGainMeters: completion.elevationGainMeters.toString(),
        issuedAt: completion.issuedAt.toString(),
        expiresAt: completion.expiresAt.toString(),
      },
      signature,
      run: {
        activityId: run.activityId,
        name: run.activityName,
        distanceMeters: run.distanceMeters,
        movingTimeSeconds: run.movingTimeSeconds,
        startedAt: new Date(run.startTimeMs).toISOString(),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StravaActivityError) {
      // These are the athlete's own situation, not a fault: say exactly which rule was not met.
      return NextResponse.json({ error: error.message, code: error.code }, {
        status: error.code === "STRAVA_UNAUTHORIZED" ? 401 : 422,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : error instanceof Error ? error.message : "Check-in failed",
    }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
  }
}
