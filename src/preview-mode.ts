/**
 * Whether this deployment is the Duolingo Live Proof Beta rather than the Strava production.
 *
 * The Preview builds the whole app, so its root would otherwise show the Strava home with "new locks are
 * closed", which reads as "the Preview is broken" to a tester. When DUOLINGO_PREVIEW_MODE is set the root
 * redirects to /duolingo, the only experience this deployment is meant to offer. Production never sets the
 * flag, so its home is untouched, and no escrow or Lock flag is involved either way.
 */
export function isDuolingoPreviewMode(
  environment: { DUOLINGO_PREVIEW_MODE?: string } = process.env as { DUOLINGO_PREVIEW_MODE?: string },
): boolean {
  return environment.DUOLINGO_PREVIEW_MODE === "true";
}
