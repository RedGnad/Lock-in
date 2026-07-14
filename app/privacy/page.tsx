export default function PrivacyPage() {
  const privacyEmail = process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();
  return (
    <main className="legal-page">
      <p className="eyebrow"><span>LEGAL</span> 14 juillet 2026</p>
      <h1>Confidentialité,<br/><em>sans détour.</em></h1>
      <section><h2>Ce que Lock In traite</h2><p>Ton adresse de wallet, le pacte, le challenge, l’identifiant de session Reclaim et les champs Strava nécessaires : compte athlète, activité, titre, sport, heure, distance, présence GPS, statut trainer, signalement Strava et métriques de mouvement.</p></section>
      <section><h2>Ce que nous ne recevons jamais</h2><p>Aucun mot de passe, cookie ou token Strava. Aucun tracé GPS détaillé. La connexion reste dans le flux isolé Reclaim et la preuve brute n’est pas conservée par l’API.</p></section>
      <section><h2>Ce qui reste public</h2><p>Adresse, pacte, nullifier et transactions inscrits sur Monad sont publics et non effaçables. Le code placé dans le titre de ta course suit tes propres réglages de confidentialité Strava.</p></section>
      <section><h2>Conservation</h2><p>Le prototype utilise des sessions signées courtes sans base de données utilisateur. Les artefacts de preuve locaux des développeurs sont ignorés par Git et supprimés après test.</p></section>
      <section><h2>Contact et droits</h2><p>{privacyEmail ? <>Pour exercer tes droits sur les données hors chaîne ou signaler un incident, écris à <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>. Les écritures déjà publiées sur Monad ne peuvent pas être effacées.</> : <>Le contact du responsable de traitement doit être configuré avant l’ouverture publique du prototype.</>}</p></section>
      {!privacyEmail && <div className="legal-warning">Déploiement incomplet : le contact privacy public n’est pas encore configuré.</div>}
    </main>
  );
}
