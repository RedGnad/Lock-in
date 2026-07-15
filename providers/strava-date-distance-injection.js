(() => {
  if (window.__lockInStravaProofV104) return;
  window.__lockInStravaProofV104 = true;

  const MAX_ATTEMPTS = 120;
  const RETRY_DELAY_MS = 1_500;
  const DAILY_PROOF_CODE = /^LI-[A-Z0-9]{16,28}D(?:0[1-9]|[12][0-9]|30)$/;
  const AUTH_PATH = /^\/(?:login|session|register)(?:\/|$)/;
  let attempts = 0;
  let running = false;

  function retry() {
    attempts += 1;
    if (attempts < MAX_ATTEMPTS) window.setTimeout(run, RETRY_DELAY_MS);
  }

  function requiresLogin(response) {
    if (response.status === 401 || response.status === 403) return true;

    try {
      const finalUrl = new URL(response.url, window.location.origin);
      return finalUrl.origin !== "https://www.strava.com" || AUTH_PATH.test(finalUrl.pathname);
    } catch {
      return true;
    }
  }

  async function run() {
    if (running) return;

    const reclaim = window.Reclaim;
    if (!reclaim?.parameters) {
      retry();
      return;
    }

    const challenge = String(reclaim.parameters.context_challenge || "");
    if (!DAILY_PROOF_CODE.test(challenge)) {
      reclaim.reportProviderError({ message: "Lock In received an invalid Strava check-in code." });
      return;
    }

    if (window.location.hostname !== "www.strava.com") {
      reclaim.requiresUserInteraction(true);
      retry();
      return;
    }

    reclaim.requiresUserInteraction(true);
    running = true;
    try {
      const training = await fetch("/athlete/training", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
      });
      await training.text();
      if (requiresLogin(training)) {
        reclaim.requiresUserInteraction(true);
        retry();
        return;
      }
      if (!training.ok) {
        retry();
        return;
      }

      const query = new URLSearchParams({
        keywords: challenge,
        sport_type: "Run",
        tags: "",
        commute: "",
        private_activities: "",
        trainer: "false",
        gear: "",
        new_activity_only: "false",
      });
      const activities = await fetch(`/athlete/training_activities?${query.toString()}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
      });
      const activityBody = await activities.text();
      if (requiresLogin(activities)) {
        reclaim.requiresUserInteraction(true);
        retry();
        return;
      }
      if (!activities.ok) {
        retry();
        return;
      }

      let hasExactActivity = false;
      try {
        const payload = JSON.parse(activityBody);
        hasExactActivity = Array.isArray(payload?.models)
          && payload.models[0]?.name === challenge;
      } catch {
        retry();
        return;
      }
      if (!hasExactActivity) {
        reclaim.requiresUserInteraction(true);
        retry();
        return;
      }

      reclaim.requiresUserInteraction(false);
    } catch {
      reclaim.requiresUserInteraction(true);
      retry();
    } finally {
      running = false;
    }
  }

  void run();
})();
