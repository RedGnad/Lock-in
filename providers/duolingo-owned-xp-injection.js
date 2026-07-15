(() => {
  if (window.__lockInDuolingoProofV108) return;
  window.__lockInDuolingoProofV108 = true;

  let attempts = 0;
  const retry = (delayMs = 1_000) => {
    attempts += 1;
    if (attempts < 300) window.setTimeout(run, delayMs);
  };

  async function run() {
    const reclaim = window.Reclaim;
    if (!reclaim) {
      retry(100);
      return;
    }

    // Keep the remote provider page alive before login detection can race the
    // asynchronous parameter handoff. Release it only after both exact
    // provider requests have completed.
    reclaim.requiresUserInteraction(true);

    if (!reclaim.parameters) {
      retry(100);
      return;
    }

    const profileId = String(reclaim.parameters.duolingo_user_id || "");
    if (!/^\d{1,20}$/.test(profileId)) {
      reclaim.reportProviderError({ message: "Lock In could not resolve this Duolingo profile." });
      return;
    }

    if (window.location.hostname !== "www.duolingo.com") {
      retry();
      return;
    }

    try {
      const ownership = await fetch(
        `/2023-05-23/users/${profileId}/privacy-settings`,
        { credentials: "include", cache: "no-store" },
      );
      await ownership.text();
      if (ownership.status === 401 || ownership.status === 403) {
        retry();
        return;
      }
      if (!ownership.ok) {
        retry();
        return;
      }

      const profile = await fetch(
        `/2023-05-23/users/${profileId}?fields=id,totalXp`,
        { credentials: "include", cache: "no-store" },
      );
      await profile.text();
      if (!profile.ok) {
        retry();
        return;
      }

      reclaim.requiresUserInteraction(false);
    } catch {
      retry();
    }
  }

  void run();
})();
