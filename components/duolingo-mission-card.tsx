import Link from "next/link";

/**
 * A home-page card that presents Duolingo XP as a second mission and links into the /duolingo experience
 * (create, or join with an invite). It is deliberately just a card and a link: Duolingo is a SEPARATE escrow
 * with its own flow, so nothing here touches the Strava mission model or the escrow-A create form.
 *
 * Whether /duolingo shows the Live Proof Beta or the staked financial flow is decided there, by the chain,
 * not by this card.
 */
export function DuolingoMissionCard() {
  return (
    <section className="home-duolingo" aria-labelledby="duo-mission-title">
      <div className="duo-mission-card">
        <div className="eyebrow"><span>BETA</span> New mission</div>
        <h2 id="duo-mission-title">Duolingo <em>XP</em></h2>
        <p>
          Prove your starting XP, go and learn, then prove your progress. The crew that reaches its XP target
          splits the pool. A cumulative total before the deadline, not a daily streak.
        </p>
        <div className="duo-mission-actions">
          <Link className="lock-button" href="/duolingo">Create a Duolingo Lock</Link>
          <Link className="secondary-button" href="/duolingo">Have an invite? Join</Link>
        </div>
      </div>
    </section>
  );
}
