import { NextResponse } from "next/server";
import { fetchStatusUrl } from "@reclaimprotocol/js-sdk";
import { verifyProofSessionToken } from "@/src/session-token";
import { readJsonBody } from "@/src/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const { token } = await readJsonBody<{ token?: string }>(request, 32 * 1_024);
    const session = verifyProofSessionToken(token || "");
    const status = await fetchStatusUrl(session.sessionId);
    if (status.session?.sessionId && status.session.sessionId !== session.sessionId) {
      throw new Error("Reclaim returned another session");
    }
    return NextResponse.json({
      status: status.session?.statusV2 || status.message,
      proofs: status.session?.proofs || null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read proof status" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
