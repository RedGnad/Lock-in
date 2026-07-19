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
 * It shows only safe, confirmed, aggregate facts: mission, terms, pool, and the Lock's phase. It never shows
 * an athlete id, a GPS route, a Duolingo profile, an XP baseline, a full wallet, an unconfirmed payout, or a
 * transaction hash. "TARGET MET" is only shown once a finisher exists on chain (finisherCount >= 1).
 */

type Card = {
  mission: string;
  headline: string;
  stats: string[];
  accent: boolean;
};

const INK = "#10100f";
const PAPER = "#f3efe4";
const ACID = "#ff4d00";
const LIME = "#d8ff36";

function poolUsdc(stake: bigint, participants: number): string {
  return formatUnits(stake * BigInt(participants), 6);
}

async function stravaCard(id: bigint): Promise<Card | null> {
  if (!escrowAddress) return null;
  const p = await lockInPublicClient().readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [id] }) as readonly [
    `0x${string}`, bigint, bigint, number, number, number, number, number, number, number, number, number, bigint, `0x${string}`, bigint, boolean, boolean,
  ];
  if (p[0] === zeroAddress) return null;
  const [, startsAt, stake, dailyTarget, participantCount, finisherCount, , durationDays, requiredCompletions, , , , , , , finalized, cancelled] = p;
  const now = Math.floor(Date.now() / 1_000);
  const registration = now < Number(startsAt);
  const targetMet = !finalized && !cancelled && finisherCount >= 1;
  const km = (dailyTarget / 1_000).toFixed(dailyTarget % 1_000 === 0 ? 0 : 1);
  const pool = poolUsdc(stake, participantCount);

  const headline = cancelled ? "REFUNDED ON MONAD"
    : finalized ? "POOL SETTLED ON MONAD"
    : registration ? "JOIN MY LOCK"
    : targetMet ? "TARGET MET"
    : "CHALLENGE ACTIVE";

  const stats = targetMet
    ? [`${requiredCompletions} / ${requiredCompletions} RUNS VERIFIED`, `${durationDays} DAYS`, `${km} KM PER RUN`, `POOL ${pool} USDC`]
    : [`${requiredCompletions} RUNS IN ${durationDays} DAYS`, `${km} KM PER RUN`, `POOL ${pool} USDC`];

  return { mission: "Strava run", headline, stats, accent: registration || targetMet };
}

async function duolingoCard(id: bigint): Promise<Card | null> {
  if (!duolingoEscrowAddress) return null;
  const p = await lockInPublicClient().readContract({ address: duolingoEscrowAddress, abi: lockInDuolingoAbi, functionName: "getPact", args: [id] });
  if (p.creator === zeroAddress) return null;
  const now = Math.floor(Date.now() / 1_000);
  const registration = now < Number(p.startsAt);
  const targetMet = !p.finalized && !p.cancelled && p.finisherCount >= 1;
  const pool = poolUsdc(p.stake, p.participantCount);

  const headline = p.cancelled ? "REFUNDED ON MONAD"
    : p.finalized ? "POOL SETTLED ON MONAD"
    : registration ? "JOIN MY LOCK"
    : targetMet ? "TARGET MET"
    : "CHALLENGE ACTIVE";

  const stats = targetMet
    ? [`+${p.targetXp} XP REACHED`, `POOL ${pool} USDC`]
    : [`+${p.targetXp} XP GOAL`, `POOL ${pool} USDC`];

  return { mission: "Duolingo XP", headline, stats, accent: registration || targetMet };
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
    stats: ["FINISHERS SPLIT THE POOL", "0.1 TO 1 USDC PER PLAYER"],
    accent: true,
  };

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", padding: "68px 72px", display: "flex", flexDirection: "column", justifyContent: "space-between", color: INK, background: c.accent ? LIME : PAPER, fontFamily: "Arial, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", fontSize: 30, fontWeight: 900, letterSpacing: "-0.04em" }}>
          <span>LOCK</span><span style={{ color: ACID }}>IN</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ color: ACID, fontSize: 25, fontWeight: 800, letterSpacing: "0.05em" }}>{c.mission.toUpperCase()}</span>
          <span style={{ maxWidth: 1010, marginTop: 12, fontSize: 82, fontWeight: 950, lineHeight: 0.86, letterSpacing: "-0.06em" }}>{c.headline}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 24, fontSize: 27, fontWeight: 800, letterSpacing: "0.03em" }}>
            {c.stats.map((line) => <span key={line}>{line}</span>)}
          </div>
        </div>
        <span style={{ fontSize: 20, fontWeight: 900, letterSpacing: "0.14em" }}>BUILT ON MONAD</span>
      </div>
    ),
    { ...SIZE, headers: { "Cache-Control": "public, max-age=60, s-maxage=120" } },
  );
}
