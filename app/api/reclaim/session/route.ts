import { NextResponse } from "next/server";
import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import { loadOnchainPactPolicy } from "@/src/pact-server";
import { issueProofSessionToken } from "@/src/session-token";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "@/src/strava-proof-policy";
import { readJsonBody } from "@/src/api-guard";

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
    const policy = await loadOnchainPactPolicy({
      walletAddress: String(body.walletAddress || ""),
      pactId: String(body.pactId || ""),
      dayIndex: Number(body.dayIndex),
      challenge: String(body.challenge || ""),
    });
    const proofRequest = await ReclaimProofRequest.init(
      required("ID"),
      required("SECRET"),
      STRAVA_PROVIDER_ID,
      {
        providerVersion: STRAVA_PROVIDER_VERSION,
        acceptTeeAttestation: true,
        canAutoSubmit: true,
        preferredLocale: "fr",
      },
    );
    proofRequest.setContext(
      policy.walletAddress.toLowerCase(),
      `${policy.pactId}:${policy.dayIndex}`,
    );
    proofRequest.setParams({ context_challenge: policy.challenge });
    const sessionId = proofRequest.getSessionId();
    const token = issueProofSessionToken({ sessionId, ...policy });

    return NextResponse.json({
      requestUrl: await proofRequest.getRequestUrl(),
      sessionId,
      token,
      providerVersion: STRAVA_PROVIDER_VERSION,
      instruction: `Add ${policy.challenge} to the title of your Strava GPS run.`,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create proof session" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
