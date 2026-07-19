import { getAddress, isAddress } from "viem";

/**
 * The financial escrow's own allowlist, distinct from both the Preview's and the Strava canary's.
 *
 * LockInDuolingoEscrow moves real USDC, so its backend opens explicitly under
 * DUOLINGO_ESCROW_ALLOWED_WALLETS. A comma-separated list admits only those wallets; `*` admits every
 * valid wallet. This is separate from DUOLINGO_PREVIEW_ALLOWED_WALLETS (the Live Proof Beta, no stake)
 * and from CANARY_ALLOWED_WALLETS (the Strava escrow): a wallet enabled for one product is not thereby
 * enabled for the money one.
 *
 * An empty or missing list closes the escrow entirely. A misconfigured list (a non-address) also closes
 * it, rather than failing open.
 */
export class EscrowAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EscrowAccessError";
  }
}

export function assertEscrowWalletAllowed(
  walletAddress: string,
  environment: Record<string, string | undefined> = process.env,
): void {
  const configured = environment.DUOLINGO_ESCROW_ALLOWED_WALLETS?.trim();
  if (!configured) throw new EscrowAccessError("The Duolingo escrow is not open yet", 403);
  if (configured === "*") {
    if (!isAddress(walletAddress)) throw new EscrowAccessError("Connect a valid wallet first", 400);
    return;
  }
  const allowed = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (allowed.length === 0 || allowed.some((value) => !isAddress(value))) {
    throw new EscrowAccessError("The Duolingo escrow is not configured", 503);
  }
  const set = new Set(allowed.map((value) => getAddress(value).toLowerCase()));
  if (!isAddress(walletAddress) || !set.has(getAddress(walletAddress).toLowerCase())) {
    throw new EscrowAccessError("This wallet is not enabled for the Duolingo escrow", 403);
  }
}
