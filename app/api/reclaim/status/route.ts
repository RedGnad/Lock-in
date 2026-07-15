import { NextResponse } from "next/server";
import { fetchStatusUrl } from "@reclaimprotocol/js-sdk";
import { readJsonBody } from "@/src/api-guard";
import { checkReclaimRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { verifyProofSession } from "@/src/proof-session";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const { token } = await readJsonBody<{ token?: string }>(request, 32 * 1_024);
    const session = verifyProofSession(token || "");
    requireWalletAuthSession(request, session.walletAddress);
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
    const rawStatus = String(status.session?.statusV2 || status.message || "");
    const publicStatus = /fail|error|cancel|reject|expired/i.test(rawStatus)
      ? "failed"
      : status.session?.proofs
        ? "complete"
        : "pending";
    // Proofs are fetched again by /verify using the signed server session. They
    // are deliberately never relayed through this polling endpoint.
    return NextResponse.json({
      status: publicStatus,
      ready: Boolean(status.session?.proofs),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : "Could not read proof status",
    }, {
      status: authStatus || 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
