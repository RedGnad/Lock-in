export default function PrivacyPage() {
  const privacyEmail = process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>PRIVACY</span> Updated July 15, 2026</p>
      <h1>Minimal proof.<br/><em>Public settlement.</em></h1>

      <section><h2>Scope and contact</h2><p>This notice covers the limited-cohort Lock In V5 beta. Lock In has no product account database. The contact below handles privacy requests, security reports, and funds incidents.</p></section>
      <section><h2>Website and wallet</h2><p>The app reads the public address of the wallet you connect and public Monad state to display locks and prepare transactions. Hosting and RPC providers may process technical data such as IP address, device, request time, and logs under their own policies.</p></section>
      <section><h2>Strava proof</h2><p>During verification, Reclaim and the verification function process the signed Strava athlete marker, activity ID and title, sport, start time, distance, moving and elapsed time, elevation, GPS presence, trainer status, and Strava flag status. Lock In does not request or publish the GPS route. The server validates these fields without writing a product database.</p></section>
      <section><h2>Duolingo proof</h2><p>You enter a Duolingo username and temporarily or continuously place a wallet-specific code in the public profile bio. Reclaim and the verification function process profile ID, username, bio, cumulative XP, proof time, wallet, lock, and phase. The bio code demonstrates profile control; cumulative XP establishes the baseline and later progress.</p></section>
      <section><h2>Public on Monad</h2><p>Wallet addresses, lock settings, participation, stake and transfer amounts, mission type, day indexes, timestamps, completion metric, hashed external identity, proof or event nullifiers, cancellations, settlement, and claims become public and effectively permanent. For Strava the metric is run distance. For Duolingo the stored metric is cumulative XP, linked to the wallet through a hashed profile identity; the username, profile ID, bio, and route are not written onchain.</p></section>
      <section><h2>Offchain retention</h2><p>Lock In does not intentionally retain raw proofs after returning the short-lived attestation and does not use a user-profile database. Reclaim, Vercel, RPC, wallet, email, and browser providers may retain operational data under their own policies. Support messages remain only as long as needed to respond, protect the beta, meet obligations, or resolve an incident.</p></section>
      <section><h2>Purpose and rights</h2><p>Data is used only to bind a proof to the requesting wallet and lock, reject replay or impersonation, prepare the requested transaction, render public state, secure the beta, and answer support. Lock In does not sell a user profile. Depending on applicable law, you may request access, correction, deletion, restriction, or objection for offchain data controlled by Lock In. Lock In cannot erase Monad records or data controlled by independent services.</p></section>
      <section><h2>Contact</h2><p>{privacyEmail ? <>Email <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> for a privacy request, incident, or beta-support issue.</> : <>A public privacy contact must be configured before testers are invited.</>}</p></section>
      {!privacyEmail && <div className="legal-warning">Incomplete deployment: the public privacy contact is not configured.</div>}
    </main>
  );
}
