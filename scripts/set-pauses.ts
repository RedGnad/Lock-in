import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lockInAbi } from "../src/lock-in-abi.js";
import { addMonadGasBuffer } from "../src/monad-gas.js";

type PauseName = "creation" | "joining" | "baseline" | "completion";
type SetterName = "setCreationPaused" | "setJoiningPaused" | "setBaselinePaused" | "setCompletionPaused";
type PauseState = Record<PauseName, boolean>;
type PauseOperation = { name: PauseName; functionName: SetterName; current: boolean; desired: boolean };

const CHAIN_ID = 143;
const EXPECTED_RECLAIM_WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");
const EXPECTED_STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const EXPECTED_STRAVA_PROVIDER_VERSION = "1.0.3";
const EXPECTED_STRAVA_SCHEMA_ID = keccak256(
  stringToHex("lock-in:strava:f3ec8292-d8f3-487c-a79d-f53f482f88e2:1.0.3:synthetic"),
);
const EXPECTED_DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
const EXPECTED_DUOLINGO_PROVIDER_VERSION = "1.0.8";
const EXPECTED_DUOLINGO_OWNERSHIP_REQUEST_HASH = "0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e";
const EXPECTED_DUOLINGO_XP_REQUEST_HASH = "0x92d80894f1f9e2f3574b840e846e41a49ae7491b587da9bd96cbcccbe001c8ed";

function requiredAddress(name: string): Address {
  const raw = process.env[name]?.trim() || "";
  if (!isAddress(raw)) throw new Error(`${name} is missing or invalid`);
  return getAddress(raw);
}

function requiredHash(name: string): Hex {
  const raw = process.env[name]?.trim() || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${name} is missing or invalid`);
  return raw.toLowerCase() as Hex;
}

function localOwnerPrivateKey(): Hex {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim() || "";
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("EOA development execution requires a valid local DEPLOYER_PRIVATE_KEY or PRIVATE_KEY");
  }
  return value as Hex;
}

function booleanArgument(value: string | undefined): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error("Pass exactly: <creation> <joining> <baseline> <completion> as true/false");
  }
  return value === "true";
}

const rawArguments = process.argv.slice(2);
const allowedOptions = new Set(["--execute", "--verify", "--snapshot"]);
const unknownOptions = rawArguments.filter((value) => value.startsWith("--") && !allowedOptions.has(value));
if (unknownOptions.length > 0) throw new Error(`Unknown option: ${unknownOptions[0]}`);
const execute = rawArguments.includes("--execute");
const verify = rawArguments.includes("--verify");
const snapshotOnly = rawArguments.includes("--snapshot");
if (Number(execute) + Number(verify) + Number(snapshotOnly) > 1) {
  throw new Error("Choose only one of --execute, --verify, or --snapshot");
}
const values = rawArguments.filter((value) => !value.startsWith("--"));
if (snapshotOnly ? values.length !== 0 : values.length !== 4) {
  throw new Error(snapshotOnly ? "--snapshot takes no pause booleans" : "Pass exactly four pause booleans");
}
const desired = snapshotOnly
  ? null
  : Object.fromEntries(
    (["creation", "joining", "baseline", "completion"] as const).map((name, index) => [name, booleanArgument(values[index])]),
  ) as PauseState;

const escrow = requiredAddress("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS");
const expectedOwner = requiredAddress("LOCK_IN_OWNER_ADDRESS");
const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const ownerAbi = [{
  type: "function",
  name: "owner",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "address" }],
}] as const;
const escrowVerifierAbi = [
  { type: "function", name: "stravaVerifier", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "duolingoVerifier", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const verifierAbi = [
  { type: "function", name: "WITNESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "PARSER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_OWNERSHIP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_XP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const parserAbi = [
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function assertReleaseGate(blockNumber: bigint) {
  const expectedEscrowCodeHash = requiredHash("LOCK_IN_ESCROW_CODE_HASH");
  const expectedStravaVerifier = requiredAddress("LOCK_IN_STRAVA_VERIFIER_ADDRESS");
  const expectedDuolingoVerifier = requiredAddress("LOCK_IN_DUOLINGO_VERIFIER_ADDRESS");
  const expectedParser = requiredAddress("LOCK_IN_STRAVA_PARSER_ADDRESS");
  const expectedStravaCodeHash = requiredHash("LOCK_IN_STRAVA_VERIFIER_CODE_HASH");
  const expectedDuolingoCodeHash = requiredHash("LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH");
  const expectedParserCodeHash = requiredHash("LOCK_IN_STRAVA_PARSER_CODE_HASH");
  const [escrowCode, rawStravaVerifier, rawDuolingoVerifier] = await Promise.all([
    publicClient.getCode({ address: escrow, blockNumber }),
    publicClient.readContract({ address: escrow, abi: escrowVerifierAbi, functionName: "stravaVerifier", blockNumber }),
    publicClient.readContract({ address: escrow, abi: escrowVerifierAbi, functionName: "duolingoVerifier", blockNumber }),
  ]);
  if (!escrowCode || escrowCode === "0x" || keccak256(escrowCode) !== expectedEscrowCodeHash) {
    throw new Error("Opening refused: escrow runtime bytecode does not match LOCK_IN_ESCROW_CODE_HASH");
  }
  const stravaVerifier = getAddress(rawStravaVerifier);
  const duolingoVerifier = getAddress(rawDuolingoVerifier);
  if (stravaVerifier !== expectedStravaVerifier || duolingoVerifier !== expectedDuolingoVerifier) {
    throw new Error("Opening refused: escrow verifier bindings do not match the configured release addresses");
  }
  if (stravaVerifier === duolingoVerifier) {
    throw new Error("Opening refused: Strava and Duolingo verifiers must be distinct");
  }

  const [
    stravaCode,
    duolingoCode,
    stravaLive,
    duolingoLive,
    stravaWitness,
    duolingoWitness,
    stravaProviderId,
    stravaProviderVersion,
    duolingoProviderId,
    duolingoProviderVersion,
    duolingoOwnershipRequestHash,
    duolingoXpRequestHash,
    rawParser,
  ] = await Promise.all([
    publicClient.getCode({ address: stravaVerifier, blockNumber }),
    publicClient.getCode({ address: duolingoVerifier, blockNumber }),
    publicClient.readContract({ address: stravaVerifier, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", blockNumber }),
    publicClient.readContract({ address: duolingoVerifier, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", blockNumber }),
    publicClient.readContract({ address: stravaVerifier, abi: verifierAbi, functionName: "WITNESS", blockNumber }),
    publicClient.readContract({ address: duolingoVerifier, abi: verifierAbi, functionName: "WITNESS", blockNumber }),
    publicClient.readContract({ address: stravaVerifier, abi: verifierAbi, functionName: "STRAVA_PROVIDER_ID", blockNumber }),
    publicClient.readContract({ address: stravaVerifier, abi: verifierAbi, functionName: "STRAVA_PROVIDER_VERSION", blockNumber }),
    publicClient.readContract({ address: duolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_ID", blockNumber }),
    publicClient.readContract({ address: duolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_VERSION", blockNumber }),
    publicClient.readContract({ address: duolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_OWNERSHIP_REQUEST_HASH", blockNumber }),
    publicClient.readContract({ address: duolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_XP_REQUEST_HASH", blockNumber }),
    publicClient.readContract({ address: stravaVerifier, abi: verifierAbi, functionName: "PARSER", blockNumber }),
  ]);
  const parser = getAddress(rawParser);
  if (parser !== expectedParser) {
    throw new Error("Opening refused: Strava parser binding does not match LOCK_IN_STRAVA_PARSER_ADDRESS");
  }
  const [parserCode, parserLive, parserSchemaId, parserProviderId, parserProviderVersion] = await Promise.all([
    publicClient.getCode({ address: parser, blockNumber }),
    publicClient.readContract({ address: parser, abi: parserAbi, functionName: "LIVE_SCHEMA_CONFIRMED", blockNumber }),
    publicClient.readContract({ address: parser, abi: parserAbi, functionName: "SCHEMA_ID", blockNumber }),
    publicClient.readContract({ address: parser, abi: parserAbi, functionName: "STRAVA_PROVIDER_ID", blockNumber }),
    publicClient.readContract({ address: parser, abi: parserAbi, functionName: "STRAVA_PROVIDER_VERSION", blockNumber }),
  ]);

  const checks = {
    escrowCodeHash: keccak256(escrowCode) === expectedEscrowCodeHash,
    stravaCode: Boolean(stravaCode && stravaCode !== "0x"),
    duolingoCode: Boolean(duolingoCode && duolingoCode !== "0x"),
    parserCode: Boolean(parserCode && parserCode !== "0x"),
    stravaCodeHash: Boolean(stravaCode && stravaCode !== "0x") && keccak256(stravaCode as Hex) === expectedStravaCodeHash,
    duolingoCodeHash: Boolean(duolingoCode && duolingoCode !== "0x") && keccak256(duolingoCode as Hex) === expectedDuolingoCodeHash,
    parserCodeHash: Boolean(parserCode && parserCode !== "0x") && keccak256(parserCode as Hex) === expectedParserCodeHash,
    stravaLive,
    duolingoLive,
    parserLive,
    stravaWitness: getAddress(stravaWitness) === EXPECTED_RECLAIM_WITNESS,
    duolingoWitness: getAddress(duolingoWitness) === EXPECTED_RECLAIM_WITNESS,
    stravaProvider:
      stravaProviderId === EXPECTED_STRAVA_PROVIDER_ID && stravaProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION,
    parserProvider:
      parserProviderId === EXPECTED_STRAVA_PROVIDER_ID && parserProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION,
    parserSchema: parserSchemaId === EXPECTED_STRAVA_SCHEMA_ID,
    duolingoProvider:
      duolingoProviderId === EXPECTED_DUOLINGO_PROVIDER_ID
      && duolingoProviderVersion === EXPECTED_DUOLINGO_PROVIDER_VERSION
      && duolingoOwnershipRequestHash === EXPECTED_DUOLINGO_OWNERSHIP_REQUEST_HASH
      && duolingoXpRequestHash === EXPECTED_DUOLINGO_XP_REQUEST_HASH,
  };
  if (!Object.values(checks).every(Boolean)) {
    throw new Error(`Opening refused: direct-proof release gate failed ${JSON.stringify(checks)}`);
  }
  return {
    observedAtBlock: blockNumber.toString(),
    escrowRuntimeCodeHash: keccak256(escrowCode),
    witness: EXPECTED_RECLAIM_WITNESS,
    strava: {
      address: stravaVerifier,
      runtimeCodeHash: keccak256(stravaCode as Hex),
      parser,
      parserRuntimeCodeHash: keccak256(parserCode as Hex),
      schemaId: parserSchemaId,
    },
    duolingo: {
      address: duolingoVerifier,
      runtimeCodeHash: keccak256(duolingoCode as Hex),
      ownershipRequestHash: duolingoOwnershipRequestHash,
      xpRequestHash: duolingoXpRequestHash,
    },
    checks,
  };
}

async function readPauses(blockNumber?: bigint): Promise<PauseState> {
  const atBlock = blockNumber === undefined ? {} : { blockNumber };
  const [creation, joining, baseline, completion] = await Promise.all([
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "baselinePaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "completionPaused", ...atBlock }),
  ]);
  return { creation, joining, baseline, completion };
}

const observedBlock = await publicClient.getBlock({ blockTag: "latest" });
const [chainId, schemaId, rawOwner, current] = await Promise.all([
  publicClient.getChainId(),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "CONTRACT_SCHEMA_ID", blockNumber: observedBlock.number }),
  publicClient.readContract({ address: escrow, abi: ownerAbi, functionName: "owner", blockNumber: observedBlock.number }),
  readPauses(observedBlock.number),
]);
if (chainId !== CHAIN_ID || schemaId !== 1n) {
  throw new Error("Refusing to operate a LockInEscrow with an unexpected contract schema on Monad");
}
const owner = getAddress(rawOwner);
if (owner !== expectedOwner) throw new Error("Onchain owner does not match LOCK_IN_OWNER_ADDRESS");
const ownerCode = await publicClient.getCode({ address: owner, blockNumber: observedBlock.number });
const ownerIsContract = Boolean(ownerCode && ownerCode !== "0x");
const baseSnapshot = {
  chainId,
  observedAtBlock: observedBlock.number.toString(),
  escrow,
  owner,
  ownerType: ownerIsContract ? "contract/multisig" : "EOA development owner",
  current,
};

if (snapshotOnly) {
  console.log(JSON.stringify({ mode: "snapshot", ok: true, ...baseSnapshot }, null, 2));
  process.exit(0);
}

if (!desired) throw new Error("Missing desired pause state");
const openingRequested = (Object.keys(desired) as PauseName[])
  .some((name) => current[name] && !desired[name]);
const releaseGate = openingRequested || (verify && Object.values(desired).some((paused) => !paused))
  ? await assertReleaseGate(observedBlock.number)
  : null;
const confirmation = `SET_PAUSES_${CHAIN_ID}_${escrow}_${desired.creation}_${desired.joining}_${desired.baseline}_${desired.completion}`;
if (verify) {
  const matches = (Object.keys(desired) as PauseName[]).every((name) => current[name] === desired[name]);
  if (!matches) throw new Error(`Pause verification failed: ${JSON.stringify({ desired, current })}`);
  console.log(JSON.stringify({ mode: "verify", ok: true, ...baseSnapshot, desired, releaseGate }, null, 2));
  process.exit(0);
}

const setters: Record<PauseName, SetterName> = {
  creation: "setCreationPaused",
  joining: "setJoiningPaused",
  baseline: "setBaselinePaused",
  completion: "setCompletionPaused",
};
// Stop new exposure before proof paths. Open proof paths before accepting new exposure.
const closeOrder: PauseName[] = ["creation", "joining", "baseline", "completion"];
const openOrder: PauseName[] = ["baseline", "completion", "joining", "creation"];
const operations: PauseOperation[] = [
  ...closeOrder.filter((name) => current[name] !== desired[name] && desired[name]),
  ...openOrder.filter((name) => current[name] !== desired[name] && !desired[name]),
].map((name) => ({ name, functionName: setters[name], current: current[name], desired: desired[name] }));

const plannedOperations: Array<PauseOperation & {
  order: number;
  transaction: { to: Address; value: "0"; data: Hex };
  calldataHash: Hex;
  directCallGasLimit: string | null;
}> = [];
for (const [index, operation] of operations.entries()) {
  const data = encodeFunctionData({
    abi: lockInAbi,
    functionName: operation.functionName,
    args: [operation.desired],
  });
  const request = {
    address: escrow,
    abi: lockInAbi,
    functionName: operation.functionName,
    args: [operation.desired],
    account: owner,
  } as const;
  await publicClient.simulateContract(request);
  let directCallGasLimit: string | null = null;
  try {
    directCallGasLimit = addMonadGasBuffer(await publicClient.estimateContractGas(request)).toString();
  } catch {
    // A Safe/multisig pays gas through its executor; estimate that wrapper in the multisig interface.
  }
  plannedOperations.push({
    ...operation,
    order: index + 1,
    transaction: { to: escrow, value: "0", data },
    calldataHash: keccak256(data),
    directCallGasLimit,
  });
}

if (!execute) {
  console.log(JSON.stringify({
    dryRun: true,
    ...baseSnapshot,
    desired,
    releaseGate,
    alreadyDesired: operations.length === 0,
    ordering: "Submit in listed order. Every closure precedes every opening; calls are separate unless the multisig batches them atomically.",
    operations: plannedOperations,
    confirmationRequiredForEoaDevelopmentExecution: confirmation,
    multisigReview: {
      expectedSignerConfirmations: "Apply the configured multisig threshold to this exact ordered calldata bundle.",
      gas: "Estimate the multisig wrapper/batch in the multisig interface; directCallGasLimit excludes wrapper overhead.",
      verifyCommand: `pnpm pauses:verify -- ${desired.creation} ${desired.joining} ${desired.baseline} ${desired.completion}`,
    },
    nextStep: operations.length === 0
      ? "No transaction is required. Run the verify command to record the state."
      : ownerIsContract
        ? "Review destination, value, calldata and order; submit through the configured multisig, wait for receipts, then run the verify command."
        : "Development owner is an EOA. Review the plan before optional local --execute.",
  }, null, 2));
  process.exit(0);
}

if (ownerIsContract) {
  throw new Error("Local --execute is disabled for a contract/multisig owner; submit the dry-run calldata bundle through the multisig, then use --verify");
}
if (process.env.CONFIRM_SET_PAUSES?.trim() !== confirmation) {
  throw new Error(`Execution refused. Set CONFIRM_SET_PAUSES exactly to ${confirmation}`);
}
const account = privateKeyToAccount(localOwnerPrivateKey());
if (account.address !== owner) throw new Error("Local development key does not match the onchain EOA owner");
if (plannedOperations.some((operation) => operation.directCallGasLimit === null)) {
  throw new Error("A direct-call gas estimate is unavailable; no transaction was sent");
}
const [ownerBalance, gasPrice] = await Promise.all([
  publicClient.getBalance({ address: owner }),
  publicClient.getGasPrice(),
]);
const estimatedMaxFee = plannedOperations.reduce(
  (total, operation) => total + BigInt(operation.directCallGasLimit || "0") * gasPrice,
  0n,
);
if (ownerBalance < estimatedMaxFee) throw new Error("EOA owner lacks MON for the complete pause transition; no transaction was sent");

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const hashes: Partial<Record<SetterName, Hex>> = {};
for (const operation of plannedOperations) {
  const hash = await walletClient.writeContract({
    address: escrow,
    abi: lockInAbi,
    functionName: operation.functionName,
    args: [operation.desired],
    account,
    gas: BigInt(operation.directCallGasLimit || "0"),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${operation.functionName} reverted`);
  hashes[operation.functionName] = hash;
}

const final = await readPauses();
if ((Object.keys(desired) as PauseName[]).some((name) => final[name] !== desired[name])) {
  throw new Error("Post-transaction pause state does not match the requested state");
}
console.log(JSON.stringify({
  dryRun: false,
  executionMode: "EOA development compatibility",
  chainId,
  escrow,
  owner,
  previous: current,
  desired,
  releaseGate,
  final,
  skippedUnchanged: (Object.keys(current) as PauseName[]).filter((name) => current[name] === desired[name]),
  hashes,
}, null, 2));
