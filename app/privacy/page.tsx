export default function PrivacyPage() {
  const privacyEmail = process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>LEGAL</span> July 14, 2026</p>
      <h1>Privacy,<br/><em>without the fine print.</em></h1>
      <section><h2>Operator contact and third parties</h2><p>Lock In is an independent hackathon prototype. The public operator contact for privacy requests and incidents is shown below. Strava, Reclaim, Vercel, Monad infrastructure, RPC providers, and wallet software process data under their own terms when you use them.</p></section>
      <section><h2>What Lock In processes</h2><p>Your wallet address, pact, challenge, Reclaim session ID, and the Strava fields required for proof: athlete account, activity, title, sport, time, distance, GPS presence, trainer status, Strava flag status, and movement metrics.</p></section>
      <section><h2>What we never receive</h2><p>No Strava password, cookie, or token. No detailed GPS trace. Authentication stays inside Reclaim&apos;s isolated flow, and the application server does not retain the raw proof.</p></section>
      <section><h2>What becomes public</h2><p>To verify the result onchain, your wallet submits transformed Reclaim proofs in Monad transaction calldata. The proof contexts expose the athlete account marker, activity ID and title, sport, start time, distance, GPS-presence boolean, trainer and flag status, movement times, elevation, pact, and proof metadata. Wallet addresses, nullifiers, and all of these transaction records are public, permanent, and cannot be deleted. Your Strava privacy settings do not hide the copy published in calldata.</p></section>
      <section><h2>Purpose and retention</h2><p>Offchain fields are processed only to create and verify the pact you request, prevent replay, settle it, and investigate incidents. The prototype uses short-lived signed sessions with no user database, and the application server discards proofs after verification. Hosting and infrastructure providers may retain technical logs under their own policies. Onchain calldata remains public indefinitely.</p></section>
      <section><h2>Contact and rights</h2><p>{privacyEmail ? <>To request access, correction, deletion, restriction, or withdrawal before publication, or to report an incident, email <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>. You may also contact your local data-protection authority. Records already published on Monad cannot be erased or withdrawn.</> : <>A public privacy contact must be configured before opening the prototype to users.</>}</p></section>
      {!privacyEmail && <div className="legal-warning">Incomplete deployment: the public privacy contact is not configured.</div>}
    </main>
  );
}
