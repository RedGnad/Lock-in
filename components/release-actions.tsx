"use client";

import { useReleaseHealth } from "@/components/use-release-health";

export function ReleaseActions() {
  const health = useReleaseHealth();
  const canStart = health.actions.newPacts;
  const canJoin = health.actions.join;

  if (!canStart && !canJoin) {
    return (
      <div className="hero-release-state" role="status">
        <b>{health.checked ? "NEW LOCKS ARE CLOSED" : "CHECKING ACCESS"}</b>
        <span>{health.checked && health.reachable ? "Creating and joining are currently paused." : "New stakes stay closed because access could not be confirmed."}</span>
      </div>
    );
  }

  return (
    <div className="hero-actions">
      {canStart && <a className="primary-link" href="#create">START A LOCK</a>}
      {canJoin && <a className="secondary-link" href="#join">JOIN A LOCK</a>}
    </div>
  );
}
