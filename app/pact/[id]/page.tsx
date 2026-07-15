import type { Metadata } from "next";
import { zeroAddress } from "viem";
import { PactDashboard } from "@/components/pact-dashboard";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";

type PactPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PactPageProps): Promise<Metadata> {
  const { id } = await params;
  if (!/^\d+$/.test(id) || !escrowAddress) return { title: "Pact not found — Lock In" };
  try {
    const pact = await lockInPublicClient().readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [BigInt(id)] });
    if (pact[0] === zeroAddress) return { title: "Pact not found — Lock In" };
    const title = `${pact[9]} × ${pact[4] / 1_000} km in ${pact[8]} days — Lock In`;
    const description = `Join pact #${id}: ${pact[9]} runs in ${pact[8]} days with ${Number(pact[3]) / 1_000_000} USDC staked per runner.`;
    return { title, description, openGraph: { title, description, type: "website" } };
  } catch {
    return { title: `Pact #${id} — Lock In`, description: "Join this Strava running challenge on Monad." };
  }
}

export default async function PactPage({ params }: PactPageProps) {
  const { id } = await params;
  return <PactDashboard id={id} />;
}
