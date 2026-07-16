import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for Strava OAuth tokens at rest.
 *
 * A refresh token is a long-lived key to a person's activity history, so it never touches the database in
 * the clear, never reaches the client, and never enters a log. AES-256-GCM is authenticated: a tampered
 * ciphertext fails to decrypt rather than decrypting to something attacker-chosen.
 *
 * The key lives only in STRAVA_TOKEN_ENCRYPTION_KEY. Rotating or losing it makes every stored token
 * unreadable and forces each athlete to reconnect Strava, which is the intended failure mode: unreadable
 * beats silently readable by the wrong party.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const VERSION = "v1";

export class StravaCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaCryptoError";
  }
}

export function stravaEncryptionKey(value = process.env.STRAVA_TOKEN_ENCRYPTION_KEY): Buffer {
  const raw = value?.trim();
  if (!raw) throw new StravaCryptoError("STRAVA_TOKEN_ENCRYPTION_KEY is not configured");
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new StravaCryptoError("STRAVA_TOKEN_ENCRYPTION_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new StravaCryptoError(
      `STRAVA_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version prefix exists so a future key or
 * algorithm change can be told apart from a corrupt value instead of guessed at.
 */
export function encryptStravaToken(plaintext: string, key = stravaEncryptionKey()): string {
  if (!plaintext) throw new StravaCryptoError("Refusing to encrypt an empty token");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptStravaToken(envelope: string, key = stravaEncryptionKey()): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new StravaCryptoError("Stored token is not a recognised encryption envelope");
  }
  const [, rawIv, rawTag, rawCiphertext] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(rawIv, "base64url"));
    decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(rawCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Authentication failure and a wrong key are indistinguishable here, and deliberately so: both mean
    // this value cannot be trusted.
    throw new StravaCryptoError("Stored token could not be decrypted with the configured key");
  }
}
