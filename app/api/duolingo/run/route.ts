import { NextResponse } from "next/server";
import { clearPreviewRun, loadPreviewRun } from "@/src/duolingo-preview-store";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The challenge state for a wallet, so returning to the page shows the baseline that is already stored
 * rather than an empty form. The baseline lives on the server precisely because the athlete must not be
 * able to edit it, so the page has to ask for it rather than remember it.
 *
 * The wallet comes from the signed session cookie, never from the query string alone: one wallet's
 * challenge is not another wallet's to read or reset.
 */
function failure(error: unknown) {
  const authStatus = walletAuthErrorStatus(error);
  return NextResponse.json({
    error: authStatus ? walletAuthPublicMessage(error) : "Could not read your challenge",
  }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const wallet = new URL(request.url).searchParams.get("wallet") || "";
    const session = requireWalletAuthSession(request, wallet);
    const run = await loadPreviewRun(session.walletAddress);
    return NextResponse.json({
      run: run
        ? {
            targetXp: run.targetXp,
            baselineXp: run.baselineXp,
            baselineObservedAt: run.baselineObservedAt,
            identityHash: run.identityHash,
          }
        : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

/** Starting over is legitimate here: there is no stake, and a wrong target should not trap anyone. */
export async function DELETE(request: Request) {
  try {
    const wallet = new URL(request.url).searchParams.get("wallet") || "";
    const session = requireWalletAuthSession(request, wallet);
    await clearPreviewRun(session.walletAddress);
    return NextResponse.json({ cleared: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
