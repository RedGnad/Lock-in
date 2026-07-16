/**
 * Which Reclaim delivery channel carries a verification.
 *
 * This is a product decision, not a technical detail, so it is a setting rather than a hardcoded call:
 *
 * - `portal` (the SDK default) runs the verification in a REMOTE browser. The user's own Strava or
 *   Duolingo session is never used, so they authenticate again inside that remote browser on every
 *   check-in. For a daily 3-to-30-day commitment that is a re-login per day, per mission.
 * - `app` hands the flow to the Reclaim Verifier on the user's device, where a session can persist
 *   between check-ins.
 *
 * Nothing here asserts that either channel persists a login: that is exactly what has to be measured
 * before the product opens to users. Cookie-retention policy (`isRecurring`, `canClearWebStorage`) lives
 * in the Reclaim application configuration and the InApp SDK, not in this web SDK, so it cannot be set
 * from here and must be confirmed on the Reclaim dashboard.
 */
export type ReclaimChannel = "portal" | "app";

export const DEFAULT_RECLAIM_CHANNEL: ReclaimChannel = "portal";

export class ReclaimChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReclaimChannelError";
  }
}

/** Reads the configured channel. Unknown values fail closed rather than silently falling back. */
export function resolveReclaimChannel(value = process.env.RECLAIM_VERIFICATION_MODE): ReclaimChannel {
  const raw = value?.trim().toLowerCase();
  if (!raw) return DEFAULT_RECLAIM_CHANNEL;
  if (raw === "portal" || raw === "app") return raw;
  throw new ReclaimChannelError(
    `RECLAIM_VERIFICATION_MODE must be "portal" or "app", received "${value}"`,
  );
}

/**
 * Init options for the channel. `useAppClip` belongs to ProofRequestOptions; the deferred deep link does
 * NOT, it lives in the launch options below.
 */
export function reclaimChannelInitOptions(channel: ReclaimChannel): { useAppClip?: boolean } {
  return channel === "app" ? { useAppClip: true } : {};
}

/**
 * Launch options for `getRequestUrl`, typed as the SDK's ReclaimFlowInitOptions. In app mode the deferred
 * deep link means a user without the Verifier installed still lands back in the flow after installing,
 * instead of hitting a dead end.
 */
export function reclaimChannelLaunchOptions(channel: ReclaimChannel): {
  verificationMode: ReclaimChannel;
  canUseDeferredDeepLinksFlow?: boolean;
} {
  return channel === "app"
    ? { verificationMode: "app", canUseDeferredDeepLinksFlow: true }
    : { verificationMode: "portal" };
}
