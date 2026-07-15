import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/src/api-guard";
import {
  createWalletAuthChallenge,
  walletAuthErrorStatus,
  walletAuthOriginFromRequest,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const walletAddress = new URL(request.url).searchParams.get("walletAddress") || "";
    const challenge = createWalletAuthChallenge({
      walletAddress,
      origin: walletAuthOriginFromRequest(request),
    });
    return NextResponse.json(challenge, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: walletAuthPublicMessage(error) }, {
      status: walletAuthErrorStatus(error) || 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
