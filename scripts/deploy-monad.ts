import "dotenv/config";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addMonadGasBuffer } from "../src/monad-gas.js";

const WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");
const WITNESS_HOST = "https://reclaim-node.questbook.app";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function artifact(path: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const json = JSON.parse(await readFile(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(required("DEPLOYER_PRIVATE_KEY") as Hex);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

async function deployContract(abi: Abi, bytecode: Hex, args: readonly unknown[] = []) {
  const data = encodeDeployData({ abi, bytecode, args } as never);
  const estimate = await publicClient.estimateGas({ account, data });
  return walletClient.deployContract({
    account,
    abi,
    bytecode,
    args,
    gas: addMonadGasBuffer(estimate),
  } as never);
}

const actualChainId = await publicClient.getChainId();
if (actualChainId !== 143) {
  throw new Error(`Refusing deployment: RPC chain ID is ${actualChainId}`);
}

const reclaimArtifact = await artifact("out/Reclaim.sol/Reclaim.json");
const proxyArtifact = await artifact("out/ReclaimProxy.sol/ReclaimProxy.json");

const reclaimHash = await deployContract(reclaimArtifact.abi, reclaimArtifact.bytecode);
const reclaimReceipt = await publicClient.waitForTransactionReceipt({ hash: reclaimHash });
if (!reclaimReceipt.contractAddress) throw new Error("Reclaim deployment returned no address");

const initializationData = encodeFunctionData({
  abi: reclaimArtifact.abi,
  functionName: "initialize",
  args: ["0x0000000000000000000000000000000000000000"],
});
const proxyHash = await deployContract(proxyArtifact.abi, proxyArtifact.bytecode, [
  reclaimReceipt.contractAddress,
  initializationData,
]);
const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
if (!proxyReceipt.contractAddress) throw new Error("Reclaim proxy deployment returned no address");

const epochRequest = {
  account,
  address: proxyReceipt.contractAddress,
  abi: reclaimArtifact.abi,
  functionName: "addNewEpoch",
  args: [[{ addr: WITNESS, host: WITNESS_HOST }], 1],
} as const;
const epochEstimate = await publicClient.estimateContractGas(epochRequest);
const epochHash = await walletClient.writeContract({
  ...epochRequest,
  gas: addMonadGasBuffer(epochEstimate),
});
await publicClient.waitForTransactionReceipt({ hash: epochHash });

let spike: { address: string; deploymentTx: Hex } | undefined;
if (process.env.DEPLOY_RECLAIM_SPIKE?.trim().toLowerCase() === "true") {
  const spikeArtifact = await artifact("out/LockInReclaimSpike.sol/LockInReclaimSpike.json");
  const spikeHash = await deployContract(spikeArtifact.abi, spikeArtifact.bytecode, [proxyReceipt.contractAddress]);
  const spikeReceipt = await publicClient.waitForTransactionReceipt({ hash: spikeHash });
  if (!spikeReceipt.contractAddress) throw new Error("Spike deployment returned no address");
  spike = { address: spikeReceipt.contractAddress, deploymentTx: spikeHash };
}

console.log(JSON.stringify({
  chainId: actualChainId,
  deployer: account.address,
  reclaim: proxyReceipt.contractAddress,
  reclaimImplementation: reclaimReceipt.contractAddress,
  reclaimImplementationDeployTx: reclaimHash,
  reclaimProxyDeployTx: proxyHash,
  epochTx: epochHash,
  spike: spike || null,
  witness: WITNESS,
}, null, 2));
