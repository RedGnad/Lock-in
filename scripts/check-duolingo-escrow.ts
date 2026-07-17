import "dotenv/config";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "../src/lock-in-abi.js";
import { lockInDuolingoAbi } from "../src/lock-in-duolingo-abi.js";
import { DUOLINGO_XP_SCHEME, missionPolicyHash } from "../src/duolingo-attestation.js";

/**
 * The release gate for LockInDuolingoEscrow (contract B, real USDC).
 *
 * It is the second, on-chain half of the guard the Strava config-hash bug lacked: the EIP-712 parity is
 * pinned in the test suite, and here every pinned value is re-read from the DEPLOYED contract and compared
 * to the TypeScript attestation module. It also refuses to green-light a deploy that is not FULLY PAUSED,
 * whose owner is not the Safe, or whose evidence signer is not the exact expected key. Run after a paused
 * deploy, before any Safe transaction opens a pause.
 *
 * Usage: pnpm gate:duolingo   (needs NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS pointing at the deployed B)
 */

const CHAIN_ID = 143;
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const STRAVA_ESCROW = "0xD37121112F240fE03a18D754B2fdB9dC750034d4".toLowerCase();

const BASELINE_TYPEHASH = keccak256(stringToHex(
  "Baseline(address account,bytes32 configHash,bytes32 identityHash,bytes32 nullifier,uint64 issuedAt,uint64 expiresAt)",
));
const FINAL_TYPEHASH = keccak256(stringToHex(
  "Final(uint256 pactId,address account,bytes32 identityHash,uint32 earnedXp,uint32 targetXp,bytes32 nullifier,uint64 occurredAt,uint64 issuedAt,uint64 expiresAt)",
));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function requiredAddress(name: string): Address {
  const value = required(name);
  if (!isAddress(value)) throw new Error(`${name} is invalid`);
  return getAddress(value);
}
function requiredHash(name: string): Hash {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  return value.toLowerCase() as Hash;
}

/** The expected evidence signer: derived from the private key if present, else the pinned public address. */
function expectedEvidenceSigner(): Address {
  const key = process.env.DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY?.trim();
  if (key) {
    const value = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY is invalid");
    return privateKeyToAccount(value).address;
  }
  return requiredAddress("DUOLINGO_EVIDENCE_SIGNER_ADDRESS");
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
if (Number(process.env.MONAD_CHAIN_ID?.trim() || String(CHAIN_ID)) !== CHAIN_ID) throw new Error("MONAD_CHAIN_ID must be 143");

const escrow = requiredAddress(process.env.NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS ? "NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS" : "DUOLINGO_ESCROW_ADDRESS");
if (escrow.toLowerCase() === STRAVA_ESCROW) throw new Error("The Duolingo escrow address must not be the Strava escrow");
const expectedOwner = requiredAddress("LOCK_IN_OWNER_ADDRESS");
const expectedCodeHash = requiredHash("DUOLINGO_ESCROW_CODE_HASH");
const expectedSigner = expectedEvidenceSigner();

// Backend and client configuration that must exist for the escrow to function and stay closed to outsiders.
const allowlist = required("DUOLINGO_ESCROW_ALLOWED_WALLETS").split(",").map((v) => v.trim()).filter(Boolean);
if (allowlist.length === 0 || allowlist.some((v) => !isAddress(v))) throw new Error("DUOLINGO_ESCROW_ALLOWED_WALLETS is invalid");
if (required("SESSION_SIGNING_SECRET").length < 32) throw new Error("SESSION_SIGNING_SECRET must be at least 32 chars");
if (Buffer.from(required("DUOLINGO_IDENTITY_HMAC_KEY"), "base64").length !== 32) throw new Error("DUOLINGO_IDENTITY_HMAC_KEY must be 32 bytes base64");
const reclaimConfigured = Boolean(process.env.ID?.trim() && process.env.SECRET?.trim());
// The financial runtime has no DATABASE_URL fallback, so the gate requires the dedicated variable too.
const escrowDbConfigured = Boolean(process.env.DUOLINGO_ESCROW_DATABASE_URL?.trim());

const chain = defineChain({ id: CHAIN_ID, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const observedBlock = await client.getBlock({ blockTag: "latest" });
const at = { blockNumber: observedBlock.number } as const;

const constAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "CONTRACT_SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DUOLINGO_XP_SCHEME", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "BASELINE_TYPEHASH", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "FINAL_TYPEHASH", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "missionPolicyHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "MIN_PARTICIPANTS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "MAX_PARTICIPANTS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "MIN_TARGET_XP", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MAX_TARGET_XP", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MIN_DURATION_SECONDS", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MAX_DURATION_SECONDS", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "MAX_START_DELAY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "SUBMISSION_GRACE_PERIOD", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_ATTESTATION_AGE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_CLOCK_SKEW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const read = (functionName: string) => client.readContract({ address: escrow, abi: lockInDuolingoAbi, functionName: functionName as never, ...at }) as Promise<unknown>;
const readConst = (name: string) => client.readContract({ address: escrow, abi: constAbi, functionName: name as never, ...at }) as Promise<unknown>;

const [chainId, code] = await Promise.all([client.getChainId(), client.getCode({ address: escrow, ...at })]);
const [stakeToken, minStake, maxStake, evidenceSigner, creationPaused, joiningPaused, completionPaused] = await Promise.all([
  read("stakeToken"), read("MIN_STAKE"), read("MAX_STAKE"), read("evidenceSigner"),
  read("creationPaused"), read("joiningPaused"), read("completionPaused"),
]) as [Address, bigint, bigint, Address, boolean, boolean, boolean];
const [owner, schemaId, scheme, baselineTh, finalTh, policyHash, minP, maxP, minXp, maxXp, minDur, maxDur, maxStart, grace, maxAge, skew] = await Promise.all([
  readConst("owner"), readConst("CONTRACT_SCHEMA_ID"), readConst("DUOLINGO_XP_SCHEME"), readConst("BASELINE_TYPEHASH"),
  readConst("FINAL_TYPEHASH"), readConst("missionPolicyHash"), readConst("MIN_PARTICIPANTS"), readConst("MAX_PARTICIPANTS"),
  readConst("MIN_TARGET_XP"), readConst("MAX_TARGET_XP"), readConst("MIN_DURATION_SECONDS"), readConst("MAX_DURATION_SECONDS"),
  readConst("MAX_START_DELAY"), readConst("SUBMISSION_GRACE_PERIOD"), readConst("MAX_ATTESTATION_AGE"), readConst("MAX_CLOCK_SKEW"),
]) as [Address, bigint, Hash, Hash, Hash, Hash, number, number, number, number, number, number, bigint, bigint, bigint, bigint];

const [tokenDecimals, tokenSymbol, ownerCode] = await Promise.all([
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals", ...at }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol", ...at }),
  client.getCode({ address: expectedOwner, ...at }),
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const checks = {
  chainId: chainId === CHAIN_ID,
  escrowDeployed: Boolean(code && code !== "0x"),
  escrowCodeHash: Boolean(code && code !== "0x") && keccak256(code as Hex) === expectedCodeHash,
  notStravaEscrow: !same(escrow, STRAVA_ESCROW) && !same(getAddress(stakeToken), zeroAddress),
  usdcCanonical: getAddress(stakeToken) === EXPECTED_USDC,
  usdcMetadata: tokenDecimals === 6 && tokenSymbol === "USDC",
  stakeBounds: minStake === 100_000n && maxStake === 1_000_000n,
  contractSchema: schemaId === 1n,
  // EIP-712 parity: the deployed contract must agree with the TypeScript attestation module byte for byte.
  schemeParity: same(scheme, DUOLINGO_XP_SCHEME),
  policyParity: same(policyHash, missionPolicyHash()),
  baselineTypehashParity: same(baselineTh, BASELINE_TYPEHASH),
  finalTypehashParity: same(finalTh, FINAL_TYPEHASH),
  participantBounds: minP === 2 && maxP === 100,
  targetBounds: minXp === 10 && maxXp === 1_000_000,
  durationBounds: minDur === 1_800 && maxDur === 2_592_000,
  temporalBounds: maxStart === 86_400n && grace === 3_600n && maxAge === 600n && skew === 60n,
  ownerIsSafe: getAddress(owner) === expectedOwner && Boolean(ownerCode && ownerCode !== "0x"),
  evidenceSignerExact: same(getAddress(evidenceSigner), expectedSigner),
  evidenceSignerNotOwner: !same(getAddress(evidenceSigner), expectedOwner),
  fullyPaused: creationPaused === true && joiningPaused === true && completionPaused === true,
  allowlistConfigured: allowlist.length > 0,
  reclaimConfigured,
  escrowDbConfigured,
};

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
console.log(JSON.stringify({
  ok: failed.length === 0,
  observedAtBlock: observedBlock.number.toString(),
  escrow,
  escrowRuntimeCodeHash: code && code !== "0x" ? keccak256(code as Hex) : null,
  stakeToken: getAddress(stakeToken),
  owner: getAddress(owner),
  evidenceSigner: getAddress(evidenceSigner),
  contractPauses: { creation: creationPaused, joining: joiningPaused, completion: completionPaused },
  scheme: "DUOLINGO_ZKTLS_DELTA_V1",
  checks,
  failed,
}, null, 2));
if (failed.length > 0) throw new Error(`Duolingo escrow gate failed: ${failed.join(", ")}`);
