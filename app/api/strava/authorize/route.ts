import { NextResponse } from "next/server";
import { readJsonBody } from "@/src/api-guard";
import { checkRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import { issueStravaState, stravaAuthorizeUrl } from "@/src/strava-oauth";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Derived from the request so one code path serves local and deployed, and no URL is configured twice. */
export function stravaRedirectUri(request: Request): string {
  return new URL("/api/strava/callback", new URL(request.url).origin).toString();
}

/**
 * Starts the Strava authorisation. The athlete does this ONCE; every later check-in reuses the stored
 * refresh token, which is the whole point of the OAuth pivot.
 *
 * The wallet is taken from the authenticated session, never from the body, and is sealed into a signed
 * `state`, so the callback can prove which wallet started the flow.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const walletSession = requireWalletAuthSession(request, String(body.walletAddress || ""));
    const rateLimit = checkRateLimit("session", request, walletSession.walletAddress);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many attempts. Try again later." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rateLimit),
      });
    }

    const authorizeUrl = stravaAuthorizeUrl({
      state: issueStravaState(walletSession.walletAddress),
      redirectUri: stravaRedirectUri(request),
    });
    return NextResponse.json({ authorizeUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : error instanceof Error ? error.message : "Could not start Strava authorization",
    }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
  }
}
