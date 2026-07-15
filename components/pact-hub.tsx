"use client";

import { useEffect, useState } from "react";
import { CreatePact } from "@/components/create-pact";
import { PactDiscovery } from "@/components/pact-discovery";

type HubView = "create" | "join";

export function PactHub() {
  const [view, setView] = useState<HubView>("create");

  useEffect(() => {
    function syncHash() {
      if (window.location.hash === "#join") setView("join");
      if (window.location.hash === "#create") setView("create");
    }
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  function choose(next: HubView) {
    setView(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  return (
    <section className="pact-hub" id="play" aria-labelledby="pact-hub-title">
      <header className="hub-heading">
        <div><span className="eyebrow"><span>PLAY</span> Your crew, your terms</span><h2 id="pact-hub-title">Ready to lock in?</h2></div>
        <p>Create a running pact or join one already forming on Monad.</p>
      </header>
      <div className="hub-tabs" role="tablist" aria-label="Choose how to start">
        <button type="button" role="tab" id="create-tab" aria-selected={view === "create"} aria-controls="create-panel" onClick={() => choose("create")}>START A PACT</button>
        <button type="button" role="tab" id="join-tab" aria-selected={view === "join"} aria-controls="join-panel" onClick={() => choose("join")}>JOIN A CREW</button>
      </div>
      <div role="tabpanel" id="create-panel" aria-labelledby="create-tab" hidden={view !== "create"}><CreatePact /></div>
      <div role="tabpanel" id="join-panel" aria-labelledby="join-tab" hidden={view !== "join"}><PactDiscovery /></div>
    </section>
  );
}
