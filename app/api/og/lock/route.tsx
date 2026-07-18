import { ImageResponse } from "next/og";
import { formatUnits, zeroAddress } from "viem";
import { duolingoEscrowAddress, escrowAddress, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import { lockInDuolingoAbi } from "@/src/lock-in-duolingo-abi";

export const runtime = "nodejs";
export const contentType = "image/png";
const SIZE = { width: 1200, height: 630 };

/**
 * Dynamic Open Graph / Twitter card for a Lock link, rendered from real on-chain state so the preview on X,
 * WhatsApp and Discord is truthful. It is public and needs no wallet.
 *
 * It shows only safe, aggregate facts: mission, target, crew size, pool, and the Lock's phase. It never shows
 * an athlete id, a GPS route, a Duolingo profile, an XP baseline, a full wallet, or an unconfirmed result.
 */

type Card = {
  mission: string;
  headline: string;
  target: string;
  crew: string;
  pool: string;
  accent: boolean;
};

const INK = "#10100f";
const PAPER = "#f3efe4";
const ACID = "#ff4d00";
const LIME = "#d8ff36";

function usdc(atomic: bigint): string {
  return `${formatUnits(atomic, 6)} USDC`;
}

async function stravaCard(id: bigint): Promise<Card | null> {
  if (!escrowAddress) return null;
  const p = await lockInPublicClient().readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [id] }) as readonly [
    `0x${string}`, bigint, bigint, number, number, number, number, number, number, number, number, number, bigint, `0x${string}`, bigint, boolean, boolean,
  ];
  if (p[0] === zeroAddress) return null;
  const [, startsAt, stake, dailyTarget, participantCount, , , durationDays, requiredCompletions, , maxParticipants, , , , , finalized, cancelled] = p;
  const now = Math.floor(Date.now() / 1_000);
  const headline = cancelled ? "REFUNDED ON MONAD" : finalized ? "POOL SETTLED ON MONAD" : now >= Number(startsAt) ? "CHALLENGE ACTIVE" : "JOIN MY LOCK";
  return {
    mission: "Strava run",
    headline,
    target: `${(dailyTarget / 1_000).toFixed(dailyTarget % 1_000 === 0 ? 0 : 1)} km · ${requiredCompletions}/${durationDays} days`,
    crew: `${participantCount} / ${maxParticipants} players`,
    pool: usdc(stake * BigInt(participantCount)),
    accent: !finalized && !cancelled && now < Number(startsAt),
  };
}

async function duolingoCard(id: bigint): Promise<Card | null> {
  if (!duolingoEscrowAddress) return null;
  const p = await lockInPublicClient().readContract({ address: duolingoEscrowAddress, abi: lockInDuolingoAbi, functionName: "getPact", args: [id] });
  if (p.creator === zeroAddress) return null;
  const now = Math.floor(Date.now() / 1_000);
  const headline = p.cancelled ? "REFUNDED ON MONAD" : p.finalized ? "POOL SETTLED ON MONAD" : now >= Number(p.startsAt) ? "CHALLENGE ACTIVE" : "JOIN MY LOCK";
  return {
    mission: "Duolingo XP",
    headline,
    target: `+${p.targetXp} XP before the deadline`,
    crew: `${p.participantCount} / ${p.maxParticipants} players`,
    pool: usdc(p.stake * BigInt(p.participantCount)),
    accent: !p.finalized && !p.cancelled && now < Number(p.startsAt),
  };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mission = params.get("m");
  const idRaw = params.get("id") || "";
  let card: Card | null = null;
  try {
    if (/^[1-9]\d{0,29}$/.test(idRaw)) {
      const id = BigInt(idRaw);
      card = mission === "duolingo" ? await duolingoCard(id) : mission === "strava" ? await stravaCard(id) : null;
    }
  } catch {
    card = null;
  }

  const c: Card = card ?? {
    mission: "Lock In",
    headline: "STAKE ON YOUR GOALS",
    target: "Finishers split the pool",
    crew: "0.1 – 1 USDC per player",
    pool: "Settled on Monad",
    accent: true,
  };

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", padding: "72px", display: "flex", flexDirection: "column", justifyContent: "space-between", color: INK, background: c.accent ? LIME : PAPER, fontFamily: "Arial, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "22px", fontSize: 30, fontWeight: 900, letterSpacing: "-0.04em" }}>
          <span>LOCK</span><span style={{ color: ACID }}>IN</span>
          <span style={{ width: 640, height: 2, background: INK }} />
          <span style={{ fontSize: 18, letterSpacing: "0.1em" }}>MONAD</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ color: ACID, fontSize: 26, fontWeight: 800, letterSpacing: "0.04em" }}>{c.mission.toUpperCase()}</span>
          <span style={{ maxWidth: 1040, marginTop: 16, fontSize: 96, fontWeight: 950, lineHeight: 0.85, letterSpacing: "-0.07em" }}>{c.headline}</span>
          <span style={{ marginTop: 26, fontSize: 34, fontWeight: 700 }}>{c.target}</span>
        </div>
        <div style={{ display: "flex", gap: "48px", fontSize: 22, fontWeight: 800, letterSpacing: "0.04em" }}>
          <span>{c.crew}</span>
          <span>POOL {c.pool}</span>
          <span>1 USDC MAX</span>
        </div>
      </div>
    ),
    { ...SIZE, headers: { "Cache-Control": "public, max-age=60, s-maxage=120" } },
  );
}
