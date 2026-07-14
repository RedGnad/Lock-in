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
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addMonadGasBuffer } from "../src/monad-gas.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function deployerPrivateKey(): Hex {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing DEPLOYER_PRIVATE_KEY or PRIVATE_KEY in .env");
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Deployment private key must be a 32-byte hex value");
  }
  return value as Hex;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const expectedChainId = Number(process.env.MONAD_CHAIN_ID?.trim() || "143");
if (expectedChainId !== 143) throw new Error("Lock In hackathon deployment is pinned to Monad chain ID 143");

const token = required("STAKE_TOKEN_ADDRESS");
const reclaim = required("RECLAIM_CONTRACT_ADDRESS");
const evidenceSigner = required("EVIDENCE_SIGNER_ADDRESS");
if (!isAddress(token) || !isAddress(reclaim) || !isAddress(evidenceSigner)) {
  throw new Error("STAKE_TOKEN_ADDRESS, RECLAIM_CONTRACT_ADDRESS and EVIDENCE_SIGNER_ADDRESS must be valid addresses");
}
const maxStake = BigInt(required("MAX_STAKE_ATOMIC_UNITS"));
if (maxStake <= 0n) throw new Error("MAX_STAKE_ATOMIC_UNITS must be positive");

const chain = defineChain({
  id: expectedChainId,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(deployerPrivateKey());
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const actualChainId = await publicClient.getChainId();
if (actualChainId !== expectedChainId) {
  throw new Error(`Refusing deployment: RPC chain ID is ${actualChainId}`);
}

const artifact = JSON.parse(
  await readFile("out/LockInEscrow.sol/LockInEscrow.json", "utf8"),
) as { abi: Abi; bytecode: { object: Hex } };
const args = [getAddress(token), getAddress(reclaim), getAddress(evidenceSigner), maxStake] as const;
const deploymentData = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args,
} as never);
const gasEstimate = await publicClient.estimateGas({ account, data: deploymentData });
const deploymentHash = await walletClient.deployContract({
  account,
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args,
  gas: addMonadGasBuffer(gasEstimate),
} as never);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
if (!receipt.contractAddress) throw new Error("Escrow deployment returned no address");

console.log(JSON.stringify({
  chainId: actualChainId,
  deployer: account.address,
  stakeToken: getAddress(token),
  reclaim: getAddress(reclaim),
  evidenceSigner: getAddress(evidenceSigner),
  maxStakeAtomicUnits: maxStake.toString(),
  escrow: receipt.contractAddress,
  deploymentTx: deploymentHash,
}, null, 2));
