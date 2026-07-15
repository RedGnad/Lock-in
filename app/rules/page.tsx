export default function RulesPage() {
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>PRIVATE BETA</span> Updated July 15, 2026</p>
      <h1>Small stakes.<br/><em>Clear limits.</em></h1>

      <section>
        <h2>Who may test</h2>
        <p>Lock In V4 is a private, invitation-only beta for adults aged 18 or older. Do not use it where a stake-based challenge is restricted or prohibited. An invitation, access to the website, or the 1 USDC cap does not guarantee that participation is lawful where you live. These product rules are not legal advice.</p>
      </section>

      <section>
        <h2>What a check-in proves</h2>
        <p>The only active mission is a Monad wallet check-in. During an eligible pact day, a joined wallet sends a transaction to the contract. The contract records that wallet, pact, day, event identifier, and timestamp. A check-in may be submitted manually or automated by software. It does not prove exercise, learning, attendance, location, identity, or any other physical or mental activity. Lock In V4 does not use Strava or Reclaim to decide completion.</p>
      </section>

      <section>
        <h2>Pact schedule</h2>
        <p>A pact lasts 3 to 30 fixed 24-hour days and publishes its required number of check-ins before anyone joins. Registration closes at the displayed start time. Only one check-in per joined wallet can count in each current pact day; early, late, duplicate, and non-participant check-ins are rejected. A pact must reach its published minimum participant count before check-ins can count.</p>
      </section>

      <section>
        <h2>Real funds and exposure</h2>
        <p>Every participant deposits the same amount, greater than zero and no more than 1 USDC, into each pact. The cap applies per participant, per pact—not per wallet in total. A wallet may join several pacts and therefore put more than 1 USDC at risk overall. Lock In currently charges no protocol fee. Monad network fees are separate, can vary, and are never refunded by the pact.</p>
      </section>

      <section>
        <h2>Payouts and refunds</h2>
        <p>If at least one participant reaches the target, finishers recover their stake and split the non-finishers&apos; stakes equally through the final pool calculation. If everyone finishes, each participant receives their stake back. If nobody finishes, every participant can recover their stake. A cancelled or underfilled pact is refundable to its participants. Finalization and each claim require onchain transactions; payout division may leave the final eligible claimant with minor integer-rounding dust.</p>
      </section>

      <section>
        <h2>Public records</h2>
        <p>Monad transactions and contract events are public and effectively permanent. They include wallet addresses, pact configuration and participation, stake and transfer amounts, check-in days, event identifiers and timestamps, cancellations, finalization, and claims. Lock In V4 does not create a user profile or publish health, fitness, learning, social-account, or location data.</p>
      </section>

      <section>
        <h2>Controls and contract risk</h2>
        <p>The creator may cancel before the pact starts. The contract owner can pause creation, joining, or check-ins and can cancel an unsettled pact only into the refund path; pauses do not block finalization or claims. The V4 contract has not received an independent security audit. Smart-contract bugs, wallet errors, RPC failures, token issues, chain incidents, and lost keys can still cause delay or loss. The beta and its limits do not guarantee reimbursement, regulatory approval, or any legal exemption.</p>
      </section>

      <section>
        <h2>Independent services</h2>
        <p>Lock In is independent from Monad, Circle, wallet providers, RPC services, and explorers. Their names identify external infrastructure and do not imply sponsorship or endorsement. Their own terms and availability also apply when you use them.</p>
      </section>
    </main>
  );
}
