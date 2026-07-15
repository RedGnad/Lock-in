(() => {
  if (window.__lockInStravaProofV104) return;
  window.__lockInStravaProofV104 = true;

  const RETRY_DELAY_MS = 1_500;
  const MAX_ATTEMPTS = 200;
  const DAILY_PROOF_CODE = /^LI-[A-Z0-9]{16,28}D(?:0[1-9]|[12][0-9]|30)$/;
  let attempts = 0;
  let running = false;
  const log = (...a) => { try { console.log("[LockIn]", ...a); } catch {} };

  const retry = (delayMs = RETRY_DELAY_MS) => {
    attempts += 1;
    if (attempts < MAX_ATTEMPTS) window.setTimeout(run, delayMs);
    else log("gave up after", attempts, "attempts");
  };

  async function run() {
    if (running) return;

    const reclaim = window.Reclaim;
    if (!reclaim) { log("no window.Reclaim yet"); retry(200); return; }

    // Hold the flow open immediately, before parameters race in.
    reclaim.requiresUserInteraction(true);

    if (!reclaim.parameters) { log("no reclaim.parameters yet"); retry(200); return; }

    const challenge = String(reclaim.parameters.context_challenge || "");
    log("challenge=", challenge, "host=", window.location.hostname);
    if (!DAILY_PROOF_CODE.test(challenge)) {
      log("invalid challenge code");
      reclaim.reportProviderError({ message: "Lock In received an invalid Strava check-in code." });
      return;
    }

    if (window.location.hostname !== "www.strava.com") { log("not on strava host yet"); retry(); return; }

    running = true;
    try {
      log("fetching /athlete/training");
      const training = await fetch("/athlete/training", { method: "GET", credentials: "include", cache: "no-store", redirect: "follow" });
      await training.text();
      log("training status", training.status, "url", training.url);
      if (training.status === 401 || training.status === 403) { log("training needs login"); retry(); return; }
      if (!training.ok) { log("training not ok"); retry(); return; }

      const query = new URLSearchParams({
        keywords: challenge, sport_type: "Run", tags: "", commute: "",
        private_activities: "", trainer: "false", gear: "", new_activity_only: "false",
      });
      log("fetching /athlete/training_activities");
      const activities = await fetch(`/athlete/training_activities?${query.toString()}`, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "follow",
        headers: { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
      });
      const activityBody = await activities.text();
      log("activities status", activities.status, "len", activityBody.length);
      if (activities.status === 401 || activities.status === 403) { log("activities needs login"); retry(); return; }
      if (!activities.ok) { log("activities not ok"); retry(); return; }

      let matched = false;
      try {
        const payload = JSON.parse(activityBody);
        const name0 = payload?.models?.[0]?.name;
        log("parsed JSON, models", payload?.models?.length, "name0", name0);
        matched = Array.isArray(payload?.models) && name0 === challenge;
      } catch (e) {
        log("JSON parse failed, body starts", activityBody.slice(0, 60));
        retry();
        return;
      }
      if (!matched) { log("activity not matched yet"); retry(); return; }

      log("MATCH ok, releasing interaction");
      reclaim.requiresUserInteraction(false);
    } catch (e) {
      log("fetch error", String(e && e.message || e));
      retry();
    } finally {
      running = false;
    }
  }

  log("injection loaded");
  void run();
})();
