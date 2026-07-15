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
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Deployment private key must be a 32-byte hex value");
  return value as Hex;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const expectedChainId = Number(process.env.MONAD_CHAIN_ID?.trim() || "143");
if (expectedChainId !== 143) throw new Error("Lock In is pinned to Monad mainnet chain ID 143");

const token = required("STAKE_TOKEN_ADDRESS");
if (!isAddress(token)) throw new Error("STAKE_TOKEN_ADDRESS must be a valid address");
const evidenceSignerKey = (
  process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() || process.env.RECLAIM_PRIVATE_KEY?.trim() || ""
) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(evidenceSignerKey)) throw new Error("EVIDENCE_SIGNER_PRIVATE_KEY must be a 32-byte hex value");
const evidenceSigner = privateKeyToAccount(evidenceSignerKey).address;

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
if (actualChainId !== expectedChainId) throw new Error(`Refusing deployment: RPC chain ID is ${actualChainId}`);

const artifact = JSON.parse(
  await readFile("out/LockInEscrowV5.sol/LockInEscrowV5.json", "utf8"),
) as { abi: Abi; bytecode: { object: Hex } };
const args = [getAddress(token), evidenceSigner] as const;
const deploymentData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args } as never);
const gasEstimate = await publicClient.estimateGas({ account, data: deploymentData });
const gasWithMargin = addMonadGasBuffer(gasEstimate);
const [balance, gasPrice] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.getGasPrice()]);
const estimatedMaxFee = gasWithMargin * gasPrice;
if (balance < estimatedMaxFee) throw new Error("Deployer does not have enough MON for the deployment gas limit");

const dryRun = ["1", "true"].includes((process.env.DRY_RUN || "").toLowerCase());
if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    chainId: actualChainId,
    deployer: account.address,
    deployerBalanceWei: balance.toString(),
    stakeToken: getAddress(token),
    evidenceSigner,
    contractVersion: 5,
    minStakeAtomicUnits: "100000",
    maxStakeAtomicUnits: "1000000",
    initialPauses: { creation: true, joining: true, evidence: true },
    gasEstimate: gasEstimate.toString(),
    gasLimit: gasWithMargin.toString(),
    estimatedMaxFeeWei: estimatedMaxFee.toString(),
  }, null, 2));
} else {
  const deploymentHash = await walletClient.deployContract({
    account,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
    gas: gasWithMargin,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  if (!receipt.contractAddress) throw new Error("Escrow deployment returned no address");

  console.log(JSON.stringify({
    chainId: actualChainId,
    deployer: account.address,
    owner: account.address,
    stakeToken: getAddress(token),
    evidenceSigner,
    contractVersion: 5,
    minStakeAtomicUnits: "100000",
    maxStakeAtomicUnits: "1000000",
    initialPauses: { creation: true, joining: true, evidence: true },
    escrow: receipt.contractAddress,
    deploymentBlock: receipt.blockNumber.toString(),
    deploymentTx: deploymentHash,
  }, null, 2));
}
