import { NextResponse } from "next/server";
import { assertSameOrigin, readJsonBody } from "@/src/api-guard";
import {
  issueWalletAuthSession,
  requireWalletAuthSession,
  WALLET_AUTH_COOKIE_NAME,
  WALLET_AUTH_SESSION_TTL_MS,
  walletAuthErrorStatus,
  walletAuthOriginFromRequest,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearCookie(response: NextResponse) {
  response.cookies.set({
    name: WALLET_AUTH_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

export async function GET(request: Request) {
  const walletAddress = new URL(request.url).searchParams.get("walletAddress") || "";
  try {
    assertSameOrigin(request);
    const session = requireWalletAuthSession(request, walletAddress);
    return NextResponse.json({
      authenticated: true,
      walletAddress: session.walletAddress,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = NextResponse.json({
      authenticated: false,
      error: walletAuthPublicMessage(error),
    }, {
      status: walletAuthErrorStatus(error) || 401,
      headers: { "Cache-Control": "no-store" },
    });
    clearCookie(response);
    return response;
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ challenge?: string; signature?: string }>(request, 24 * 1_024);
    const session = await issueWalletAuthSession({
      challenge: body.challenge || "",
      signature: body.signature || "",
      origin: walletAuthOriginFromRequest(request),
    });
    const response = NextResponse.json({
      authenticated: true,
      walletAddress: session.walletAddress,
      expiresAt: session.expiresAt,
    }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set({
      name: WALLET_AUTH_COOKIE_NAME,
      value: session.token,
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
      maxAge: Math.floor(WALLET_AUTH_SESSION_TTL_MS / 1_000),
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: walletAuthPublicMessage(error) }, {
      status: walletAuthErrorStatus(error) || 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
