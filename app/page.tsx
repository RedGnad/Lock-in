import { redirect } from "next/navigation";
import { isDuolingoPreviewMode } from "@/src/preview-mode";
import { PactHub } from "@/components/pact-hub";
import { ReleaseActions } from "@/components/release-actions";
import { SocialLeaderboard } from "@/components/social-leaderboard";
import { StravaConnect } from "@/components/strava-connect";

export default function Home() {
  // On the Duolingo preview deployment the root is the XP flow, not the Strava home.
  if (isDuolingoPreviewMode()) redirect("/duolingo");

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Accountability that pays</div>
          <h1>Your word.<br/><em>Locked in.</em></h1>
          <p>Challenge your friends to improve. Stake up to 1 USDC each. Finishers split the pool funded by those who quit.</p>
          <ReleaseActions />
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>STRAVA + DUOLINGO</span><b>PVP PAYOUTS</b><i>SETTLED ON MONAD</i></div>
      </section>
      {/* Strava sends the athlete back to this page, so the OAuth outcome is acknowledged here with a
          transient notice only. There is no permanent connection card: connecting and disconnecting are
          contextual, inside a Strava Lock. */}
      <StravaConnect noticeOnly />
      <PactHub />
      <SocialLeaderboard />
      <section className="mechanic">
        <div><b>01</b><h2>Set it</h2><p>Choose a measurable goal, a deadline, your crew and your stake.</p></div>
        <div><b>02</b><h2>Prove it</h2><p>Verify your runs with Strava or your XP progress with Duolingo.</p></div>
        <div><b>03</b><h2>Settle it</h2><p>Finishers recover their stake and split the pool.</p></div>
      </section>
    </main>
  );
}
