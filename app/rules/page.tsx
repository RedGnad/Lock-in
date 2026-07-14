export default function RulesPage() {
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>BETA</span> Experimental hackathon rules · July 14, 2026</p>
      <h1>Clear rules.<br/><em>Real limits.</em></h1>
      <section><h2>Eligibility</h2><p>Lock In is an experimental public beta for adults aged 18 or older. Do not participate where a stake-based accountability contest is restricted or prohibited. Access to the website does not establish local eligibility.</p></section>
      <section><h2>Stake limit</h2><p>Each participant deposits the same amount into a pact, capped by the contract at 1 USDC. Lock In currently charges no protocol fee. Network fees are separate and are never part of the prize pool.</p></section>
      <section><h2>Pool outcome</h2><p>Participants who reach the published completion target split the pact pool. If every participant succeeds, each receives their stake back. If nobody succeeds, all participants may recover their stake. An underfilled pact is cancelled and refundable.</p></section>
      <section><h2>Proof rules</h2><p>Only one qualifying activity can count in each fixed 24-hour pact day, starting at the displayed UTC time. A Strava record must use that day&apos;s exact code (prefix plus `D01`–`D30`), meet the distance, be a Run with GPS, not be trainer-tagged or Strava-flagged, average between 0.5 and 9 m/s while moving, and keep elapsed time within four times moving time plus 15 minutes. Past eligible days can be proved until the displayed proof deadline. One Strava identity cannot back multiple wallets in the same pact, and one activity cannot settle twice.</p></section>
      <section><h2>Onchain data</h2><p>The transformed Reclaim proofs and the required Strava fields listed in the privacy notice are submitted in public Monad transaction calldata. They remain permanently accessible even if the source activity is private or later deleted. Detailed GPS routes and Strava credentials are not included.</p></section>
      <section><h2>Residual risk</h2><p>zkTLS proves what an authenticated service returned; it does not make GPS spoofing, account sharing, bots, compromised devices, or service errors impossible. The contract owner may cancel a beta pact so participants can recover stakes when a provider or verifier incident makes fair settlement unreliable.</p></section>
      <section><h2>Admin powers</h2><p>The contract owner can cancel an unsettled pact and rotate the Lock In evidence signer. The owner cannot withdraw pact funds or change the immutable 1 USDC cap, token, Reclaim verifier, provider hashes, or payout formula. Cancellation still requires an onchain finalization and claim; network gas is never refunded.</p></section>
      <section><h2>Third parties</h2><p>Lock In is independent from Strava, Moonwalk, Duolingo, Reclaim, Circle, and Monad. Their names identify external services or infrastructure and do not imply sponsorship or endorsement.</p></section>
    </main>
  );
}
