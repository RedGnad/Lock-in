import { CreatePact } from "@/components/create-pact";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Accountability with real stakes</div>
          <h1>Your word.<br/><em>Locked in.</em></h1>
          <p>Create a challenge, stake up to 1 USDC, and prove your runs with Strava. Finish your goal to reclaim your stake and share the pool.</p>
          <small className="beta-note">Experimental beta · 18+</small>
          <a className="text-link" href="#create">Start a challenge <b>↘</b></a>
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>STRAVA</span><b>ROUTE NOT SHARED</b><i>SETTLED ON MONAD</i></div>
      </section>
      <section className="mechanic">
        <div><b>01</b><h2>Choose</h2><p>Pick a distance, schedule, and stake.</p></div>
        <div><b>02</b><h2>Run</h2><p>Record qualifying runs in Strava.</p></div>
        <div><b>03</b><h2>Finish</h2><p>Hit your target to reclaim your stake and share the pool.</p></div>
      </section>
      <CreatePact />
    </main>
  );
}
