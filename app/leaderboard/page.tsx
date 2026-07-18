import type { Metadata } from "next";
import { PlayerProfile } from "@/components/player-profile";
import { SocialLeaderboard } from "@/components/social-leaderboard";

export const metadata: Metadata = {
  title: "Leaderboard - Lock In",
  description: "The weekly Lock In ranking, rebuilt from verified days on Monad.",
  alternates: { canonical: "/leaderboard" },
};

export default function LeaderboardPage() {
  return (
    <main className="leaderboard-page">
      <section className="leaderboard-hero">
        <span>GLOBAL / VERIFIED / WEEKLY</span>
        <h1>Show up.<br/><em>Move up.</em></h1>
        <p>One verified day earns ten points. The board resets every Monday at 00:00 UTC; your all-time Lock Score stays.</p>
      </section>
      <PlayerProfile />
      <SocialLeaderboard full />
    </main>
  );
}
