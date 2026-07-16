"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import type { SocialLeaderboardData, LeaderboardFilter } from "@/src/social-score";

type LeaderboardApiResponse = SocialLeaderboardData & {
  ok: true;
  generatedAt: string;
  throughBlock: string;
};

const FILTERS: { id: LeaderboardFilter; label: string; detail: string }[] = [
  { id: "overall", label: "Overall", detail: "Any verified day" },
  { id: "running", label: "Running", detail: "Strava days" },
];

function compactAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function weekLabel(startsAt: string, endsAt: string) {
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${formatter.format(new Date(startsAt))}–${formatter.format(new Date(new Date(endsAt).getTime() - 1))}`;
}

function competitionRank(entries: LeaderboardApiResponse["leaderboards"][LeaderboardFilter], index: number) {
  if (index === 0) return 1;
  const score = entries[index].weeklyScore;
  const firstWithScore = entries.findIndex((entry) => entry.weeklyScore === score);
  return firstWithScore + 1;
}

export function SocialLeaderboard({ full = false }: { full?: boolean }) {
  const { address } = useAccount();
  const [filter, setFilter] = useState<LeaderboardFilter>("overall");
  const [data, setData] = useState<LeaderboardApiResponse | null>(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/social/leaderboard", { cache: "no-store", signal: controller.signal });
        const result = await response.json() as Partial<LeaderboardApiResponse> & { error?: string };
        if (!response.ok || result.ok !== true || !result.leaderboards || !result.week) {
          throw new Error(result.error || "Leaderboard unavailable");
        }
        if (alive) {
          setData(result as LeaderboardApiResponse);
          setError("");
        }
      } catch (loadError) {
        if (alive && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError("Live rankings are temporarily unavailable.");
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 45_000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [retryKey]);

  const entries = useMemo(() => {
    const ranked = data?.leaderboards[filter] || [];
    const limit = full ? 50 : 6;
    if (ranked.length <= limit) return ranked;
    const cutoffScore = ranked[limit - 1].weeklyScore;
    let end = limit;
    while (end < ranked.length && ranked[end].weeklyScore === cutoffScore) end += 1;
    return ranked.slice(0, end);
  }, [data, filter, full]);
  const selected = FILTERS.find((item) => item.id === filter) as (typeof FILTERS)[number];

  return (
    <section className={`social-leaderboard${full ? " social-leaderboard-full" : ""}`} aria-labelledby={full ? "full-leaderboard-title" : "home-leaderboard-title"}>
      <header className="social-heading">
        <div>
          <span className="social-kicker">THE LOCK BOARD · LIVE ON MONAD</span>
          <h2 id={full ? "full-leaderboard-title" : "home-leaderboard-title"}>Proof earns rank.</h2>
        </div>
        <p>Ten points per verified UTC day. A bigger stake, extra distance, or multiple Locks cannot multiply a day&apos;s score.</p>
      </header>

      <div className="social-tabs" role="tablist" aria-label="Leaderboard mission">
        {FILTERS.map((item) => <button type="button" role="tab" aria-selected={filter === item.id} aria-controls="social-ranking" onClick={() => setFilter(item.id)} key={item.id}><strong>{item.label}</strong><span>{item.detail}</span></button>)}
      </div>

      <div className="social-board-meta">
        <span>{data ? `${weekLabel(data.week.startsAt, data.week.endsAt)} · UTC` : "CURRENT UTC WEEK"}</span>
        <b>{selected.label.toUpperCase()} · RESETS MONDAY</b>
      </div>

      <div className="social-ranking" id="social-ranking" role="tabpanel" aria-live="polite">
        {!data && !error && <div className="social-state">Reading verified days from Monad…</div>}
        {error && !data && <div className="social-state social-error"><span>{error}</span><button type="button" onClick={() => setRetryKey((value) => value + 1)}>TRY AGAIN</button></div>}
        {data && entries.length === 0 && <div className="social-state social-empty"><strong>The board is open.</strong><span>Publish the first verified day this week to take #1.</span><Link href="/#play">START A LOCK →</Link></div>}
        {entries.map((entry, index) => {
          const isYou = address?.toLowerCase() === entry.account.toLowerCase();
          return <div className={`social-row${isYou ? " social-row-you" : ""}`} key={entry.account}>
            <b className="social-rank">{String(competitionRank(entries, index)).padStart(2, "0")}</b>
            <div className="social-player"><strong>{entry.handle ? `@${entry.handle}` : compactAddress(entry.account)}</strong><span>{isYou ? "YOU · " : ""}{entry.handle ? compactAddress(entry.account) : "LOCK IN PLAYER"}</span></div>
            <div className="social-week-score"><strong>{entry.weeklyScore}</strong><span>THIS WEEK</span></div>
            <div className="social-total-score"><strong>{entry.lockScore}</strong><span>LOCK SCORE</span></div>
          </div>;
        })}
      </div>

      <div className="social-footer">
        <span>All-time Lock Score never resets. Category totals are independently deduplicated.</span>
        {!full && <Link href="/leaderboard">FULL LEADERBOARD ↗</Link>}
      </div>
    </section>
  );
}
