import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { clearPreviewRun, loadPreviewRun } from "@/src/duolingo-preview-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The challenge state for a wallet, so returning to the page shows the baseline that is already stored
 * rather than an empty form. The baseline lives on the server precisely because the athlete must not be
 * able to edit it, so the page has to ask for it rather than remember it.
 */
export async function GET(request: Request) {
  const wallet = new URL(request.url).searchParams.get("wallet") || "";
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const run = await loadPreviewRun(getAddress(wallet));
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
  } catch {
    return NextResponse.json({ error: "Could not read your challenge" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

/** Starting over is legitimate here: there is no stake, and a wrong target should not trap anyone. */
export async function DELETE(request: Request) {
  const wallet = new URL(request.url).searchParams.get("wallet") || "";
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    await clearPreviewRun(getAddress(wallet));
    return NextResponse.json({ cleared: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not reset your challenge" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
