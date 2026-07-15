export default function RulesPage() {
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>PRIVATE BETA</span> Updated July 15, 2026</p>
      <h1>Small stakes.<br/><em>Clear limits.</em></h1>

      <section><h2>Who may test</h2><p>Lock In V5 is a limited hackathon beta for a small cohort of adults aged 18 or older. Do not participate where stake-based challenges are restricted or prohibited. Access to the app and the 1 USDC cap do not make participation lawful everywhere.</p></section>
      <section><h2>Two missions</h2><p>A Strava pact requires a challenge-named GPS Run that reaches the distance target. Manual, trainer, Strava-flagged, missing-GPS, and implausible motion records are rejected. A Duolingo pact requires a profile bio code that binds the profile to the wallet, then counts only new cumulative XP above the baseline accepted when that wallet stakes. One Duolingo profile cannot back two wallets in the same pact, and the same XP range cannot be reused across days or pacts.</p></section>
      <section><h2>What proof means</h2><p>Reclaim zkTLS proves what Strava or Duolingo returned over HTTPS and Lock In applies the published policy. It does not prove physical movement, human learning, or the absence of GPS spoofing, account sharing, bots, modified devices, or errors by an external service. Lock In reduces obvious and replayable fraud; no consumer data source can make cheating mathematically impossible.</p></section>
      <section><h2>Pact schedule</h2><p>A pact lasts 3 to 30 fixed 24-hour days and publishes its required wins before anyone joins. Registration closes at the displayed start. Only one verified completion can count per wallet and pact day. A pact must reach its published minimum crew before completions count.</p></section>
      <section><h2>Funds</h2><p>Every participant deposits the same amount, from 0.1 to 1 USDC per pact. Monad gas is separate and is never refunded by the pact. Lock In charges no protocol fee in this beta.</p></section>
      <section><h2>Payouts</h2><p>If anyone reaches the target, finishers recover their stakes and split non-finishers&apos; stakes equally. If everyone or nobody finishes, each participant recovers their own stake. Cancelled and underfilled pacts are refundable. Settlement and claims are permissionless onchain transactions.</p></section>
      <section><h2>Controls and risk</h2><p>The creator may cancel before the start. The contract owner may pause creation, joining, or evidence and may cancel an unsettled pact only into refunds; pauses never block settlement or claims. The V5 contract is unaudited. Smart-contract, wallet, RPC, token, chain, provider, signer, and key failures can cause delay or loss.</p></section>
      <section><h2>Independent services</h2><p>Lock In is independent from Strava, Duolingo, Reclaim, Monad, Circle, wallets, RPC services, and explorers. Their names identify external services and do not imply approval, partnership, sponsorship, or endorsement. Their terms and availability apply separately.</p></section>
    </main>
  );
}
