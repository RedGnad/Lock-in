import { CreatePact } from "@/components/create-pact";
import { MissionCatalog } from "@/components/mission-catalog";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> Stake-backed accountability</div>
          <h1>Your word.<br/><em>Locked in.</em></h1>
          <p>Stake up to 1 USDC. Verify a Strava record against a published GPS-run policy. Qualifying finishers share stakes forfeited by participants who miss the target.</p>
          <small className="beta-note">Experimental hackathon beta · adults 18+ · participation subject to local rules</small>
          <a className="text-link" href="#create">Create a pact <b>↘</b></a>
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>STRAVA</span><b>zkTLS</b><span>MONAD</span><i>ONCHAIN SETTLEMENT</i></div>
      </section>
      <section className="mechanic">
        <div><b>01</b><h2>Lock</h2><p>Choose a distance, program target, and stake up to 1 USDC.</p></div>
        <div><b>02</b><h2>Record</h2><p>Up to one qualifying Strava run can count per pact day. Hit the template target.</p></div>
        <div><b>03</b><h2>Verify</h2><p>Reclaim proofs and a short-lived Lock In policy attestation are checked on Monad.</p></div>
      </section>
      <MissionCatalog />
      <CreatePact />
    </main>
  );
}
