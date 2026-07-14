import { writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/src/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLocal(request: Request): boolean {
  const host = request.headers.get("host")?.split(":")[0];
  return process.env.NODE_ENV !== "production" && (host === "127.0.0.1" || host === "localhost");
}

export async function POST(request: Request) {
  if (!isLocal(request)) return new NextResponse(null, { status: 404 });
  try {
    const result = await readJsonBody<Record<string, unknown>>(request, 32 * 1_024);
    await writeFile("/tmp/lock-in-deployment.json", `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return NextResponse.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save deployment result" }, { status: 400 });
  }
}
