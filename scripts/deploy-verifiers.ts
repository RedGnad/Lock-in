import "dotenv/config";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addMonadGasBuffer } from "../src/monad-gas.js";

const CHAIN_ID = 143;
const PINNED_WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");
const STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const STRAVA_PROVIDER_VERSION = "1.0.3";
const DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
const DUOLINGO_PROVIDER_VERSION = "1.0.4";
const DUOLINGO_OWNERSHIP_REQUEST_HASH = "0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e";
const DUOLINGO_XP_REQUEST_HASH = "0x1e2b7c4c1dbfe8694e49eee2c1e92ccac09ef048be735e5c54af7c006509b2ac";

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function localPrivateKey(): Hex {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim() || "";
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Missing valid DEPLOYER_PRIVATE_KEY or PRIVATE_KEY");
  return value as Hex;
}

function requiredAddress(name: string): Address {
  const value = process.env[name]?.trim() || "";
  if (!isAddress(value)) throw new Error(`${name} must be a valid address`);
  return getAddress(value);
}

async function artifact(path: string): Promise<Artifact> {
  const value = JSON.parse(await readFile(path, "utf8")) as Artifact;
  if (!value.bytecode.object || value.bytecode.object === "0x") throw new Error(`Missing bytecode in ${path}; run forge build`);
  return value;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const configuredChainId = Number(process.env.MONAD_CHAIN_ID?.trim() || String(CHAIN_ID));
if (configuredChainId !== CHAIN_ID) throw new Error("Lock In verifier deployments are pinned to Monad mainnet chain ID 143");
const deployer = privateKeyToAccount(localPrivateKey());
if (deployer.address !== requiredAddress("LOCK_IN_DEPLOYER_ADDRESS")) {
  throw new Error("The local deployer key does not match LOCK_IN_DEPLOYER_ADDRESS");
}
const configuredWitness = process.env.RECLAIM_WITNESS_ADDRESS?.trim();
if (configuredWitness && (!isAddress(configuredWitness) || getAddress(configuredWitness) !== PINNED_WITNESS)) {
  throw new Error("RECLAIM_WITNESS_ADDRESS does not match the audited pinned witness");
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
if (await publicClient.getChainId() !== CHAIN_ID) throw new Error("Refusing deployment on a non-Monad-mainnet RPC");

const [parserArtifact, stravaArtifact, duolingoArtifact, stravaSource, duolingoSource] = await Promise.all([
  artifact("out/LockInStravaReclaimVerifier.sol/LockInStravaClaimParser.json"),
  artifact("out/LockInStravaReclaimVerifier.sol/LockInStravaReclaimVerifier.json"),
  artifact("out/LockInReclaimVerifier.sol/LockInReclaimVerifier.json"),
  readFile("contracts/verifiers/LockInStravaReclaimVerifier.sol", "utf8"),
  readFile("contracts/verifiers/LockInReclaimVerifier.sol", "utf8"),
]);
const liveSourceGate = (stravaSource.match(/bool public constant LIVE_SCHEMA_CONFIRMED = true;/g) || []).length === 2
  && (duolingoSource.match(/bool public constant LIVE_SCHEMA_CONFIRMED = true;/g) || []).length === 1;
const artifactHashes = {
  parser: keccak256(parserArtifact.bytecode.object),
  strava: keccak256(stravaArtifact.bytecode.object),
  duolingo: keccak256(duolingoArtifact.bytecode.object),
};
const confirmation = `DEPLOY_LOCK_IN_VERIFIERS_${CHAIN_ID}_${deployer.address}_${PINNED_WITNESS}_${artifactHashes.parser}_${artifactHashes.strava}_${artifactHashes.duolingo}`;
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const unknown = args.filter((value) => value !== "--execute");
if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
if (execute && !liveSourceGate) {
  throw new Error("Execution refused: all three verifier/parser live-schema constants must be true after audited live-proof fixtures pass");
}
if (execute && process.env.CONFIRM_DEPLOY_VERIFIERS?.trim() !== confirmation) {
  throw new Error(`Execution refused. Set CONFIRM_DEPLOY_VERIFIERS exactly to ${confirmation}`);
}

const balance = await publicClient.getBalance({ address: deployer.address });
const plan = {
  chainId: CHAIN_ID,
  deployer: deployer.address,
  deployerBalanceWei: balance.toString(),
  witness: PINNED_WITNESS,
  liveSchemaSourceGate: liveSourceGate,
  providerSchemas: {
    strava: `${STRAVA_PROVIDER_ID}@${STRAVA_PROVIDER_VERSION}`,
    duolingo: {
      provider: `${DUOLINGO_PROVIDER_ID}@${DUOLINGO_PROVIDER_VERSION}`,
      ownershipRequestHash: DUOLINGO_OWNERSHIP_REQUEST_HASH,
      xpRequestHash: DUOLINGO_XP_REQUEST_HASH,
    },
  },
  artifactInitCodeHashes: artifactHashes,
  artifactInitCodeBytes: {
    parser: (parserArtifact.bytecode.object.length - 2) / 2,
    strava: (stravaArtifact.bytecode.object.length - 2) / 2,
    duolingo: (duolingoArtifact.bytecode.object.length - 2) / 2,
  },
  deploymentOrder: ["LockInStravaClaimParser", "LockInStravaReclaimVerifier", "LockInReclaimVerifier"],
};

if (!execute) {
  console.log(JSON.stringify({
    dryRun: true,
    executable: liveSourceGate,
    ...plan,
    confirmationRequired: confirmation,
    nextStep: liveSourceGate
      ? "Review the audited fixtures and this plan, set CONFIRM_DEPLOY_VERIFIERS, then rerun with --execute."
      : "Capture and audit both live app proof schemas; this deployment intentionally remains locked.",
  }, null, 2));
  process.exit(0);
}

async function deploy(name: string, value: Artifact, constructorArgs: readonly unknown[]) {
  const data = encodeDeployData({ abi: value.abi, bytecode: value.bytecode.object, args: constructorArgs } as never);
  const gasEstimate = await publicClient.estimateGas({ account: deployer, data });
  const gas = addMonadGasBuffer(gasEstimate);
  const gasPrice = await publicClient.getGasPrice();
  const currentBalance = await publicClient.getBalance({ address: deployer.address });
  if (currentBalance < gas * gasPrice) throw new Error(`Insufficient MON to deploy ${name}`);
  const hash = await walletClient.deployContract({
    account: deployer,
    abi: value.abi,
    bytecode: value.bytecode.object,
    args: constructorArgs,
    gas,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment failed`);
  const address = getAddress(receipt.contractAddress);
  const code = await publicClient.getCode({ address, blockNumber: receipt.blockNumber });
  if (!code || code === "0x") throw new Error(`${name} has no runtime code after deployment`);
  return {
    address,
    transactionHash: hash,
    blockNumber: receipt.blockNumber,
    gasEstimate,
    gasLimit: gas,
    runtimeCodeHash: keccak256(code),
  };
}

const parser = await deploy("LockInStravaClaimParser", parserArtifact, []);
const strava = await deploy("LockInStravaReclaimVerifier", stravaArtifact, [PINNED_WITNESS, parser.address]);
const duolingo = await deploy("LockInReclaimVerifier", duolingoArtifact, [PINNED_WITNESS]);

const metadataAbi = [
  { type: "function", name: "WITNESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "PARSER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_OWNERSHIP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_XP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const [
  parserLive,
  parserSchemaId,
  parserProviderId,
  parserProviderVersion,
  stravaLive,
  stravaWitness,
  stravaParser,
  stravaProviderId,
  stravaProviderVersion,
  duolingoLive,
  duolingoWitness,
  duolingoProviderId,
  duolingoProviderVersion,
  duolingoOwnershipRequestHash,
  duolingoXpRequestHash,
] = await Promise.all([
  publicClient.readContract({ address: parser.address, abi: metadataAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
  publicClient.readContract({ address: parser.address, abi: metadataAbi, functionName: "SCHEMA_ID" }),
  publicClient.readContract({ address: parser.address, abi: metadataAbi, functionName: "STRAVA_PROVIDER_ID" }),
  publicClient.readContract({ address: parser.address, abi: metadataAbi, functionName: "STRAVA_PROVIDER_VERSION" }),
  publicClient.readContract({ address: strava.address, abi: metadataAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
  publicClient.readContract({ address: strava.address, abi: metadataAbi, functionName: "WITNESS" }),
  publicClient.readContract({ address: strava.address, abi: metadataAbi, functionName: "PARSER" }),
  publicClient.readContract({ address: strava.address, abi: metadataAbi, functionName: "STRAVA_PROVIDER_ID" }),
  publicClient.readContract({ address: strava.address, abi: metadataAbi, functionName: "STRAVA_PROVIDER_VERSION" }),
  publicClient.readContract({ address: duolingo.address, abi: metadataAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
  publicClient.readContract({ address: duolingo.address, abi: metadataAbi, functionName: "WITNESS" }),
  publicClient.readContract({ address: duolingo.address, abi: metadataAbi, functionName: "DUOLINGO_PROVIDER_ID" }),
  publicClient.readContract({ address: duolingo.address, abi: metadataAbi, functionName: "DUOLINGO_PROVIDER_VERSION" }),
  publicClient.readContract({ address: duolingo.address, abi: metadataAbi, functionName: "DUOLINGO_OWNERSHIP_REQUEST_HASH" }),
  publicClient.readContract({ address: duolingo.address, abi: metadataAbi, functionName: "DUOLINGO_XP_REQUEST_HASH" }),
]);
if (
  !parserLive || !stravaLive || !duolingoLive
    || parserProviderId !== STRAVA_PROVIDER_ID || parserProviderVersion !== STRAVA_PROVIDER_VERSION
    || stravaProviderId !== STRAVA_PROVIDER_ID || stravaProviderVersion !== STRAVA_PROVIDER_VERSION
    || duolingoProviderId !== DUOLINGO_PROVIDER_ID || duolingoProviderVersion !== DUOLINGO_PROVIDER_VERSION
    || duolingoOwnershipRequestHash !== DUOLINGO_OWNERSHIP_REQUEST_HASH
    || duolingoXpRequestHash !== DUOLINGO_XP_REQUEST_HASH
    || getAddress(stravaWitness) !== PINNED_WITNESS || getAddress(duolingoWitness) !== PINNED_WITNESS
    || getAddress(stravaParser) !== parser.address
) {
  throw new Error("A deployed verifier failed its immutable metadata invariant; do not deploy the escrow");
}

console.log(JSON.stringify({
  dryRun: false,
  ...plan,
  parserSchemaId,
  deployments: {
    parser: { ...parser, blockNumber: parser.blockNumber.toString(), gasEstimate: parser.gasEstimate.toString(), gasLimit: parser.gasLimit.toString() },
    strava: { ...strava, blockNumber: strava.blockNumber.toString(), gasEstimate: strava.gasEstimate.toString(), gasLimit: strava.gasLimit.toString() },
    duolingo: { ...duolingo, blockNumber: duolingo.blockNumber.toString(), gasEstimate: duolingo.gasEstimate.toString(), gasLimit: duolingo.gasLimit.toString() },
  },
  escrowEnvironment: {
    LOCK_IN_STRAVA_PARSER_ADDRESS: parser.address,
    LOCK_IN_STRAVA_VERIFIER_ADDRESS: strava.address,
    LOCK_IN_DUOLINGO_VERIFIER_ADDRESS: duolingo.address,
    LOCK_IN_STRAVA_PARSER_CODE_HASH: parser.runtimeCodeHash,
    LOCK_IN_STRAVA_VERIFIER_CODE_HASH: strava.runtimeCodeHash,
    LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH: duolingo.runtimeCodeHash,
  },
  verified: true,
}, null, 2));
