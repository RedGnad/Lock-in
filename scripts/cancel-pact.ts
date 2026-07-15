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
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lockInAbi } from "../src/lock-in-abi.js";
import { addMonadGasBuffer } from "../src/monad-gas.js";
import { releasePactAbi, type ReleasePactTuple } from "./release-contract.js";

type IncidentFunction = "cancelPactByOwner" | "finalizePact";

const CHAIN_ID = 143;

function requiredAddress(name: string): Address {
  const raw = process.env[name]?.trim() || "";
  if (!isAddress(raw)) throw new Error(`${name} is missing or invalid`);
  return getAddress(raw);
}

function localOwnerPrivateKey(): Hex {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim() || "";
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("EOA development execution requires a valid local DEPLOYER_PRIVATE_KEY or PRIVATE_KEY");
  }
  return value as Hex;
}

const rawArguments = process.argv.slice(2);
const allowedOptions = new Set(["--execute", "--verify", "--snapshot"]);
const unknownOptions = rawArguments.filter((value) => !allowedOptions.has(value));
if (unknownOptions.length > 0) throw new Error(`Unknown argument: ${unknownOptions[0]}`);
const execute = rawArguments.includes("--execute");
const verify = rawArguments.includes("--verify");
const snapshotOnly = rawArguments.includes("--snapshot");
if (Number(execute) + Number(verify) + Number(snapshotOnly) > 1) {
  throw new Error("Choose only one of --execute, --verify, or --snapshot");
}

const rawPactId = process.env.PACT_ID?.trim() || "";
if (!/^[1-9][0-9]*$/.test(rawPactId)) throw new Error("Set PACT_ID to the affected positive pact ID");
const pactId = BigInt(rawPactId);
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
const ownerAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

async function readIncidentSnapshot(blockNumber?: bigint) {
  const atBlock = blockNumber === undefined ? {} : { blockNumber };
  const [rawOwner, pact, creation, joining, baseline, completion] = await Promise.all([
    publicClient.readContract({ address: escrow, abi: ownerAbi, functionName: "owner", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: releasePactAbi, functionName: "pacts", args: [pactId], ...atBlock }) as Promise<ReleasePactTuple>,
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "baselinePaused", ...atBlock }),
    publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "completionPaused", ...atBlock }),
  ]);
  if (pact[0] === zeroAddress) throw new Error(`Pact ${pactId} does not exist`);
  const owner = getAddress(rawOwner);
  return {
    owner,
    pact,
    snapshot: {
      chainId: CHAIN_ID,
      escrow,
      pactId: pactId.toString(),
      owner,
      creator: pact[0],
      startsAt: pact[1].toString(),
      stakeAtomicUnits: pact[2].toString(),
      dailyTarget: pact[3],
      participants: pact[4],
      claimsRemaining: pact[6],
      maxParticipants: pact[10],
      missionType: pact[11],
      completionPauseGenerationAtCreation: pact[12].toString(),
      remainingPoolAtomicUnits: pact[14].toString(),
      cancelled: pact[16],
      finalized: pact[15],
      pauses: { creation, joining, baseline, completion },
    },
  };
}

const observedBlock = await publicClient.getBlock({ blockTag: "latest" });
const [chainId, schemaId, incident] = await Promise.all([
  publicClient.getChainId(),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "CONTRACT_SCHEMA_ID", blockNumber: observedBlock.number }),
  readIncidentSnapshot(observedBlock.number),
]);
if (chainId !== CHAIN_ID || schemaId !== 1n) {
  throw new Error("Refusing to operate a LockInEscrow with an unexpected contract schema on Monad");
}
if (incident.owner !== expectedOwner) throw new Error("Onchain owner does not match LOCK_IN_OWNER_ADDRESS");
const ownerCode = await publicClient.getCode({ address: incident.owner, blockNumber: observedBlock.number });
const ownerIsContract = Boolean(ownerCode && ownerCode !== "0x");
const snapshot = {
  observedAtBlock: observedBlock.number.toString(),
  ownerType: ownerIsContract ? "contract/multisig" : "EOA development owner",
  ...incident.snapshot,
};

if (snapshotOnly) {
  console.log(JSON.stringify({ mode: "snapshot", ok: true, snapshot }, null, 2));
  process.exit(0);
}

if (verify) {
  const refundStateVerified = incident.pact[16] && incident.pact[15];
  if (!refundStateVerified) {
    throw new Error(`Incident verification failed: ${JSON.stringify({ cancelled: incident.pact[16], finalized: incident.pact[15] })}`);
  }
  console.log(JSON.stringify({
    mode: "verify",
    ok: true,
    snapshot,
    refundStateVerified: true,
    participantRefundClaimsEnabled: true,
  }, null, 2));
  process.exit(0);
}

if (incident.pact[15] && !incident.pact[16]) {
  throw new Error("Pact is already finalized without cancellation; owner refund conversion is no longer available");
}
const allRiskPathsPaused = Object.values(snapshot.pauses).every(Boolean);
const functionNames: IncidentFunction[] = incident.pact[15]
  ? []
  : incident.pact[16]
    ? ["finalizePact"]
    : ["cancelPactByOwner", "finalizePact"];
const calls = functionNames.map((functionName, index) => {
  const data = encodeFunctionData({ abi: lockInAbi, functionName, args: [pactId] });
  return {
    order: index + 1,
    functionName,
    transaction: { to: escrow, value: "0" as const, data },
    calldataHash: keccak256(data),
  };
});
const requiredConfirmation = `CANCEL_PACT_${CHAIN_ID}_${escrow}_${pactId}`;

if (!execute) {
  console.log(JSON.stringify({
    dryRun: true,
    snapshot,
    alreadyComplete: incident.pact[16] && incident.pact[15],
    executionReady: allRiskPathsPaused && calls.length > 0,
    ordering: "Submit in listed order. A multisig may batch these calls atomically; otherwise wait for each receipt before the next call.",
    calls,
    confirmationRequiredForEoaDevelopmentExecution: requiredConfirmation,
    multisigReview: {
      expectedSignerConfirmations: "Apply the configured multisig threshold to this exact ordered calldata bundle.",
      gas: "Estimate the multisig wrapper/batch in the multisig interface.",
      verifyCommand: "pnpm incident:cancel-pact:verify",
    },
    nextStep: calls.length === 0
      ? "No transaction is required. Run the verify command to record the refund state."
      : !allRiskPathsPaused
        ? "Pause all four risk paths first, verify those pauses, then regenerate this incident bundle."
        : ownerIsContract
          ? "Review destination, zero value, calldata and order; submit through the configured multisig, wait for receipts, then run the verify command."
          : "Development owner is an EOA. Review the plan before optional local --execute.",
  }, null, 2));
  process.exit(0);
}

if (!allRiskPathsPaused) throw new Error("Execution refused until all four risk paths are paused");
if (calls.length === 0) throw new Error("Incident refund state is already finalized; no transaction is required");
if (ownerIsContract) {
  throw new Error("Local --execute is disabled for a contract/multisig owner; submit the dry-run calldata bundle through the multisig, then use --verify");
}
if (process.env.CONFIRM_CANCEL_PACT?.trim() !== requiredConfirmation) {
  throw new Error(`Execution refused. Set CONFIRM_CANCEL_PACT exactly to ${requiredConfirmation}`);
}
const account = privateKeyToAccount(localOwnerPrivateKey());
if (account.address !== incident.owner) throw new Error("Local development key does not match the onchain EOA owner");
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

async function send(functionName: IncidentFunction) {
  const request = { address: escrow, abi: lockInAbi, functionName, args: [pactId], account } as const;
  await publicClient.simulateContract(request);
  const gas = addMonadGasBuffer(await publicClient.estimateContractGas(request));
  const [balance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getGasPrice(),
  ]);
  if (balance < gas * gasPrice) throw new Error(`EOA owner lacks MON for ${functionName}`);
  const hash = await walletClient.writeContract({ ...request, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

const cancelTx = incident.pact[16] ? null : await send("cancelPactByOwner");
const finalizeTx = await send("finalizePact");
const finalIncident = await readIncidentSnapshot();
if (!finalIncident.pact[16] || !finalIncident.pact[15]) {
  throw new Error("Post-transaction incident state is not cancelled and finalized");
}
console.log(JSON.stringify({
  dryRun: false,
  executionMode: "EOA development compatibility",
  snapshot,
  result: {
    cancelled: true,
    finalized: true,
    participantRefundClaimsEnabled: true,
    cancelTx,
    finalizeTx,
  },
}, null, 2));
