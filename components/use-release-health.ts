"use client";

import { useEffect, useState } from "react";

export type ReleaseActions = Readonly<{
  newPacts: boolean;
  join: boolean;
  checkIns: boolean;
}>;

export type ReleaseHealth = Readonly<{
  checked: boolean;
  reachable: boolean;
  mode: "paused" | "restricted" | "open";
  actions: ReleaseActions;
}>;

const CLOSED_ACTIONS: ReleaseActions = {
  newPacts: false,
  join: false,
  checkIns: false,
};

const INITIAL_HEALTH: ReleaseHealth = {
  checked: false,
  reachable: false,
  mode: "paused",
  actions: CLOSED_ACTIONS,
};

function parseHealth(payload: unknown, reachable: boolean, allowActions: boolean): ReleaseHealth {
  if (!reachable || !payload || typeof payload !== "object") {
    return { ...INITIAL_HEALTH, checked: true };
  }

  const rawActions = (payload as { actions?: unknown }).actions;
  if (!rawActions || typeof rawActions !== "object") {
    return { ...INITIAL_HEALTH, checked: true };
  }

  const actions = {
    newPacts: allowActions && (rawActions as { newPacts?: unknown }).newPacts === true,
    join: allowActions && (rawActions as { join?: unknown }).join === true,
    checkIns: allowActions && (rawActions as { checkIns?: unknown }).checkIns === true,
  };
  const enabledCount = Number(actions.newPacts) + Number(actions.join) + Number(actions.checkIns);

  return {
    checked: true,
    reachable: true,
    mode: enabledCount === 0 ? "paused" : enabledCount === 3 ? "open" : "restricted",
    actions,
  };
}

export function useReleaseHealth(): ReleaseHealth {
  const [health, setHealth] = useState<ReleaseHealth>(INITIAL_HEALTH);

  useEffect(() => {
    let alive = true;

    async function refresh() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const payload: unknown = await response.json();
        const parsed = Boolean(payload && typeof payload === "object");
        const confirmed = response.ok && parsed && (payload as { ok?: unknown }).ok === true;
        if (alive) setHealth(parseHealth(payload, parsed, confirmed));
      } catch {
        if (alive) setHealth({ ...INITIAL_HEALTH, checked: true });
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return health;
}
