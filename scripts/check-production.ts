import "dotenv/config";
import { createPublicClient, defineChain, getAddress, http, isAddress, keccak256, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, lockInAbi } from "../src/lock-in-abi.js";
import { readProductFlagState } from "../src/product-flags.js";
import { DUOLINGO_PROVIDER_ID } from "../src/duolingo-proof-policy.js";
import { releaseMetadataAbi } from "./release-contract.js";

const CHAIN_ID = 143;
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const EXPECTED_RECLAIM_WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");
const EXPECTED_STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const EXPECTED_STRAVA_PROVIDER_VERSION = "1.0.3";
const EXPECTED_DUOLINGO_PROVIDER_VERSION = "1.0.3";
const EXPECTED_DUOLINGO_PROVIDER_HASH = "0x3b307716fa21be0484af45041f9288da0cbf09aa41ca2aa21ec5b83d98a34b80";

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
const expectedStravaVerifier = requiredAddress("LOCK_IN_STRAVA_VERIFIER_ADDRESS");
const expectedDuolingoVerifier = requiredAddress("LOCK_IN_DUOLINGO_VERIFIER_ADDRESS");
const expectedStravaParser = requiredAddress("LOCK_IN_STRAVA_PARSER_ADDRESS");
const expectedStravaParserCodeHash = requiredHash("LOCK_IN_STRAVA_PARSER_CODE_HASH");
const expectedStravaVerifierCodeHash = requiredHash("LOCK_IN_STRAVA_VERIFIER_CODE_HASH");
const expectedDuolingoVerifierCodeHash = requiredHash("LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH");
const configuredReclaimWitness = requiredAddress("RECLAIM_WITNESS_ADDRESS");
if (configuredReclaimWitness !== EXPECTED_RECLAIM_WITNESS) {
  throw new Error("RECLAIM_WITNESS_ADDRESS does not match the audited pinned witness");
}
required("NEXT_PUBLIC_PRIVACY_EMAIL");
required("NEXT_PUBLIC_REPOSITORY_URL");
required("ID");
required("SECRET");
if (required("SESSION_SIGNING_SECRET").length < 32) {
  throw new Error("SESSION_SIGNING_SECRET must contain at least 32 characters");
}
if (required("DUOLINGO_PROVIDER_ID") !== DUOLINGO_PROVIDER_ID) {
  throw new Error("Duolingo provider does not match the pinned ID");
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
const verifierAbi = [
  { type: "function", name: "WITNESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "PARSER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

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
  stravaVerifier,
  duolingoVerifier,
  creationPaused,
  joiningPaused,
  baselinePaused,
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
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "stravaVerifier", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "duolingoVerifier", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "baselinePaused", ...atObservedBlock }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "completionPaused", ...atObservedBlock }),
]);
const [tokenCode, tokenDecimals, tokenSymbol] = await Promise.all([
  client.getCode({ address: stakeToken, ...atObservedBlock }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals", ...atObservedBlock }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol", ...atObservedBlock }),
]);
const ownerCode = await client.getCode({ address: getAddress(owner), ...atObservedBlock });
const observedStravaVerifier = getAddress(stravaVerifier);
const observedDuolingoVerifier = getAddress(duolingoVerifier);
const [
  stravaVerifierCode,
  duolingoVerifierCode,
  stravaLive,
  duolingoLive,
  stravaWitness,
  duolingoWitness,
  stravaProviderId,
  stravaProviderVersion,
  duolingoProviderId,
  duolingoProviderVersion,
  duolingoProviderHash,
  stravaParserRaw,
] = await Promise.all([
  client.getCode({ address: observedStravaVerifier, ...atObservedBlock }),
  client.getCode({ address: observedDuolingoVerifier, ...atObservedBlock }),
  client.readContract({ address: observedStravaVerifier, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", ...atObservedBlock }),
  client.readContract({ address: observedDuolingoVerifier, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", ...atObservedBlock }),
  client.readContract({ address: observedStravaVerifier, abi: verifierAbi, functionName: "WITNESS", ...atObservedBlock }),
  client.readContract({ address: observedDuolingoVerifier, abi: verifierAbi, functionName: "WITNESS", ...atObservedBlock }),
  client.readContract({ address: observedStravaVerifier, abi: verifierAbi, functionName: "STRAVA_PROVIDER_ID", ...atObservedBlock }),
  client.readContract({ address: observedStravaVerifier, abi: verifierAbi, functionName: "STRAVA_PROVIDER_VERSION", ...atObservedBlock }),
  client.readContract({ address: observedDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_ID", ...atObservedBlock }),
  client.readContract({ address: observedDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_VERSION", ...atObservedBlock }),
  client.readContract({ address: observedDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_HASH", ...atObservedBlock }),
  client.readContract({ address: observedStravaVerifier, abi: verifierAbi, functionName: "PARSER", ...atObservedBlock }),
]);
const observedStravaParser = getAddress(stravaParserRaw);
const [stravaParserCode, stravaParserLive, stravaParserSchemaId, stravaParserProviderId, stravaParserProviderVersion] = await Promise.all([
  client.getCode({ address: observedStravaParser, ...atObservedBlock }),
  client.readContract({ address: observedStravaParser, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", ...atObservedBlock }),
  client.readContract({ address: observedStravaParser, abi: verifierAbi, functionName: "SCHEMA_ID", ...atObservedBlock }),
  client.readContract({ address: observedStravaParser, abi: verifierAbi, functionName: "STRAVA_PROVIDER_ID", ...atObservedBlock }),
  client.readContract({ address: observedStravaParser, abi: verifierAbi, functionName: "STRAVA_PROVIDER_VERSION", ...atObservedBlock }),
]);

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
  ownerConfigured: expectedOwner !== zeroAddress && getAddress(owner) === expectedOwner,
  ownerContract: Boolean(ownerCode && ownerCode !== "0x"),
  ownerSeparated:
    getAddress(owner) !== expectedDeployer
    && getAddress(owner) !== getAddress(evidenceSigner)
    && getAddress(owner) !== getAddress(accessSigner),
  evidenceSigner: getAddress(evidenceSigner) === expectedEvidenceSigner,
  accessSigner: getAddress(accessSigner) === expectedAccessSigner,
  signersSeparated: getAddress(evidenceSigner) !== getAddress(accessSigner),
  directVerifierBindings:
    observedStravaVerifier === expectedStravaVerifier
    && observedDuolingoVerifier === expectedDuolingoVerifier
    && observedStravaParser === expectedStravaParser
    && observedStravaVerifier !== observedDuolingoVerifier,
  directVerifierCode: Boolean(
    stravaVerifierCode && stravaVerifierCode !== "0x" && duolingoVerifierCode && duolingoVerifierCode !== "0x"
  ),
  directVerifierCodeHashes:
    Boolean(stravaVerifierCode && stravaVerifierCode !== "0x" && duolingoVerifierCode && duolingoVerifierCode !== "0x")
    && keccak256(stravaVerifierCode as Hex) === expectedStravaVerifierCodeHash
    && keccak256(duolingoVerifierCode as Hex) === expectedDuolingoVerifierCodeHash,
  directVerifierLiveSchemas: stravaLive && duolingoLive,
  directParser:
    Boolean(stravaParserCode && stravaParserCode !== "0x")
    && keccak256(stravaParserCode as Hex) === expectedStravaParserCodeHash
    && stravaParserLive
    && stravaParserSchemaId !== `0x${"00".repeat(32)}`
    && stravaParserProviderId === EXPECTED_STRAVA_PROVIDER_ID
    && stravaParserProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION,
  directVerifierWitnesses:
    getAddress(stravaWitness) === EXPECTED_RECLAIM_WITNESS
    && getAddress(duolingoWitness) === EXPECTED_RECLAIM_WITNESS,
  directVerifierProviders:
    stravaProviderId === EXPECTED_STRAVA_PROVIDER_ID
    && stravaProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION
    && duolingoProviderId === DUOLINGO_PROVIDER_ID
    && duolingoProviderVersion === EXPECTED_DUOLINGO_PROVIDER_VERSION
    && duolingoProviderHash === EXPECTED_DUOLINGO_PROVIDER_HASH,
  thirtyDayPrograms: maxDays === 30,
  productFlagsConfigured: product.configuration.allConfigured,
  flagPauseAlignment:
    creationPaused === !product.actions.newPacts
    && joiningPaused === !product.actions.join
    && baselinePaused === !(product.actions.newPacts || product.actions.join)
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
  directVerifiers: {
    stravaParser: { address: observedStravaParser, schemaId: stravaParserSchemaId, liveSchemaConfirmed: stravaParserLive },
    strava: { address: observedStravaVerifier, parser: observedStravaParser, liveSchemaConfirmed: stravaLive },
    duolingo: { address: observedDuolingoVerifier, liveSchemaConfirmed: duolingoLive },
    reclaimWitness: EXPECTED_RECLAIM_WITNESS,
  },
  actions: product.actions,
  contractPauses: {
    creation: creationPaused,
    joining: joiningPaused,
    baseline: baselinePaused,
    completion: completionPaused,
  },
  checks,
}, null, 2));
