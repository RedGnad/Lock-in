import { keccak256, stringToHex } from "viem";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_BASE = 32n;
const MIN_BODY_LENGTH = 4;
const MAX_UINT256 = (1n << 256n) - 1n;
const CHECKSUM_MASK = 0x3ffn;

function encodeCrockford(value: bigint) {
  if (value === 0n) return "0";

  let remaining = value;
  let encoded = "";
  while (remaining > 0n) {
    encoded = CROCKFORD_ALPHABET[Number(remaining % CROCKFORD_BASE)] + encoded;
    remaining /= CROCKFORD_BASE;
  }
  return encoded;
}

function checksumFor(body: string) {
  const digest = BigInt(keccak256(stringToHex(`lock-in-invite:${body}`)));
  return encodeCrockford(digest & CHECKSUM_MASK).padStart(2, "0");
}

/**
 * Encodes a uint256 Lock ID as a compact, typo-resistant social invite code.
 * The Crockford body is lossless; the two-character checksum is not identity.
 */
export function encodeLockInviteCode(pactId: bigint) {
  if (pactId < 1n || pactId > MAX_UINT256) throw new RangeError("Lock ID must be a positive uint256");

  const body = encodeCrockford(pactId).padStart(MIN_BODY_LENGTH, "0");
  return `LOCK-${body}-${checksumFor(body)}`;
}

/**
 * Strictly decodes a canonical invite code. Lowercase, ambiguous Crockford
 * characters, alternate padding and invalid checksums are deliberately rejected.
 */
export function decodeLockInviteCode(code: string): bigint | null {
  const match = /^LOCK-([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4,52})-([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{2})$/.exec(code);
  if (!match) return null;

  let pactId = 0n;
  for (const character of match[1]) {
    const digit = CROCKFORD_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    pactId = pactId * CROCKFORD_BASE + BigInt(digit);
    if (pactId > MAX_UINT256) return null;
  }

  if (pactId < 1n || match[2] !== checksumFor(match[1])) return null;

  // One Lock ID has exactly one invite code, so aliases with extra zeroes fail.
  return encodeLockInviteCode(pactId) === code ? pactId : null;
}
