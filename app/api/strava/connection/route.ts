import { NextResponse } from "next/server";
import { readJsonBody } from "@/src/api-guard";
import { refreshStravaTokens, revokeStravaGrant } from "@/src/strava-oauth";
import {
  deleteStravaConnection,
  getUsableStravaAccessToken,
  stravaConnectionStatus,
} from "@/src/strava-token-store";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const authStatus = walletAuthErrorStatus(error);
  return NextResponse.json({
    error: authStatus
      ? walletAuthPublicMessage(error)
      : error instanceof Error ? error.message : "Strava connection unavailable",
  }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
}

/** Whether this wallet has a live Strava connection. Never returns a token, only whether one exists. */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const walletSession = requireWalletAuthSession(request, String(body.walletAddress || ""));
    const status = await stravaConnectionStatus(walletSession.walletAddress);
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Disconnects: revokes the grant at Strava, then deletes the local connection outright.
 *
 * Revoking first means that if the delete then fails, the tokens are already dead. The reverse order could
 * leave a live grant we no longer track, which is the worse failure. A revoke that fails at Strava still
 * deletes locally: the athlete asked to be disconnected, and an outage at Strava must not keep their
 * tokens in our database. The row is removed rather than flagged, because the privacy page says the
 * connection is deleted and keeping the athlete id, scopes and both tokens would make that untrue.
 */
export async function DELETE(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const walletSession = requireWalletAuthSession(request, String(body.walletAddress || ""));

    let revokedAtStrava = false;
    try {
      const connection = await getUsableStravaAccessToken(
        walletSession.walletAddress,
        (refreshToken) => refreshStravaTokens(refreshToken),
      );
      revokedAtStrava = (await revokeStravaGrant(connection.accessToken)).revoked;
    } catch {
      // No connection, or the token could not be refreshed. Either way there is nothing live to revoke.
    }

    await deleteStravaConnection(walletSession.walletAddress);
    return NextResponse.json({ disconnected: true, revokedAtStrava }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
