export default function PrivacyPage() {
  const privacyEmail = process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>LEGAL</span> July 14, 2026</p>
      <h1>Privacy,<br/><em>without the fine print.</em></h1>
      <section><h2>What Lock In processes</h2><p>Your wallet address, pact, challenge, Reclaim session ID, and the Strava fields required for proof: athlete account, activity, title, sport, time, distance, GPS presence, trainer status, Strava flag status, and movement metrics.</p></section>
      <section><h2>What we never receive</h2><p>No Strava password, cookie, or token. No detailed GPS trace. Authentication stays inside Reclaim&apos;s isolated flow, and the API does not retain the raw proof.</p></section>
      <section><h2>What remains public</h2><p>Wallet addresses, pacts, nullifiers, and transactions recorded on Monad are public and cannot be deleted. The run code in your activity title follows your own Strava privacy settings.</p></section>
      <section><h2>Retention</h2><p>The prototype uses short-lived signed sessions with no user database. Developers&apos; local proof artifacts are excluded from Git and deleted after testing.</p></section>
      <section><h2>Contact and rights</h2><p>{privacyEmail ? <>To exercise your rights over offchain data or report an incident, email <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>. Records already published on Monad cannot be erased.</> : <>A public privacy contact must be configured before opening the prototype to users.</>}</p></section>
      {!privacyEmail && <div className="legal-warning">Incomplete deployment: the public privacy contact is not configured.</div>}
    </main>
  );
}
