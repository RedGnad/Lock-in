"use client";

import { useEffect, useState } from "react";
import { CreatePact } from "@/components/create-pact";
import { PactDiscovery } from "@/components/pact-discovery";
import { useReleaseHealth } from "@/components/use-release-health";

type HubView = "create" | "join";

export function PactHub() {
  const [view, setView] = useState<HubView>("create");
  const health = useReleaseHealth();
  const canCreate = health.actions.newPacts;
  const canJoin = health.actions.join;
  const activeView: HubView = view === "create" && canCreate ? "create" : view === "join" && canJoin ? "join" : canCreate ? "create" : "join";

  useEffect(() => {
    function syncHash() {
      if (window.location.hash === "#join" && canJoin) setView("join");
      if (window.location.hash === "#create" && canCreate) setView("create");
    }
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [canCreate, canJoin]);

  function choose(next: HubView) {
    if ((next === "create" && !canCreate) || (next === "join" && !canJoin)) return;
    setView(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  if (!canCreate && !canJoin) {
    const unavailable = health.checked && !health.reachable;
    return (
      <section className="pact-hub" id="play" aria-labelledby="pact-hub-title">
        <header className="hub-heading">
          <div><span className="eyebrow"><span>STATUS</span> New-stake protection</span><h2 id="pact-hub-title">{unavailable ? "Access unavailable" : health.checked ? "New locks are closed" : "Checking access"}</h2></div>
          <p>{unavailable ? "We could not confirm that new stakes are enabled. Existing locks can still settle or claim." : "Creating and joining are paused. Existing locks can still settle or claim from their lock page."}</p>
        </header>
        <div className="hub-closed" role="status">
          <strong>NO NEW FUNDS ACCEPTED</strong>
          <p>Creating and joining will return when access is enabled.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="pact-hub" id="play" aria-labelledby="pact-hub-title">
      <header className="hub-heading">
        <div><span className="eyebrow"><span>PLAY</span> Your crew, your terms</span><h2 id="pact-hub-title">Ready to lock in?</h2></div>
        <p>{health.mode === "open" ? "Create a competitive streak or join one already forming on Monad." : "Choose one of the currently available actions."}</p>
      </header>
      <div className={`hub-tabs${canCreate && canJoin ? "" : " single"}`} role="tablist" aria-label="Choose how to start">
        {canCreate && <button type="button" role="tab" id="create-tab" aria-selected={activeView === "create"} aria-controls="create-panel" onClick={() => choose("create")}>START A LOCK</button>}
        {canJoin && <button type="button" role="tab" id="join-tab" aria-selected={activeView === "join"} aria-controls="join-panel" onClick={() => choose("join")}>JOIN A CREW</button>}
      </div>
      {canCreate && <div role="tabpanel" id="create-panel" aria-labelledby="create-tab" hidden={activeView !== "create"}><CreatePact /></div>}
      {canJoin && <div role="tabpanel" id="join-panel" aria-labelledby="join-tab" hidden={activeView !== "join"}><PactDiscovery /></div>}
    </section>
  );
}
