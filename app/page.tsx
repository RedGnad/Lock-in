import { CreatePact } from "@/components/create-pact";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> L’engagement qui paie</div>
          <h1>Ta parole.<br/><em>Verrouillée.</em></h1>
          <p>Dépose jusqu’à 1 $. Enregistre une course GPS. Prouve les données Strava. Ceux qui abandonnent paient ceux qui terminent.</p>
          <a className="text-link" href="#create">Créer mon pacte <b>↘</b></a>
        </div>
        <div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="lock-core"><span>NO</span><strong>EXCUSES</strong></div></div>
        <div className="proof-strip"><span>STRAVA</span><b>zkTLS</b><span>MONAD</span><i>DIRECT ONCHAIN</i></div>
      </section>
      <section className="mechanic">
        <div><b>01</b><h2>Lock</h2><p>Choisis une distance, 1 à 5 jours, et une mise symbolique.</p></div>
        <div><b>02</b><h2>Move</h2><p>Enregistre une course GPS. Ton code unique lie l’activité au pacte.</p></div>
        <div><b>03</b><h2>Prove</h2><p>Quatre preuves Reclaim sont vérifiées directement sur Monad.</p></div>
      </section>
      <CreatePact />
    </main>
  );
}
