import { NextResponse } from "next/server";
import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import { readJsonBody } from "@/src/api-guard";
import { checkReclaimRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { loadProofPolicy } from "@/src/pact-server";
import { issueProofSession } from "@/src/proof-session";
import { DUOLINGO_PROVIDER_VERSION, duolingoProviderId } from "@/src/duolingo-proof-policy";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "@/src/strava-proof-policy";
import { DUOLINGO_XP_MISSION } from "@/src/lock-in-abi";
import { resolvePublicDuolingoProfile } from "@/src/duolingo-profile";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1_024);
    const walletAddress = String(body.walletAddress || "");
    const walletSession = requireWalletAuthSession(request, walletAddress);
    const rateLimit = checkReclaimRateLimit("session", request, walletSession.walletAddress);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many proof sessions. Try again later." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rateLimit),
      });
    }
    const phase = body.phase === "baseline" ? "baseline" : body.phase === "completion" ? "completion" : null;
    if (!phase) throw new Error("Invalid proof phase");
    const intent = body.intent === "create" || body.intent === "join" ? body.intent : undefined;
    if (!isProofActionEnabled(readProductFlagState(), { phase, intent })) {
      return NextResponse.json({ error: "Proof verification is paused. Settlement and claims remain available." }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const policy = await loadProofPolicy({
      walletAddress: walletSession.walletAddress,
      pactId: String(body.pactId || ""),
      phase,
      intent,
      dayIndex: body.dayIndex === undefined ? undefined : Number(body.dayIndex),
      missionType: body.missionType === undefined ? undefined : Number(body.missionType),
    });
    const isDuolingo = policy.missionType === DUOLINGO_XP_MISSION;
    const providerId = isDuolingo ? duolingoProviderId() : STRAVA_PROVIDER_ID;
    const providerVersion = isDuolingo ? DUOLINGO_PROVIDER_VERSION : STRAVA_PROVIDER_VERSION;
    const proofRequest = await ReclaimProofRequest.init(required("ID"), required("SECRET"), providerId, {
      providerVersion,
      acceptTeeAttestation: true,
      canAutoSubmit: true,
      preferredLocale: "en",
    });
    const contextMessage = phase === "baseline" ? `${policy.pactId}:baseline` : `${policy.pactId}:${policy.dayIndex}`;
    proofRequest.setContext(policy.walletAddress.toLowerCase(), contextMessage);
    let duolingoProfileId: string | undefined;
    if (isDuolingo) {
      const username = String(body.username || "").trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error("Enter a valid Duolingo username");
      const profile = await resolvePublicDuolingoProfile(username);
      duolingoProfileId = profile.id;
      proofRequest.setParams({ duolingo_user_id: profile.id });
    } else {
      if (!policy.proofCode) throw new Error("Strava proof code is missing");
      proofRequest.setParams({ context_challenge: policy.proofCode });
    }
    const sessionId = proofRequest.getSessionId();
    const token = issueProofSession({
      sessionId,
      walletAddress: policy.walletAddress,
      pactId: policy.pactId,
      missionType: policy.missionType,
      phase: policy.phase,
      intent: policy.intent,
      dayIndex: policy.dayIndex,
      providerId,
      providerVersion,
      duolingoProfileId,
      proofCode: policy.proofCode,
      dailyTarget: policy.dailyTarget,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
    });

    return NextResponse.json({
      requestUrl: await proofRequest.getRequestUrl(),
      sessionId,
      token,
      providerVersion,
      proofCode: policy.proofCode,
      instruction: isDuolingo
        ? "Sign in to Duolingo if asked, then continue. Your profile name will not be changed."
        : `Set the title of your Strava GPS run to exactly ${policy.proofCode}.`,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : error instanceof Error ? error.message : "Could not create proof session",
    }, {
      status: authStatus || 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
