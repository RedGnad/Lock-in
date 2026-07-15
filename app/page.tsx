import { PactHub } from "@/components/pact-hub";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Run together. Settle onchain.</div>
          <h1>Show up.<br/><em>Together.</em></h1>
          <p>Start a running challenge with friends. Everyone stakes up to 1 USDC. Strava verifies who kept the pact.</p>
          <div className="hero-actions"><a className="primary-link" href="#create">START A PACT</a><a className="secondary-link" href="#join">JOIN A CREW</a></div>
          <small className="beta-note">2+ runners · 3–30 days · 1 USDC max each · Experimental beta 18+</small>
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>STRAVA</span><b>ROUTE NOT SHARED</b><i>SETTLED ON MONAD</i></div>
      </section>
      <PactHub />
      <section className="mechanic">
        <div><b>01</b><h2>Make it</h2><p>Choose the goal and invite your crew.</p></div>
        <div><b>02</b><h2>Do it</h2><p>Record each qualifying run in Strava.</p></div>
        <div><b>03</b><h2>Prove it</h2><p>Verify your streak and claim your share.</p></div>
      </section>
    </main>
  );
}
