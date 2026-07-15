import type { Metadata } from "next";
import { zeroAddress } from "viem";
import { PactDashboard } from "@/components/pact-dashboard";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";

type PactPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PactPageProps): Promise<Metadata> {
  const { id } = await params;
  if (!/^\d+$/.test(id) || !escrowAddress) return { title: "Pact not found — Lock In", robots: { index: false, follow: false } };
  try {
    const pact = await lockInPublicClient().readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [BigInt(id)] });
    if (pact[0] === zeroAddress) return { title: "Pact not found — Lock In", robots: { index: false, follow: false } };
    const title = `${pact[7]} check-ins in ${pact[6]} days — Lock In`;
    const description = `Join pact #${id}: ${pact[7]} Monad check-ins in ${pact[6]} days with ${Number(pact[2]) / 1_000_000} USDC staked per player.`;
    const url = `/pact/${id}`;
    return { title, description, alternates: { canonical: url }, openGraph: { title, description, type: "website", url } };
  } catch {
    const url = `/pact/${id}`;
    return { title: `Pact #${id} — Lock In`, description: "Join this onchain check-in challenge on Monad.", alternates: { canonical: url }, openGraph: { url } };
  }
}

export default async function PactPage({ params }: PactPageProps) {
  const { id } = await params;
  return <PactDashboard id={id} />;
}
