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
  reclaimChannelInitOptions,
  reclaimChannelLaunchOptions,
  resolveReclaimChannel,
} from "@/src/reclaim-channel";
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
    const channel = resolveReclaimChannel();
    const proofRequest = await ReclaimProofRequest.init(required("ID"), required("SECRET"), providerId, {
      providerVersion,
      acceptTeeAttestation: true,
      // Explicit even though false is the documented default: Lock In only settles proofs produced by
      // the exact deterministic provider version, never by an AI provider path.
      acceptAiProviders: false,
      canAutoSubmit: true,
      preferredLocale: "en",
      ...reclaimChannelInitOptions(channel),
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
    }
    // Strava takes no parameter: 7.0.0 reads the athlete's most recent run rather than searching for a
    // code the user would have to type into their activity title.
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
      dailyTarget: policy.dailyTarget,
      startsAtMs: policy.startsAtMs,
      endsAtMs: policy.endsAtMs,
    });

    return NextResponse.json({
      requestUrl: await proofRequest.getRequestUrl(reclaimChannelLaunchOptions(channel)),
      sessionId,
      token,
      providerVersion,
      channel,
      instruction: isDuolingo
        ? "Sign in to Duolingo if asked, then continue. Your profile name will not be changed."
        : "Record your GPS run on Strava first, then sign in here. We read your most recent run: nothing to rename.",
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
