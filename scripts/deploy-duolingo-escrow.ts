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
import { PINNED_DUOLINGO_EVIDENCE_SIGNER } from "../src/duolingo-escrow-client.js";

/**
 * Deploys LockInDuolingoEscrow (contract B) PAUSED, then transfers ownership to the Safe.
 *
 * Mirrors scripts/deploy-escrow.ts: a dry run by default, --execute plus an exact CONFIRM string to write.
 * The constructor already sets creation/joining/completion paused, so the contract is closed the instant it
 * exists. The funded deployer is never reused as the evidence signer, and the evidence signer must be a
 * fresh unfunded key. On success it prints NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS and DUOLINGO_ESCROW_CODE_HASH
 * for the gate. It never opens a pause; that is a later Safe transaction, gated by scripts/check-duolingo-escrow.ts.
 *
 * Usage: pnpm deploy:duolingo            (dry run)
 *        pnpm deploy:duolingo --execute  (with CONFIRM_DEPLOY_DUOLINGO set to the printed string)
 */

const CHAIN_ID = 143;
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const STRAVA_ESCROW = "0xD37121112F240fE03a18D754B2fdB9dC750034d4".toLowerCase();
const SCHEMA_ID = 1n;
const OWNERSHIP_TRANSFER_GAS_RESERVE = 100_000n;

function localPrivateKey(names: readonly string[]): Hex {
  const raw = names.map((name) => process.env[name]?.trim()).find(Boolean) || "";
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Missing valid ${names.join(" or ")}`);
  return value as Hex;
}
function requiredAddress(name: string): Address {
  const value = process.env[name]?.trim() || "";
  if (!isAddress(value)) throw new Error(`${name} must be a valid address`);
  return getAddress(value);
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
if (Number(process.env.MONAD_CHAIN_ID?.trim() || String(CHAIN_ID)) !== CHAIN_ID) throw new Error("Pinned to Monad chain 143");

const token = requiredAddress("STAKE_TOKEN_ADDRESS");
if (token !== EXPECTED_USDC) throw new Error("STAKE_TOKEN_ADDRESS must be canonical Monad USDC");
const deployer = privateKeyToAccount(localPrivateKey(["DUOLINGO_DEPLOYER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "PRIVATE_KEY"]));
const finalOwner = requiredAddress("LOCK_IN_OWNER_ADDRESS");
// The deployment only needs the signer's PUBLIC address (a constructor argument); the signer private key
// is never required at deploy time, and is deliberately not read here. It is the pinned address, and if
// DUOLINGO_EVIDENCE_SIGNER_ADDRESS is also configured it must match.
const evidenceSigner = getAddress(PINNED_DUOLINGO_EVIDENCE_SIGNER);
const envSigner = process.env.DUOLINGO_EVIDENCE_SIGNER_ADDRESS?.trim();
if (envSigner && (!isAddress(envSigner) || getAddress(envSigner) !== evidenceSigner)) {
  throw new Error("DUOLINGO_EVIDENCE_SIGNER_ADDRESS does not match the pinned evidence signer");
}
if (deployer.address === evidenceSigner) throw new Error("The funded deployer must not be the evidence signer");
if (finalOwner === deployer.address || finalOwner === evidenceSigner) {
  throw new Error("LOCK_IN_OWNER_ADDRESS must differ from the deployer and the evidence signer");
}

const chain = defineChain({ id: CHAIN_ID, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
if (await publicClient.getChainId() !== CHAIN_ID) throw new Error("RPC chain id is not 143");

const artifact = JSON.parse(await readFile("out/LockInDuolingoEscrow.sol/LockInDuolingoEscrow.json", "utf8")) as { abi: Abi; bytecode: { object: Hex } };
if (!artifact.bytecode.object || artifact.bytecode.object === "0x") throw new Error("LockInDuolingoEscrow artifact has no bytecode; run forge build");

const args = [token, evidenceSigner] as const;
const deploymentData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args } as never);
const gasEstimate = await publicClient.estimateGas({ account: deployer, data: deploymentData });
const gasLimit = addMonadGasBuffer(gasEstimate);
const [balance, gasPrice, evidenceSignerBalance, ownerCode] = await Promise.all([
  publicClient.getBalance({ address: deployer.address }),
  publicClient.getGasPrice(),
  publicClient.getBalance({ address: evidenceSigner }),
  publicClient.getCode({ address: finalOwner }),
]);
if (!ownerCode || ownerCode === "0x") throw new Error("LOCK_IN_OWNER_ADDRESS must be an already-deployed multisig contract");
if (evidenceSignerBalance !== 0n) throw new Error("The evidence signer must be a fresh unfunded key");
const reserved = gasLimit * gasPrice + OWNERSHIP_TRANSFER_GAS_RESERVE * gasPrice;
if (balance < reserved) throw new Error("Deployer lacks MON for deployment plus the reserved ownership-transfer gas");

const execute = process.argv.slice(2).includes("--execute");
const unknown = process.argv.slice(2).filter((v) => v !== "--execute");
if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
const confirmation = `DEPLOY_LOCK_IN_DUOLINGO_${CHAIN_ID}_${deployer.address}_${finalOwner}_${token}_${evidenceSigner}`;
if (execute && process.env.CONFIRM_DEPLOY_DUOLINGO?.trim() !== confirmation) {
  throw new Error(`Execution refused. Set CONFIRM_DEPLOY_DUOLINGO exactly to ${confirmation}`);
}

const plan = {
  chainId: CHAIN_ID,
  contract: "LockInDuolingoEscrow",
  deploymentDataHash: keccak256(deploymentData),
  deployer: deployer.address,
  finalOwner,
  stakeToken: token,
  evidenceSigner,
  scheme: "DUOLINGO_ZKTLS_DELTA_V1",
  initialPauses: { creation: true, joining: true, completion: true },
  minStakeAtomicUnits: "100000",
  maxStakeAtomicUnits: "1000000",
  steps: [
    { order: 1, action: "deploy paused escrow B", gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString() },
    { order: 2, action: "transfer ownership to the Safe", recipient: finalOwner, reservedGasLimit: OWNERSHIP_TRANSFER_GAS_RESERVE.toString() },
    { order: 3, action: "run pnpm gate:duolingo, then open pauses via Safe only after it is green", writesOnchain: false },
  ],
};

if (!execute) {
  console.log(JSON.stringify({ dryRun: true, ...plan, confirmationRequired: confirmation, nextStep: "Review, set CONFIRM_DEPLOY_DUOLINGO, rerun with --execute." }, null, 2));
  process.exit(0);
}

const deploymentHash = await walletClient.deployContract({ account: deployer, abi: artifact.abi, bytecode: artifact.bytecode.object, args, gas: gasLimit } as never);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment failed");
const escrow = getAddress(receipt.contractAddress);
if (escrow.toLowerCase() === STRAVA_ESCROW) throw new Error("Refusing: deployed address collides with the Strava escrow");
const code = await publicClient.getCode({ address: escrow, blockNumber: receipt.blockNumber });
if (!code || code === "0x") throw new Error(`No runtime code at ${escrow}`);
const escrowRuntimeCodeHash = keccak256(code);

const abi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "CONTRACT_SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_PARTICIPANTS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "SUBMISSION_GRACE_PERIOD", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "completionPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
const at = { blockNumber: receipt.blockNumber } as const;
const [owner, dToken, dSigner, schemaId, minStake, maxStake, maxP, grace, cPaused, jPaused, compPaused] = await Promise.all([
  publicClient.readContract({ address: escrow, abi, functionName: "owner", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "stakeToken", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "evidenceSigner", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "CONTRACT_SCHEMA_ID", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "MIN_STAKE", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "MAX_STAKE", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "MAX_PARTICIPANTS", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "SUBMISSION_GRACE_PERIOD", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "creationPaused", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "joiningPaused", ...at }),
  publicClient.readContract({ address: escrow, abi, functionName: "completionPaused", ...at }),
]);
const okPaused = schemaId === SCHEMA_ID && getAddress(owner) === deployer.address && getAddress(dToken) === token
  && getAddress(dSigner) === evidenceSigner && minStake === 100_000n && maxStake === 1_000_000n
  && maxP === 100 && grace === 3_600n && cPaused && jPaused && compPaused;
if (!okPaused) throw new Error(`Paused post-deployment invariant failed for ${escrow}`);

const transferGas = addMonadGasBuffer(await publicClient.estimateContractGas({ account: deployer, address: escrow, abi, functionName: "transferOwnership", args: [finalOwner] }));
if (transferGas > OWNERSHIP_TRANSFER_GAS_RESERVE) throw new Error(`Ownership-transfer gas exceeds reserve; contract remains paused at ${escrow}`);
const transferHash = await walletClient.writeContract({ account: deployer, address: escrow, abi, functionName: "transferOwnership", args: [finalOwner], gas: transferGas });
const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
if (transferReceipt.status !== "success") throw new Error(`Ownership transfer failed; contract remains paused at ${escrow}`);

const [finalOwnerRead, fc, fj, fk] = await Promise.all([
  publicClient.readContract({ address: escrow, abi, functionName: "owner", blockNumber: transferReceipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi, functionName: "creationPaused", blockNumber: transferReceipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi, functionName: "joiningPaused", blockNumber: transferReceipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi, functionName: "completionPaused", blockNumber: transferReceipt.blockNumber }),
]);
if (getAddress(finalOwnerRead) !== finalOwner || !fc || !fj || !fk) throw new Error(`Final owner or pause invariant failed for ${escrow}`);

console.log(JSON.stringify({
  dryRun: false,
  ...plan,
  escrow,
  escrowRuntimeCodeHash,
  escrowEnvironment: { NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS: escrow, DUOLINGO_ESCROW_CODE_HASH: escrowRuntimeCodeHash },
  owner: getAddress(finalOwnerRead),
  deploymentBlock: receipt.blockNumber.toString(),
  deploymentTx: deploymentHash,
  ownershipTransferTx: transferHash,
  pausedDeploymentVerified: true,
  finalOwnershipVerified: true,
}, null, 2));
