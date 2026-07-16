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
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addMonadGasBuffer } from "../src/monad-gas.js";

const CHAIN_ID = 143;
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const EXPECTED_CONTRACT_SCHEMA_ID = 1n;
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

function requiredHash(name: string): Hash {
  const value = process.env[name]?.trim() || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a bytes32 hash`);
  return value.toLowerCase() as Hash;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const configuredChainId = Number(process.env.MONAD_CHAIN_ID?.trim() || String(CHAIN_ID));
if (configuredChainId !== CHAIN_ID) throw new Error("Lock In deployments are pinned to Monad mainnet chain ID 143");

const token = requiredAddress("STAKE_TOKEN_ADDRESS");
if (token !== EXPECTED_USDC) throw new Error("STAKE_TOKEN_ADDRESS must be canonical Monad USDC");
const deployer = privateKeyToAccount(localPrivateKey(["DEPLOYER_PRIVATE_KEY", "PRIVATE_KEY"]));
const configuredDeployer = requiredAddress("LOCK_IN_DEPLOYER_ADDRESS");
const finalOwner = requiredAddress("LOCK_IN_OWNER_ADDRESS");
const evidenceSigner = privateKeyToAccount(localPrivateKey(["EVIDENCE_SIGNER_PRIVATE_KEY"])).address;
const accessSigner = privateKeyToAccount(localPrivateKey(["ACCESS_SIGNER_PRIVATE_KEY"])).address;
if (deployer.address !== configuredDeployer) {
  throw new Error("The local deployer key does not match LOCK_IN_DEPLOYER_ADDRESS");
}
if (evidenceSigner === accessSigner) throw new Error("Evidence and access signing keys must be distinct");
if (deployer.address === evidenceSigner || deployer.address === accessSigner) {
  throw new Error("The funded deployer must not be reused as an application signer");
}
if (finalOwner === deployer.address || finalOwner === evidenceSigner || finalOwner === accessSigner) {
  throw new Error("LOCK_IN_OWNER_ADDRESS must be distinct from the deployer and both application signers");
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
const actualChainId = await publicClient.getChainId();
if (actualChainId !== CHAIN_ID) throw new Error(`Refusing deployment: RPC chain ID is ${actualChainId}`);

const artifact = JSON.parse(
  await readFile("out/LockInEscrow.sol/LockInEscrow.json", "utf8"),
) as { abi: Abi; bytecode: { object: Hex } };
if (!artifact.bytecode.object || artifact.bytecode.object === "0x") throw new Error("LockInEscrow artifact has no bytecode; run forge build");

const args = [token, evidenceSigner, accessSigner] as const;
const deploymentData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args } as never);
const deploymentDataHash = keccak256(deploymentData);
const gasEstimate = await publicClient.estimateGas({ account: deployer, data: deploymentData });
const gasLimit = addMonadGasBuffer(gasEstimate);
const [balance, gasPrice, evidenceSignerBalance, accessSignerBalance, finalOwnerCode] = await Promise.all([
  publicClient.getBalance({ address: deployer.address }),
  publicClient.getGasPrice(),
  publicClient.getBalance({ address: evidenceSigner }),
  publicClient.getBalance({ address: accessSigner }),
  publicClient.getCode({ address: finalOwner }),
]);
if (!finalOwnerCode || finalOwnerCode === "0x") {
  throw new Error("LOCK_IN_OWNER_ADDRESS must be an already-deployed multisig contract");
}
const deploymentMaxFee = gasLimit * gasPrice;
const ownershipTransferGasReserveFee = OWNERSHIP_TRANSFER_GAS_RESERVE * gasPrice;
const totalReservedMaxFee = deploymentMaxFee + ownershipTransferGasReserveFee;
if (balance < totalReservedMaxFee) {
  throw new Error("Deployer does not have enough MON for deployment plus the reserved ownership-transfer gas");
}
if (evidenceSignerBalance !== 0n || accessSignerBalance !== 0n) {
  throw new Error("Application signing keys must use unfunded addresses; generate fresh signer keys");
}

const execute = process.argv.slice(2).includes("--execute");
const unknownOptions = process.argv.slice(2).filter((value) => value !== "--execute");
if (unknownOptions.length > 0) throw new Error(`Unknown argument: ${unknownOptions[0]}`);
const confirmation = `DEPLOY_LOCK_IN_ESCROW_${CHAIN_ID}_${deployer.address}_${finalOwner}_${token}_${evidenceSigner}_${accessSigner}`;
if (execute && process.env.CONFIRM_DEPLOY_ESCROW?.trim() !== confirmation) {
  throw new Error(`Execution refused. Set CONFIRM_DEPLOY_ESCROW exactly to ${confirmation}`);
}

const plan = {
  chainId: actualChainId,
  contract: "LockInEscrow",
  deploymentDataHash,
  contractSchemaId: Number(EXPECTED_CONTRACT_SCHEMA_ID),
  deployer: deployer.address,
  finalOwner,
  finalOwnerHasCode: true,
  deployerBalanceWei: balance.toString(),
  stakeToken: token,
  evidenceSigner,
  accessSigner,
  verification: { scheme: "STRAVA_OAUTH_V1", source: "Strava API over the athlete's OAuth grant" },
  signerBalancesWei: {
    evidence: evidenceSignerBalance.toString(),
    access: accessSignerBalance.toString(),
  },
  minStakeAtomicUnits: "100000",
  maxStakeAtomicUnits: "1000000",
  initialPauses: { creation: true, joining: true, completion: true },
  steps: [
    {
      order: 1,
      action: "deploy paused escrow",
      sender: deployer.address,
      gasEstimate: gasEstimate.toString(),
      gasLimit: gasLimit.toString(),
      estimatedMaxFeeWei: deploymentMaxFee.toString(),
    },
    {
      order: 2,
      action: "transfer ownership to configured multisig",
      sender: deployer.address,
      recipient: finalOwner,
      gasEstimate: "estimated after deployment, before transfer",
      reservedGasLimit: OWNERSHIP_TRANSFER_GAS_RESERVE.toString(),
      reservedMaxFeeWei: ownershipTransferGasReserveFee.toString(),
    },
    {
      order: 3,
      action: "verify final owner and all four pauses at the ownership-transfer block",
      writesOnchain: false,
    },
  ],
  totalReservedMaxFeeWei: totalReservedMaxFee.toString(),
};

if (!execute) {
  console.log(JSON.stringify({
    dryRun: true,
    ...plan,
    confirmationRequired: confirmation,
    nextStep: "Review this plan, set CONFIRM_DEPLOY_ESCROW, then rerun with --execute.",
  }, null, 2));
  process.exit(0);
}

const deploymentHash = await walletClient.deployContract({
  account: deployer,
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args,
  gas: gasLimit,
} as never);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Escrow deployment failed");
const escrow = getAddress(receipt.contractAddress);
const deployedEscrowCode = await publicClient.getCode({ address: escrow, blockNumber: receipt.blockNumber });
if (!deployedEscrowCode || deployedEscrowCode === "0x") throw new Error(`Escrow has no runtime code at ${escrow}`);
const escrowRuntimeCodeHash = keccak256(deployedEscrowCode);

const releaseAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "accessSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "CONTRACT_SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_DURATION_DAYS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "MAX_PARTICIPANTS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "SUBMISSION_GRACE_PERIOD", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "completionPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
const [
  owner,
  deployedToken,
  deployedEvidenceSigner,
  deployedAccessSigner,
  schemaId,
  minStake,
  maxStake,
  maxDurationDays,
  maxParticipants,
  submissionGracePeriod,
  creation,
  joining,
  completion,
] = await Promise.all([
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "owner", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "stakeToken", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "evidenceSigner", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "accessSigner", blockNumber: receipt.blockNumber }),

  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "CONTRACT_SCHEMA_ID", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "MIN_STAKE", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "MAX_STAKE", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "MAX_DURATION_DAYS", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "MAX_PARTICIPANTS", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "SUBMISSION_GRACE_PERIOD", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "creationPaused", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "joiningPaused", blockNumber: receipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "completionPaused", blockNumber: receipt.blockNumber }),
]);
const deployedPausedAndVerified = schemaId === EXPECTED_CONTRACT_SCHEMA_ID
  && getAddress(owner) === deployer.address
  && getAddress(deployedToken) === token
  && getAddress(deployedEvidenceSigner) === evidenceSigner
  && getAddress(deployedAccessSigner) === accessSigner
  && minStake === 100_000n
  && maxStake === 1_000_000n
  && maxDurationDays === 30
  && maxParticipants === 100
  && submissionGracePeriod === 86_400n
  && creation && joining && completion;
if (!deployedPausedAndVerified) throw new Error(`Paused post-deployment invariant failed for ${escrow}`);

const ownershipTransferGasEstimate = await publicClient.estimateContractGas({
  account: deployer,
  address: escrow,
  abi: releaseAbi,
  functionName: "transferOwnership",
  args: [finalOwner],
});
const ownershipTransferGasLimit = addMonadGasBuffer(ownershipTransferGasEstimate);
if (ownershipTransferGasLimit > OWNERSHIP_TRANSFER_GAS_RESERVE) {
  throw new Error(
    `Ownership-transfer gas limit ${ownershipTransferGasLimit} exceeds the dry-run reserve ${OWNERSHIP_TRANSFER_GAS_RESERVE}; contract remains paused at ${escrow}`,
  );
}
const [postDeploymentBalance, ownershipTransferGasPrice] = await Promise.all([
  publicClient.getBalance({ address: deployer.address }),
  publicClient.getGasPrice(),
]);
if (postDeploymentBalance < ownershipTransferGasLimit * ownershipTransferGasPrice) {
  throw new Error(`Insufficient MON to transfer ownership; contract remains paused at ${escrow}`);
}

const ownershipTransferHash = await walletClient.writeContract({
  account: deployer,
  address: escrow,
  abi: releaseAbi,
  functionName: "transferOwnership",
  args: [finalOwner],
  gas: ownershipTransferGasLimit,
});
const ownershipTransferReceipt = await publicClient.waitForTransactionReceipt({ hash: ownershipTransferHash });
if (ownershipTransferReceipt.status !== "success") {
  throw new Error(`Ownership transfer failed; contract remains paused at ${escrow}`);
}

const [transferredOwner, finalCreation, finalJoining, finalCompletion] = await Promise.all([
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "owner", blockNumber: ownershipTransferReceipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "creationPaused", blockNumber: ownershipTransferReceipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "joiningPaused", blockNumber: ownershipTransferReceipt.blockNumber }),
  publicClient.readContract({ address: escrow, abi: releaseAbi, functionName: "completionPaused", blockNumber: ownershipTransferReceipt.blockNumber }),
]);
if (getAddress(transferredOwner) !== finalOwner || !finalCreation || !finalJoining || !finalCompletion) {
  throw new Error(`Final ownership or pause invariant failed for ${escrow}`);
}

console.log(JSON.stringify({
  dryRun: false,
  ...plan,
  escrow,
  escrowRuntimeCodeHash,
  escrowEnvironment: {
    NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS: escrow,
    LOCK_IN_ESCROW_CODE_HASH: escrowRuntimeCodeHash,
  },
  owner: getAddress(transferredOwner),
  deploymentBlock: receipt.blockNumber.toString(),
  deploymentTx: deploymentHash,
  ownershipTransferBlock: ownershipTransferReceipt.blockNumber.toString(),
  ownershipTransferTx: ownershipTransferHash,
  ownershipTransferGasEstimate: ownershipTransferGasEstimate.toString(),
  ownershipTransferGasLimit: ownershipTransferGasLimit.toString(),
  pausedDeploymentVerified: true,
  finalOwnershipVerified: true,
}, null, 2));
