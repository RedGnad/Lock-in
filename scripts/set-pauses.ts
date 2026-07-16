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

type PauseName = "creation" | "joining" | "completion";
type SetterName = "setCreationPaused" | "setJoiningPaused" | "setCompletionPaused";
type PauseState = Record<PauseName, boolean>;
type PauseOperation = { name: PauseName; functionName: SetterName; current: boolean; desired: boolean };

const CHAIN_ID = 143;

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
    throw new Error("Pass exactly: <creation> <joining> <completion> as true/false");
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
if (snapshotOnly ? values.length !== 0 : values.length !== 3) {
  throw new Error(snapshotOnly ? "--snapshot takes no pause booleans" : "Pass exactly three pause booleans: <creation> <joining> <completion>");
}
const desired = snapshotOnly
  ? null
  : Object.fromEntries(
    (["creation", "joining", "completion"] as const).map((name, index) => [name, booleanArgument(values[index])]),
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

/**
 * What must be true on chain before this script will produce calldata that OPENS anything.
 *
 * The zkTLS gate this replaces checked verifier bytecode, pinned witnesses and provider schemas. None of
 * that exists now: a completion rests on the evidence signer's signature alone. So the gate checks the
 * things that still decide whether real money is safe, and it checks them against the chain rather than
 * against configuration: that this is the escrow we audited, on the right chain, holding the right token,
 * owned by the Safe, and signing with the keys we hold.
 */
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const releaseGateAbi = [
  { type: "function", name: "CONTRACT_SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "accessSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "STRAVA_OAUTH_SCHEME", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "missionPolicyHash", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "bytes32" }] },
] as const;

async function assertReleaseGate(blockNumber: bigint) {
  const expectedEscrowCodeHash = requiredHash("LOCK_IN_ESCROW_CODE_HASH");
  const expectedEvidenceSigner = requiredAddress("LOCK_IN_EVIDENCE_SIGNER_ADDRESS");
  const expectedAccessSigner = requiredAddress("LOCK_IN_ACCESS_SIGNER_ADDRESS");
  const expectedOwner = requiredAddress("LOCK_IN_OWNER_ADDRESS");

  const [escrowCode, schemaId, stakeToken, minStake, maxStake, evidenceSigner, accessSigner, owner, scheme, policyHash] =
    await Promise.all([
      publicClient.getCode({ address: escrow, blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "CONTRACT_SCHEMA_ID", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "stakeToken", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "MIN_STAKE", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "MAX_STAKE", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "evidenceSigner", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "accessSigner", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "owner", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "STRAVA_OAUTH_SCHEME", blockNumber }),
      publicClient.readContract({ address: escrow, abi: releaseGateAbi, functionName: "missionPolicyHash", args: [1], blockNumber }),
    ]);

  if (!escrowCode || escrowCode === "0x") throw new Error("Opening refused: no code at the escrow address");
  const ownerCode = await publicClient.getCode({ address: getAddress(owner), blockNumber });

  const checks = {
    escrowCodeHash: keccak256(escrowCode) === expectedEscrowCodeHash,
    contractSchema: schemaId === 1n,
    officialUsdc: getAddress(stakeToken) === EXPECTED_USDC,
    oneUsdcCap: minStake === 100_000n && maxStake === 1_000_000n,
    // The scheme the evidence signer must have applied. Its absence means this is not the OAuth escrow.
    stravaOAuthScheme: scheme === keccak256(stringToHex("STRAVA_OAUTH_V1")),
    missionPolicyBound: policyHash !== `0x${"00".repeat(32)}`,
    // If the escrow does not know our signing key, every check-in reverts after we open.
    evidenceSigner: getAddress(evidenceSigner) === expectedEvidenceSigner,
    accessSigner: getAddress(accessSigner) === expectedAccessSigner,
    signersSeparated: getAddress(evidenceSigner) !== getAddress(accessSigner),
    ownerIsConfiguredSafe: getAddress(owner) === expectedOwner,
    // Never an EOA: opening hands real money to whoever holds this key.
    ownerIsContract: Boolean(ownerCode && ownerCode !== "0x"),
    ownerSeparated: getAddress(owner) !== getAddress(evidenceSigner) && getAddress(owner) !== getAddress(accessSigner),
  };
  if (!Object.values(checks).every(Boolean)) {
    throw new Error(`Opening refused: release gate failed ${JSON.stringify(checks)}`);
  }
  return {
    observedAtBlock: blockNumber.toString(),
    escrowRuntimeCodeHash: keccak256(escrowCode),
    verification: { scheme: "STRAVA_OAUTH_V1", trustedParty: getAddress(evidenceSigner) },
    stakeToken: getAddress(stakeToken),
    owner: getAddress(owner),
    evidenceSigner: getAddress(evidenceSigner),
    accessSigner: getAddress(accessSigner),
    missionPolicyHash: policyHash,
    checks,
  };
}

async function readPauses(blockNumber?: bigint): Promise<PauseState> {
  const atBlock = blockNumber === undefined ? {} : { blockNumber };
  const [creation, joining, completion] = await Promise.all([
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "completionPaused", ...atBlock }),
  ]);
  return { creation, joining, completion };
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
const confirmation = `SET_PAUSES_${CHAIN_ID}_${escrow}_${desired.creation}_${desired.joining}_${desired.completion}`;
if (verify) {
  const matches = (Object.keys(desired) as PauseName[]).every((name) => current[name] === desired[name]);
  if (!matches) throw new Error(`Pause verification failed: ${JSON.stringify({ desired, current })}`);
  console.log(JSON.stringify({ mode: "verify", ok: true, ...baseSnapshot, desired, releaseGate }, null, 2));
  process.exit(0);
}

const setters: Record<PauseName, SetterName> = {
  creation: "setCreationPaused",
  joining: "setJoiningPaused",
  completion: "setCompletionPaused",
};
// Stop new exposure before proof paths. Open proof paths before accepting new exposure.
const closeOrder: PauseName[] = ["creation", "joining", "completion"];
const openOrder: PauseName[] = ["completion", "joining", "creation"];
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
      verifyCommand: `pnpm exec tsx scripts/set-pauses.ts --verify ${desired.creation} ${desired.joining} ${desired.completion}`,
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
