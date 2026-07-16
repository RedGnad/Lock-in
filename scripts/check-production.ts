import "dotenv/config";
import { createPublicClient, defineChain, getAddress, http, isAddress, keccak256, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, lockInAbi } from "../src/lock-in-abi.js";
import { readProductFlagState } from "../src/product-flags.js";
import { releaseMetadataAbi } from "./release-contract.js";

const CHAIN_ID = 143;
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");

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

function signerAddress(name: "EVIDENCE_SIGNER_PRIVATE_KEY" | "ACCESS_SIGNER_PRIVATE_KEY"): Address {
  const raw = required(name);
  const value = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  return privateKeyToAccount(value).address;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const configuredChainId = Number(process.env.MONAD_CHAIN_ID?.trim() || String(CHAIN_ID));
if (configuredChainId !== CHAIN_ID) throw new Error("MONAD_CHAIN_ID must be 143");
const escrow = requiredAddress("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS");
const configuredToken = requiredAddress("STAKE_TOKEN_ADDRESS");
const expectedOwner = requiredAddress("LOCK_IN_OWNER_ADDRESS");
const expectedDeployer = requiredAddress("LOCK_IN_DEPLOYER_ADDRESS");
const expectedEscrowCodeHash = requiredHash("LOCK_IN_ESCROW_CODE_HASH");
required("NEXT_PUBLIC_PRIVACY_EMAIL");
required("NEXT_PUBLIC_REPOSITORY_URL");
if (required("SESSION_SIGNING_SECRET").length < 32) {
  throw new Error("SESSION_SIGNING_SECRET must contain at least 32 characters");
}
const expectedEvidenceSigner = signerAddress("EVIDENCE_SIGNER_PRIVATE_KEY");
const expectedAccessSigner = signerAddress("ACCESS_SIGNER_PRIVATE_KEY");
if (expectedEvidenceSigner === expectedAccessSigner) throw new Error("Evidence and access signing keys must be distinct");
if (expectedOwner === expectedDeployer || expectedOwner === expectedEvidenceSigner || expectedOwner === expectedAccessSigner) {
  throw new Error("LOCK_IN_OWNER_ADDRESS must be distinct from the deployer and both application signers");
}
if (expectedDeployer === expectedEvidenceSigner || expectedDeployer === expectedAccessSigner) {
  throw new Error("LOCK_IN_DEPLOYER_ADDRESS must be distinct from both application signers");
}

const product = readProductFlagState();
if (!product.configuration.allConfigured) throw new Error("All product action flags must be explicitly true or false");
const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const observedBlock = await client.getBlock({ blockTag: "latest" });
const atObservedBlock = { blockNumber: observedBlock.number } as const;

const [
  chainId,
  escrowCode,
  stakeToken,
  minStake,
  maxStake,
  schemaId,
  maxDays,
  maxParticipants,
  submissionGracePeriod,
  owner,
  evidenceSigner,
  accessSigner,
  creationPaused,
  joiningPaused,
  completionPaused,
] = await Promise.all([
  client.getChainId(),
  client.getCode({ address: escrow, ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "stakeToken", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MIN_STAKE", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MAX_STAKE", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "CONTRACT_SCHEMA_ID", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MAX_DURATION_DAYS", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: releaseMetadataAbi, functionName: "MAX_PARTICIPANTS", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: releaseMetadataAbi, functionName: "SUBMISSION_GRACE_PERIOD", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: releaseMetadataAbi, functionName: "owner", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "evidenceSigner", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "accessSigner", ...atObservedBlock }),

  client.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "completionPaused", ...atObservedBlock }),
]);
const [tokenCode, tokenDecimals, tokenSymbol] = await Promise.all([
  client.getCode({ address: stakeToken, ...atObservedBlock }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals", ...atObservedBlock }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol", ...atObservedBlock }),
]);
const ownerCode = await client.getCode({ address: getAddress(owner), ...atObservedBlock });
const checks = {
  chainId: chainId === CHAIN_ID,
  escrowCode: Boolean(escrowCode && escrowCode !== "0x"),
  escrowCodeHash: Boolean(escrowCode && escrowCode !== "0x")
    && keccak256(escrowCode as Hex) === expectedEscrowCodeHash,
  tokenCode: Boolean(tokenCode && tokenCode !== "0x"),
  configuredTokenCanonical: configuredToken === EXPECTED_USDC,
  contractTokenCanonical: getAddress(stakeToken) === EXPECTED_USDC,
  usdcMetadata: tokenDecimals === 6 && tokenSymbol === "USDC",
  stakeBounds: minStake === 100_000n && maxStake === 1_000_000n,
  contractSchema: schemaId === 1n,
  participantCapacity: maxParticipants === 100,
  submissionGracePeriod: submissionGracePeriod === 86_400n,
  stravaOAuthConfigured: Boolean(process.env.STRAVA_CLIENT_ID?.trim() && process.env.STRAVA_CLIENT_SECRET?.trim()),
  tokenEncryptionConfigured: Buffer.from(required("STRAVA_TOKEN_ENCRYPTION_KEY"), "base64").length === 32,
  tokenStorageConfigured: Boolean(process.env.DATABASE_URL?.trim()),
  ownerConfigured: expectedOwner !== zeroAddress && getAddress(owner) === expectedOwner,
  ownerContract: Boolean(ownerCode && ownerCode !== "0x"),
  ownerSeparated:
    getAddress(owner) !== expectedDeployer
    && getAddress(owner) !== getAddress(evidenceSigner)
    && getAddress(owner) !== getAddress(accessSigner),
  thirtyDayPrograms: maxDays === 30,
  productFlagsConfigured: product.configuration.allConfigured,
  flagPauseAlignment:
    creationPaused === !product.actions.newPacts
    && joiningPaused === !product.actions.join
    && completionPaused === !product.actions.checkIns,
};
if (!Object.values(checks).every(Boolean)) {
  throw new Error(`Production check failed: ${JSON.stringify(checks)}`);
}

console.log(JSON.stringify({
  ok: true,
  chainId,
  observedAtBlock: observedBlock.number.toString(),
  escrow,
  escrowRuntimeCodeHash: keccak256(escrowCode as Hex),
  contractSchemaId: schemaId.toString(),
  stakeToken: getAddress(stakeToken),
  minStakeAtomicUnits: minStake.toString(),
  maxStakeAtomicUnits: maxStake.toString(),
  maxParticipants,
  submissionGracePeriodSeconds: submissionGracePeriod.toString(),
  owner: getAddress(owner),
  evidenceSigner: getAddress(evidenceSigner),
  accessSigner: getAddress(accessSigner),
  verification: { scheme: "STRAVA_OAUTH_V1", source: "Strava API over the athlete's OAuth grant" },
  actions: product.actions,
  contractPauses: {
    creation: creationPaused,
    joining: joiningPaused,
    completion: completionPaused,
  },
  checks,
}, null, 2));
