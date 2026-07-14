import { NextResponse } from "next/server";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (!escrowAddress) throw new Error("Escrow address is not configured");
    const client = lockInPublicClient();
    const [chainId, escrowCode, stakeToken, reclaim, evidenceSigner, maxStake, version, maxDays] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: escrowAddress }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "stakeToken" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "reclaim" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "evidenceSigner" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "maxStake" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "VERSION" }),
      client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "MAX_DAYS" }),
    ]);
    const [stakeTokenCode, reclaimCode] = await Promise.all([
      client.getCode({ address: stakeToken }),
      client.getCode({ address: reclaim }),
    ]);
    const signerKey = process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
    const signerMatches = Boolean(
      signerKey && privateKeyToAccount(signerKey).address === getAddress(evidenceSigner),
    );
    const checks = {
      chainId: chainId === 143,
      escrowCode: Boolean(escrowCode && escrowCode !== "0x"),
      stakeTokenCode: Boolean(stakeTokenCode && stakeTokenCode !== "0x"),
      reclaimCode: Boolean(reclaimCode && reclaimCode !== "0x"),
      oneUsdcCap: maxStake === 1_000_000n,
      contractVersion: version === 3n,
      thirtyDayPrograms: maxDays === 30n,
      reclaimCredentials: Boolean(process.env.ID?.trim() && process.env.SECRET?.trim()),
      sessionSecret: Boolean((process.env.SESSION_SIGNING_SECRET?.trim().length || 0) >= 32),
      evidenceSigner: signerMatches,
      privacyContact: Boolean(process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim()),
    };
    const ok = Object.values(checks).every(Boolean);
    return NextResponse.json({ ok, chainId, checks }, { status: ok ? 200 : 503, headers });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Health check failed",
    }, { status: 503, headers });
  }
}
