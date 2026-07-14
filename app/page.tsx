import { CreatePact } from "@/components/create-pact";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Accountability that pays</div>
          <h1>Your word.<br/><em>Locked in.</em></h1>
          <p>Stake up to $1. Record a GPS run. Prove it with Strava. Finishers split the pool funded by those who quit.</p>
          <a className="text-link" href="#create">Create a pact <b>↘</b></a>
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>STRAVA</span><b>zkTLS</b><span>MONAD</span><i>DIRECT ONCHAIN</i></div>
      </section>
      <section className="mechanic">
        <div><b>01</b><h2>Lock</h2><p>Choose a distance, a 1–5 day streak, and a symbolic stake.</p></div>
        <div><b>02</b><h2>Move</h2><p>Record one GPS run per day. Your unique code binds each activity to the pact.</p></div>
        <div><b>03</b><h2>Prove</h2><p>Four Reclaim proofs are verified directly on Monad.</p></div>
      </section>
      <CreatePact />
    </main>
  );
}
