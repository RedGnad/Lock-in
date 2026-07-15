(() => {
  if (window.__lockInStravaProofV104) return;
  window.__lockInStravaProofV104 = true;

  const RETRY_DELAY_MS = 1_500;
  const MAX_ATTEMPTS = 80; // ~2 min, before Reclaim's own session timeout
  const POST_LOGIN_LIMIT = 8;
  const DAILY_PROOF_CODE = /^LI-[A-Z0-9]{16,28}D(?:0[1-9]|[12][0-9]|30)$/;
  const AUTH_PATH = /^\/(?:login|session|register)(?:\/|$)/;
  let attempts = 0;
  let postLogin = 0;
  let running = false;
  let stage = "init";
  let trainingStatus = "-";
  let activitiesStatus = "-";
  let activitiesLen = 0;
  let name0 = "-";
  let reported = false;

  const log = (...a) => { try { console.log("[LockIn]", ...a); } catch {} };
  const report = (why) => {
    if (reported) return;
    reported = true;
    const msg = "LockIn diag: " + why + " stage=" + stage + " host=" + window.location.hostname
      + " training=" + trainingStatus + " activities=" + activitiesStatus
      + " len=" + activitiesLen + " name0=" + name0 + " attempts=" + attempts;
    log(msg);
    try { window.Reclaim.reportProviderError({ message: msg }); } catch (e) { log("report failed", e); }
  };

  const retry = (delayMs = RETRY_DELAY_MS) => {
    attempts += 1;
    if (attempts >= MAX_ATTEMPTS) { report("timeout"); return; }
    window.setTimeout(run, delayMs);
  };

  async function run() {
    if (running || reported) return;

    const reclaim = window.Reclaim;
    if (!reclaim) { stage = "no-reclaim"; retry(200); return; }
    reclaim.requiresUserInteraction(true);
    if (!reclaim.parameters) { stage = "no-params"; retry(200); return; }

    const challenge = String(reclaim.parameters.context_challenge || "");
    if (!DAILY_PROOF_CODE.test(challenge)) { stage = "bad-code"; report("invalid challenge"); return; }
    if (window.location.hostname !== "www.strava.com") { stage = "wrong-host"; retry(); return; }

    running = true;
    try {
      stage = "fetch-training";
      const t = await fetch("/athlete/training", { method: "GET", credentials: "include", cache: "no-store", redirect: "follow" });
      await t.text();
      trainingStatus = String(t.status);
      let needsLogin = t.status === 401 || t.status === 403;
      try {
        const tu = new URL(t.url, window.location.origin);
        if (tu.origin !== "https://www.strava.com" || AUTH_PATH.test(tu.pathname)) needsLogin = true;
      } catch { needsLogin = true; }
      if (needsLogin) { stage = "training-needs-login"; running = false; retry(); return; }
      if (!t.ok) { stage = "training-not-ok"; running = false; retry(); return; }

      // Past this point Strava accepted an authenticated same-origin request.
      stage = "fetch-activities";
      const q = new URLSearchParams({
        keywords: challenge, sport_type: "Run", tags: "", commute: "",
        private_activities: "", trainer: "false", gear: "", new_activity_only: "false",
      });
      const a = await fetch("/athlete/training_activities?" + q.toString(), {
        method: "GET", credentials: "include", cache: "no-store", redirect: "follow",
        headers: { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
      });
      const body = await a.text();
      activitiesStatus = String(a.status);
      activitiesLen = body.length;
      postLogin += 1;
      if (a.status === 401 || a.status === 403) {
        stage = "activities-forbidden"; running = false;
        if (postLogin >= POST_LOGIN_LIMIT) { report("activities forbidden after login"); return; }
        retry(); return;
      }
      if (!a.ok) {
        stage = "activities-not-ok"; running = false;
        if (postLogin >= POST_LOGIN_LIMIT) { report("activities not ok after login"); return; }
        retry(); return;
      }

      let matched = false;
      try {
        const payload = JSON.parse(body);
        name0 = String((payload && payload.models && payload.models[0] && payload.models[0].name) || "-");
        matched = Array.isArray(payload && payload.models) && name0 === challenge;
      } catch (e) {
        stage = "json-parse-fail"; running = false;
        if (postLogin >= POST_LOGIN_LIMIT) { report("activities returned non-JSON after login"); return; }
        retry(); return;
      }
      if (!matched) {
        stage = "no-match"; running = false;
        if (postLogin >= POST_LOGIN_LIMIT) { report("activity title not matched after login"); return; }
        retry(); return;
      }

      stage = "released";
      log("MATCH ok, releasing interaction");
      reclaim.requiresUserInteraction(false);
    } catch (e) {
      stage = "fetch-exception:" + String((e && e.message) || e);
      running = false;
      retry();
    } finally {
      running = false;
    }
  }

  log("injection loaded");
  void run();
})();
