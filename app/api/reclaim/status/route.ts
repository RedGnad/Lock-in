import { NextResponse } from "next/server";
import { fetchStatusUrl } from "@reclaimprotocol/js-sdk";
import { readJsonBody } from "@/src/api-guard";
import { checkReclaimRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { verifyProofSessionV5 } from "@/src/proof-session-v5";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const { token } = await readJsonBody<{ token?: string }>(request, 32 * 1_024);
    const session = verifyProofSessionV5(token || "");
    if (!isProofActionEnabled(readProductFlagState(), session)) {
      return NextResponse.json({ error: "Proof verification is paused. Settlement and claims remain available." }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const rateLimit = checkReclaimRateLimit("status", request, session.sessionId);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Proof status polling is temporarily limited." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rateLimit),
      });
    }
    const status = await fetchStatusUrl(session.sessionId);
    if (status.session?.sessionId && status.session.sessionId !== session.sessionId) {
      throw new Error("Reclaim returned another session");
    }
    return NextResponse.json({
      status: status.session?.statusV2 || status.message,
      proofs: status.session?.proofs || null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read proof status" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
