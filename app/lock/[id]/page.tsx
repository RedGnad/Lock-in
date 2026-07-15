import type { Metadata } from "next";
import { zeroAddress } from "viem";
import { PactDashboard } from "@/components/pact-dashboard";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import { formatMissionTarget, missionByType } from "@/src/missions";

type LockPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: LockPageProps): Promise<Metadata> {
  const { id } = await params;
  if (!/^\d+$/.test(id) || !escrowAddress) return { title: "Lock not found — Lock In", robots: { index: false, follow: false } };
  try {
    const lock = await lockInPublicClient().readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [BigInt(id)] });
    if (lock[0] === zeroAddress) return { title: "Lock not found — Lock In", robots: { index: false, follow: false } };
    const mission = missionByType(lock[11]);
    const title = `${mission.name}: ${lock[8]} ${mission.verb} in ${lock[7]} days — Lock In`;
    const description = `Join Lock #${id}: ${formatMissionTarget(lock[11], lock[3])}, complete ${lock[8]} of ${lock[7]} days, with ${Number(lock[2]) / 1_000_000} USDC staked per player.`;
    const url = `/lock/${id}`;
    return { title, description, alternates: { canonical: url }, openGraph: { title, description, type: "website", url } };
  } catch {
    const url = `/lock/${id}`;
    return { title: `Lock #${id} — Lock In`, description: "Join this verified challenge on Monad.", alternates: { canonical: url }, openGraph: { url } };
  }
}

export default async function LockPage({ params }: LockPageProps) {
  const { id } = await params;
  return <PactDashboard id={id} />;
}
