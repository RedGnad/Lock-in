import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "Strava verification is not available in Lock In V4." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
