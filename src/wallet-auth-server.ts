import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";

export const WALLET_AUTH_CHAIN_ID = 143;
export const WALLET_AUTH_CHALLENGE_TTL_MS = 5 * 60_000;
export const WALLET_AUTH_SESSION_TTL_MS = 12 * 60 * 60_000;
export const WALLET_AUTH_COOKIE_NAME = "__Host-lock-in-wallet-session";

type WalletAuthEnvironment = {
  [name: string]: string | undefined;
  SESSION_SIGNING_SECRET?: string;
  CANARY_ALLOWED_WALLETS?: string;
};

type WalletAuthChallengePayload = {
  v: 1;
  kind: "challenge";
  walletAddress: Address;
  origin: string;
  chainId: typeof WALLET_AUTH_CHAIN_ID;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type WalletAuthSession = {
  v: 1;
  kind: "session";
  walletAddress: Address;
  origin: string;
  chainId: typeof WALLET_AUTH_CHAIN_ID;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type WalletAuthChallenge = {
  challenge: string;
  message: string;
  walletAddress: Address;
  expiresAt: string;
};

export type IssuedWalletAuthSession = {
  token: string;
  walletAddress: Address;
  expiresAt: string;
};

type TokenPurpose = "challenge" | "session";

export class WalletAuthError extends Error {
  readonly status: 400 | 401 | 403 | 503;

  constructor(message: string, status: 400 | 401 | 403 | 503 = 401) {
    super(message);
    this.name = "WalletAuthError";
    this.status = status;
  }
}

function environmentSecret(environment: WalletAuthEnvironment): string {
  const value = environment.SESSION_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new WalletAuthError("Wallet authentication is unavailable", 503);
  }
  return value;
}

function normalizedOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    return parsed.origin;
  } catch {
    throw new WalletAuthError("Invalid authentication origin", 400);
  }
}

export function walletAuthOriginFromRequest(request: Request): string {
  return normalizedOrigin(new URL(request.url).origin);
}

function normalizedWallet(value: string): Address {
  if (!isAddress(value)) throw new WalletAuthError("Enter a valid wallet address", 400);
  return getAddress(value);
}

function allowedWallets(environment: WalletAuthEnvironment): Set<string> | null {
  const configured = environment.CANARY_ALLOWED_WALLETS?.trim();
  if (!configured) return null;
  const values = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !isAddress(value))) {
    throw new WalletAuthError("Wallet authentication is unavailable", 503);
  }
  return new Set(values.map((value) => getAddress(value).toLowerCase()));
}

export function assertCanaryWalletAllowed(
  walletAddress: string,
  environment: WalletAuthEnvironment = process.env,
): Address {
  const wallet = normalizedWallet(walletAddress);
  const allowed = allowedWallets(environment);
  if (allowed && !allowed.has(wallet.toLowerCase())) {
    throw new WalletAuthError("This wallet is not enabled for the current canary", 403);
  }
  return wallet;
}

function signatureFor(encoded: string, purpose: TokenPurpose, environment: WalletAuthEnvironment): string {
  return createHmac("sha256", environmentSecret(environment))
    .update(`lock-in-wallet-auth:${purpose}:schema-1:${encoded}`)
    .digest("base64url");
}

function issueToken(payload: WalletAuthChallengePayload | WalletAuthSession, environment: WalletAuthEnvironment): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signatureFor(encoded, payload.kind, environment)}`;
}

function decodeToken(token: string, purpose: TokenPurpose, environment: WalletAuthEnvironment): unknown {
  if (typeof token !== "string" || token.length < 16 || token.length > 8 * 1_024) {
    throw new WalletAuthError(`Invalid wallet ${purpose}`, 401);
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new WalletAuthError(`Invalid wallet ${purpose}`, 401);
  const [encoded, supplied] = parts;
  const expected = signatureFor(encoded, purpose, environment);
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new WalletAuthError(`Invalid wallet ${purpose}`, 401);
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new WalletAuthError(`Invalid wallet ${purpose}`, 401);
  }
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseChallengePayload(
  challenge: string,
  environment: WalletAuthEnvironment,
  nowMs: number,
): WalletAuthChallengePayload {
  const value = decodeToken(challenge, "challenge", environment) as Partial<WalletAuthChallengePayload>;
  if (
    value.v !== 1 || value.kind !== "challenge" || value.chainId !== WALLET_AUTH_CHAIN_ID
      || typeof value.walletAddress !== "string" || !isAddress(value.walletAddress)
      || typeof value.origin !== "string" || normalizedOrigin(value.origin) !== value.origin
      || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/i.test(value.nonce)
      || !validTimestamp(value.issuedAtMs) || !validTimestamp(value.expiresAtMs)
      || Number(value.expiresAtMs) - Number(value.issuedAtMs) !== WALLET_AUTH_CHALLENGE_TTL_MS
      || Number(value.issuedAtMs) > nowMs + 60_000
      || nowMs >= Number(value.expiresAtMs)
  ) {
    throw new WalletAuthError("Invalid or expired wallet challenge", 401);
  }
  return { ...value, walletAddress: getAddress(value.walletAddress) } as WalletAuthChallengePayload;
}

function parseSessionPayload(
  token: string,
  environment: WalletAuthEnvironment,
  nowMs: number,
): WalletAuthSession {
  const value = decodeToken(token, "session", environment) as Partial<WalletAuthSession>;
  if (
    value.v !== 1 || value.kind !== "session" || value.chainId !== WALLET_AUTH_CHAIN_ID
      || typeof value.walletAddress !== "string" || !isAddress(value.walletAddress)
      || typeof value.origin !== "string" || normalizedOrigin(value.origin) !== value.origin
      || !validTimestamp(value.issuedAtMs) || !validTimestamp(value.expiresAtMs)
      || Number(value.expiresAtMs) - Number(value.issuedAtMs) !== WALLET_AUTH_SESSION_TTL_MS
      || Number(value.issuedAtMs) > nowMs + 60_000
      || nowMs >= Number(value.expiresAtMs)
  ) {
    throw new WalletAuthError("Wallet session is missing or expired", 401);
  }
  return { ...value, walletAddress: getAddress(value.walletAddress) } as WalletAuthSession;
}

function challengeMessage(payload: WalletAuthChallengePayload): string {
  const domain = new URL(payload.origin).host;
  return [
    "Lock In wallet authentication",
    "",
    "Sign this message to let this browser check in your runs for 12 hours.",
    "This does not submit a transaction, approve tokens, or move funds.",
    "",
    `Domain: ${domain}`,
    `Origin: ${payload.origin}`,
    `Wallet: ${payload.walletAddress}`,
    `Chain ID: ${payload.chainId}`,
    `Nonce: ${payload.nonce}`,
    `Issued At: ${new Date(payload.issuedAtMs).toISOString()}`,
    `Expiration Time: ${new Date(payload.expiresAtMs).toISOString()}`,
  ].join("\n");
}

export function createWalletAuthChallenge(input: {
  walletAddress: string;
  origin: string;
  nowMs?: number;
  nonce?: string;
  environment?: WalletAuthEnvironment;
}): WalletAuthChallenge {
  const environment = input.environment || process.env;
  const walletAddress = assertCanaryWalletAllowed(input.walletAddress, environment);
  const origin = normalizedOrigin(input.origin);
  const nowMs = input.nowMs ?? Date.now();
  const nonce = input.nonce || randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/i.test(nonce)) throw new WalletAuthError("Invalid authentication nonce", 400);
  const payload: WalletAuthChallengePayload = {
    v: 1,
    kind: "challenge",
    walletAddress,
    origin,
    chainId: WALLET_AUTH_CHAIN_ID,
    nonce: nonce.toLowerCase(),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + WALLET_AUTH_CHALLENGE_TTL_MS,
  };
  return {
    challenge: issueToken(payload, environment),
    message: challengeMessage(payload),
    walletAddress,
    expiresAt: new Date(payload.expiresAtMs).toISOString(),
  };
}

export function verifyWalletAuthChallenge(input: {
  challenge: string;
  origin: string;
  nowMs?: number;
  environment?: WalletAuthEnvironment;
}): WalletAuthChallengePayload {
  const environment = input.environment || process.env;
  const payload = parseChallengePayload(input.challenge, environment, input.nowMs ?? Date.now());
  if (payload.origin !== normalizedOrigin(input.origin)) throw new WalletAuthError("Wallet challenge origin changed", 401);
  assertCanaryWalletAllowed(payload.walletAddress, environment);
  return payload;
}

export async function issueWalletAuthSession(input: {
  challenge: string;
  signature: string;
  origin: string;
  nowMs?: number;
  environment?: WalletAuthEnvironment;
}): Promise<IssuedWalletAuthSession> {
  const environment = input.environment || process.env;
  const nowMs = input.nowMs ?? Date.now();
  const payload = verifyWalletAuthChallenge({
    challenge: input.challenge,
    origin: input.origin,
    nowMs,
    environment,
  });
  if (!/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(input.signature)) {
    throw new WalletAuthError("Invalid wallet signature", 401);
  }
  let valid = false;
  try {
    valid = await verifyMessage({
      address: payload.walletAddress,
      message: challengeMessage(payload),
      signature: input.signature as Hex,
    });
  } catch {
    valid = false;
  }
  if (!valid) throw new WalletAuthError("Wallet signature does not match the requested address", 401);
  const session: WalletAuthSession = {
    v: 1,
    kind: "session",
    walletAddress: payload.walletAddress,
    origin: payload.origin,
    chainId: WALLET_AUTH_CHAIN_ID,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + WALLET_AUTH_SESSION_TTL_MS,
  };
  return {
    token: issueToken(session, environment),
    walletAddress: session.walletAddress,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
  };
}

export function verifyWalletAuthSessionToken(input: {
  token: string;
  walletAddress: string;
  origin: string;
  nowMs?: number;
  environment?: WalletAuthEnvironment;
}): WalletAuthSession {
  const environment = input.environment || process.env;
  const session = parseSessionPayload(input.token, environment, input.nowMs ?? Date.now());
  const expectedWallet = assertCanaryWalletAllowed(input.walletAddress, environment);
  if (session.walletAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new WalletAuthError("Wallet session belongs to another address", 401);
  }
  if (session.origin !== normalizedOrigin(input.origin)) throw new WalletAuthError("Wallet session origin changed", 401);
  assertCanaryWalletAllowed(session.walletAddress, environment);
  return session;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return entry.slice(separator + 1).trim() || null;
  }
  return null;
}

export function requireWalletAuthSession(
  request: Request,
  walletAddress: string,
  environment: WalletAuthEnvironment = process.env,
  nowMs = Date.now(),
): WalletAuthSession {
  const token = cookieValue(request, WALLET_AUTH_COOKIE_NAME);
  if (!token) throw new WalletAuthError("Wallet authentication is required", 401);
  return verifyWalletAuthSessionToken({
    token,
    walletAddress,
    origin: walletAuthOriginFromRequest(request),
    nowMs,
    environment,
  });
}

export function walletAuthErrorStatus(error: unknown): number | null {
  return error instanceof WalletAuthError ? error.status : null;
}

export function walletAuthPublicMessage(error: unknown): string {
  if (!(error instanceof WalletAuthError)) return "Wallet authentication failed";
  if (error.status === 503) return "Wallet authentication is temporarily unavailable";
  return error.message;
}
