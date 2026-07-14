import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAddress, isAddress, type Abi, type Hex } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FoundryArtifact = { abi: Abi; bytecode: { object: Hex } };

function isLocal(request: Request): boolean {
  const host = request.headers.get("host")?.split(":")[0];
  return process.env.NODE_ENV !== "production" && (host === "127.0.0.1" || host === "localhost");
}

async function artifact(path: string) {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as FoundryArtifact;
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

export async function GET(request: Request) {
  if (!isLocal(request)) return new NextResponse(null, { status: 404 });
  const expectedDeployer = process.env.WALLET_ADDRESS?.trim() || "";
  const evidenceSigner = process.env.EVIDENCE_SIGNER_ADDRESS?.trim() || "";
  if (!isAddress(expectedDeployer) || !isAddress(evidenceSigner)) {
    return NextResponse.json({ error: "WALLET_ADDRESS or EVIDENCE_SIGNER_ADDRESS is not configured" }, { status: 503 });
  }
  const [reclaim, proxy, escrow] = await Promise.all([
    artifact("out/Reclaim.sol/Reclaim.json"),
    artifact("out/ReclaimProxy.sol/ReclaimProxy.json"),
    artifact("out/LockInEscrow.sol/LockInEscrow.json"),
  ]);
  return NextResponse.json({
    expectedDeployer: getAddress(expectedDeployer),
    evidenceSigner: getAddress(evidenceSigner),
    stakeToken: getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
    maxStake: "1000000",
    witness: getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072"),
    witnessHost: "https://reclaim-node.questbook.app",
    artifacts: { reclaim, proxy, escrow },
  }, { headers: { "Cache-Control": "no-store" } });
}
