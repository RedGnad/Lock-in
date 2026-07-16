type SignWalletMessage = (message: string) => Promise<string>;

type WalletSessionResponse = {
  authenticated?: boolean;
  walletAddress?: string;
  error?: string;
};

async function responseJson(response: Response): Promise<WalletSessionResponse> {
  try {
    return await response.json() as WalletSessionResponse;
  } catch {
    return {};
  }
}

function sameWallet(first: string | undefined, second: string): boolean {
  return Boolean(first && first.toLowerCase() === second.toLowerCase());
}

/**
 * Whether a wallet session already exists, WITHOUT asking the wallet to sign.
 *
 * Reading whether Strava is connected must not pop a signature request the moment the page loads. This
 * answers from the existing cookie only, so an unauthenticated visitor simply sees the connect button.
 */
export async function hasWalletSession(walletAddress: string): Promise<boolean> {
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) return false;
  try {
    const response = await fetch(`/api/auth/session?${new URLSearchParams({ walletAddress })}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    const session = await responseJson(response);
    return response.ok && Boolean(session.authenticated) && sameWallet(session.walletAddress, walletAddress);
  } catch {
    return false;
  }
}

export async function ensureWalletSession(
  walletAddress: string,
  signMessage: SignWalletMessage,
): Promise<void> {
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) throw new Error("Connect a valid wallet first");
  const query = new URLSearchParams({ walletAddress });
  const existingResponse = await fetch(`/api/auth/session?${query}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  const existing = await responseJson(existingResponse);
  if (existingResponse.ok && existing.authenticated && sameWallet(existing.walletAddress, walletAddress)) return;

  const challengeResponse = await fetch(`/api/auth/challenge?${query}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  const challenge = await responseJson(challengeResponse) as WalletSessionResponse & {
    challenge?: string;
    message?: string;
  };
  if (!challengeResponse.ok || !challenge.challenge || !challenge.message) {
    throw new Error(challenge.error || "Wallet authentication is unavailable");
  }

  const signature = await signMessage(challenge.message);
  const sessionResponse = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ challenge: challenge.challenge, signature }),
  });
  const session = await responseJson(sessionResponse);
  if (!sessionResponse.ok || !session.authenticated || !sameWallet(session.walletAddress, walletAddress)) {
    throw new Error(session.error || "Wallet authentication failed");
  }
}
