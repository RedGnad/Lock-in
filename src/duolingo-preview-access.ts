import { getAddress, isAddress } from "viem";

/**
 * The Preview's own allowlist, separate from the Strava canary's.
 *
 * The Live Proof Beta runs a real, unaudited proof flow against a real Reclaim app, so it opens to a named
 * set of wallets and no one else. This is DUOLINGO_PREVIEW_ALLOWED_WALLETS, distinct from
 * CANARY_ALLOWED_WALLETS: the two products should never share an admission list.
 *
 * An empty or missing list closes the Preview entirely. A misconfigured list (a non-address) also closes
 * it, rather than failing open.
 */
export class PreviewAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PreviewAccessError";
  }
}

export function assertPreviewWalletAllowed(walletAddress: string, environment = process.env): void {
  const configured = environment.DUOLINGO_PREVIEW_ALLOWED_WALLETS?.trim();
  if (!configured) throw new PreviewAccessError("The Duolingo preview is not open yet", 403);
  const allowed = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (allowed.length === 0 || allowed.some((value) => !isAddress(value))) {
    throw new PreviewAccessError("The Duolingo preview is not configured", 503);
  }
  const set = new Set(allowed.map((value) => getAddress(value).toLowerCase()));
  if (!isAddress(walletAddress) || !set.has(getAddress(walletAddress).toLowerCase())) {
    throw new PreviewAccessError("This wallet is not enabled for the Duolingo preview", 403);
  }
}
