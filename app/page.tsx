import { PactHub } from "@/components/pact-hub";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Accountability that pays</div>
          <h1>Your word.<br/><em>Locked in.</em></h1>
          <p>Challenge your friends to a Monad streak. Stake up to 1 USDC each. Finishers split the pool funded by those who quit.</p>
          <div className="hero-actions"><a className="primary-link" href="#create">START A PACT</a><a className="secondary-link" href="#join">JOIN A PACT</a></div>
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>ONCHAIN CHECK-INS</span><b>PVP PAYOUTS</b><i>SETTLED ON MONAD</i></div>
      </section>
      <PactHub />
      <section className="mechanic">
        <div><b>01</b><h2>Make it</h2><p>Choose a streak and bring your crew.</p></div>
        <div><b>02</b><h2>Show up</h2><p>Check in on Monad before each day closes.</p></div>
        <div><b>03</b><h2>Take your share</h2><p>Finishers recover their stake and split the rest.</p></div>
      </section>
    </main>
  );
}
