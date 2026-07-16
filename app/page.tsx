import { PactHub } from "@/components/pact-hub";
import { ReleaseActions } from "@/components/release-actions";
import { SocialLeaderboard } from "@/components/social-leaderboard";
import { StravaConnect } from "@/components/strava-connect";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Accountability that pays</div>
          <h1>Your word.<br/><em>Locked in.</em></h1>
          <p>Challenge your friends to run. Stake up to 1 USDC each. Finishers split the pool funded by those who quit.</p>
          <ReleaseActions />
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>VERIFIED ON STRAVA</span><b>PVP PAYOUTS</b><i>SETTLED ON MONAD</i></div>
      </section>
      {/* Strava sends the athlete back to this page, so the outcome of the authorization is read here.
          The card hides itself until a wallet is connected. */}
      <section className="home-strava"><StravaConnect /></section>
      <PactHub />
      <SocialLeaderboard />
      <section className="mechanic">
        <div><b>01</b><h2>Call it</h2><p>Set the distance, pick the days, bring your crew.</p></div>
        <div><b>02</b><h2>Prove it</h2><p>Connect Strava once. Run, then check in with one tap.</p></div>
        <div><b>03</b><h2>Take your share</h2><p>Finishers recover their stake and split the rest.</p></div>
      </section>
    </main>
  );
}
