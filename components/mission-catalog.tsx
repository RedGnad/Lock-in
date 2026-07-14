import { MISSIONS } from "@/src/missions";

const STATUS_LABEL = {
  live: "BETA",
  next: "NEXT",
  blocked: "PERMISSION GATED",
} as const;

export function MissionCatalog() {
  return (
    <section className="mission-section" id="missions">
      <div className="mission-heading">
        <p className="eyebrow"><span>02</span> Choose your arena</p>
        <h2>Move.<br/><em>Then learn.</em></h2>
        <p>One accountability system, independent proof rules for every mission.</p>
      </div>
      <div className="mission-list">
        {MISSIONS.map((mission) => (
          <article className={`mission-card ${mission.status}`} key={mission.id}>
            <div className="mission-meta"><span>{mission.arena}</span><b>{STATUS_LABEL[mission.status]}</b></div>
            <h3>{mission.name}</h3>
            <p>{mission.promise}</p>
            <small>{mission.source} · {mission.moneyEnabled ? "up to 1 USDC" : "no staking"}</small>
            <details><summary>Verification model</summary><p>{mission.detail}</p></details>
          </article>
        ))}
      </div>
    </section>
  );
}
