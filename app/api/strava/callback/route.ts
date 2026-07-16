import { NextResponse } from "next/server";
import { exchangeStravaCode, STRAVA_SCOPE, verifyStravaState } from "@/src/strava-oauth";
import { consumeStravaState, saveStravaConnection } from "@/src/strava-token-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Strava sends the athlete back. This runs in their browser, so it redirects rather than returning
 * JSON, and it never puts a token anywhere the browser can read.
 *
 * There is no wallet session to trust here: a callback arrives from Strava, not from our page. The signed
 * `state` is the only thing that says which wallet started the flow.
 */
function back(request: Request, params: Record<string, string>): NextResponse {
  const url = new URL("/", new URL(request.url).origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url, { status: 303 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const scope = url.searchParams.get("scope") || "";
  const error = url.searchParams.get("error");

  // The athlete pressed Cancel, or Strava refused. Not an error worth alarming them about.
  if (error) return back(request, { strava: "cancelled" });
  if (!code || !state) return back(request, { strava: "failed" });

  let verified;
  try {
    verified = verifyStravaState(state);
  } catch {
    // A bad state is the CSRF case: someone tried to attach their Strava account to another wallet.
    return back(request, { strava: "invalid_state" });
  }
  // Burn it. The signature says the state is genuine; only this says it has not been used already.
  if (!(await consumeStravaState({
    nonceHash: verified.nonceHash,
    walletAddress: verified.wallet,
    expiresAt: verified.expiresAt,
  }))) {
    return back(request, { strava: "invalid_state" });
  }
  const wallet = verified.wallet;

  // Strava lets the athlete untick scopes on the consent screen. Without activity:read_all their private
  // runs are invisible to us, and they would only find out after staking, so refuse now.
  if (!scope.split(",").includes(STRAVA_SCOPE)) {
    return back(request, { strava: "scope_declined" });
  }

  try {
    const tokens = await exchangeStravaCode({ code, scope });
    await saveStravaConnection({
      walletAddress: wallet,
      athleteId: tokens.athleteId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      scopes: tokens.scopes,
    });
  } catch (cause) {
    // The unique index on athlete_id is what enforces one Strava account per wallet; surface that plainly
    // instead of as a generic failure.
    const message = cause instanceof Error ? cause.message : "";
    if (/strava_connections_athlete_active/.test(message)) {
      return back(request, { strava: "athlete_already_linked" });
    }
    return back(request, { strava: "failed" });
  }

  return back(request, { strava: "connected" });
}
