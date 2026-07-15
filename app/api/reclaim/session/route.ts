import { NextResponse } from "next/server";
import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import { readJsonBody } from "@/src/api-guard";
import { checkReclaimRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { loadProofPolicyV5 } from "@/src/pact-server-v5";
import { issueProofSessionV5 } from "@/src/proof-session-v5";
import { DUOLINGO_PROVIDER_VERSION, duolingoProviderId } from "@/src/duolingo-proof-policy";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "@/src/strava-proof-policy";
import { DUOLINGO_XP_MISSION } from "@/src/lock-in-abi";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function POST(request: Request) {
  const rateLimit = checkReclaimRateLimit("session", request);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many proof sessions. Try again later." }, {
      status: 429,
      headers: rateLimitResponseHeaders(rateLimit),
    });
  }
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1_024);
    const phase = body.phase === "baseline" ? "baseline" : body.phase === "completion" ? "completion" : null;
    if (!phase) throw new Error("Invalid proof phase");
    const intent = body.intent === "create" || body.intent === "join" ? body.intent : undefined;
    if (!isProofActionEnabled(readProductFlagState(), { phase, intent })) {
      return NextResponse.json({ error: "Proof verification is paused. Settlement and claims remain available." }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const policy = await loadProofPolicyV5({
      walletAddress: String(body.walletAddress || ""),
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
    if (isDuolingo) {
      const username = String(body.username || "").trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error("Enter a valid Duolingo username");
      proofRequest.setParams({ duolingo_username: username });
    } else {
      if (!policy.proofCode) throw new Error("Strava proof code is missing");
      proofRequest.setParams({ context_challenge: policy.proofCode });
    }
    const sessionId = proofRequest.getSessionId();
    const token = issueProofSessionV5({
      sessionId,
      walletAddress: policy.walletAddress,
      pactId: policy.pactId,
      missionType: policy.missionType,
      phase: policy.phase,
      intent: policy.intent,
      dayIndex: policy.dayIndex,
      providerId,
      providerVersion,
      ownershipCode: policy.ownershipCode,
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
      ownershipCode: policy.ownershipCode,
      proofCode: policy.proofCode,
      instruction: isDuolingo
        ? `Set your Duolingo bio to exactly ${policy.ownershipCode} before continuing.`
        : `Set the title of your Strava GPS run to exactly ${policy.proofCode}.`,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create proof session" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
