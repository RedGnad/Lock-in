export default function PrivacyPage() {
  const privacyEmail = process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();

  return (
    <main className="legal-page">
      <p className="eyebrow"><span>PRIVACY</span> Updated July 15, 2026</p>
      <h1>Public by design.<br/><em>Minimal by default.</em></h1>

      <section>
        <h2>Scope and contact</h2>
        <p>This notice covers the invitation-only Lock In V4 beta. The public contact for privacy requests, security reports, and beta support is shown below. Lock In is an independent prototype; infrastructure providers process some data under their own terms.</p>
      </section>

      <section>
        <h2>No activity profile</h2>
        <p>V4 has no user account or activity profile. It does not request Strava, Reclaim, social-media, health, fitness, learning, GPS, or biometric data. The active mission records only a Monad wallet check-in. That check-in can be automated and does not prove that a person performed any physical or mental activity.</p>
      </section>

      <section>
        <h2>What the website processes</h2>
        <p>The website reads the public address of the wallet you connect and public Monad state so it can display pacts and prepare transactions. If you contact support, we process the information you choose to send, such as a wallet address, pact ID, transaction hash, and message. Do not send a seed phrase, private key, health information, or other sensitive data.</p>
      </section>

      <section>
        <h2>What becomes public</h2>
        <p>Transactions and contract events expose wallet addresses, pact IDs and configuration, participation, stake and token-transfer amounts, check-in day indexes, event identifiers and timestamps, cancellations, finalization, claims, transaction hashes, and normal block metadata. A pact also contains a configuration hash, not raw profile or mission content. These records are public, can be copied by anyone, and cannot be deleted by Lock In.</p>
      </section>

      <section>
        <h2>Offchain data and retention</h2>
        <p>Lock In V4 does not maintain a product user database. Hosting, RPC, wallet, analytics if later disclosed, and email providers may process technical data such as IP address, request time, device information, and logs under their own retention policies. Support messages remain in the support mailbox only as long as needed to answer, protect the beta, meet applicable obligations, or resolve a funds incident.</p>
      </section>

      <section>
        <h2>Purpose and providers</h2>
        <p>Data is used to render public pact state, prepare the transactions you request, operate and secure the private beta, account for funds, and answer support requests. Relevant providers may include Vercel, Monad RPC and explorer services, your wallet provider, Circle&apos;s USDC contract, and the configured email provider. Lock In does not sell a user profile.</p>
      </section>

      <section>
        <h2>Your choices and rights</h2>
        <p>Disconnecting your wallet stops the website from reading it through the wallet connection, but it does not remove public chain history. Depending on applicable law, you may request access, correction, deletion, restriction, or objection for offchain information controlled by Lock In. Already-published Monad records cannot be erased or changed by Lock In.</p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>{privacyEmail ? <>Email <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> for a privacy request, incident, or beta-support issue. You may also contact your local data-protection authority where applicable.</> : <>A public privacy contact must be configured before testers are invited.</>}</p>
      </section>

      {!privacyEmail && <div className="legal-warning">Incomplete deployment: the public privacy contact is not configured.</div>}
    </main>
  );
}
