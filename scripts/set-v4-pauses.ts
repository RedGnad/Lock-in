import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addMonadGasBuffer } from "../src/monad-gas.js";

const lockInAbi = [
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "setCreationPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setJoiningPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setCheckInsPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
] as const;

function privateKey(): Hex {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
  const value = raw?.startsWith("0x") ? raw : raw ? `0x${raw}` : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Missing valid local deployer key");
  return value as Hex;
}

function flag(value: string | undefined): boolean {
  if (value !== "true" && value !== "false") throw new Error("Pass exactly: <creation> <joining> <check-ins> as true/false");
  return value === "true";
}

const [creation, joining, checkIns] = process.argv.slice(2).map(flag);
if (creation === undefined || joining === undefined || checkIns === undefined) {
  throw new Error("Pass exactly three pause booleans");
}
const rawAddress = process.env.NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS?.trim() || "";
if (!isAddress(rawAddress)) throw new Error("Missing V4 escrow address");
const escrow = getAddress(rawAddress);
const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(privateKey());
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const [chainId, version, owner] = await Promise.all([
  publicClient.getChainId(),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "VERSION" }),
  publicClient.readContract({
    address: escrow,
    abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
    functionName: "owner",
  }),
]);
if (chainId !== 143 || version !== 4n) throw new Error("Refusing to operate a non-V4 Monad contract");
if (getAddress(owner) !== account.address) throw new Error("Local key is not the V4 owner");

const operations = [
  ["setCreationPaused", creation],
  ["setJoiningPaused", joining],
  ["setCheckInsPaused", checkIns],
] as const;
const hashes: Record<string, Hex> = {};
for (const [functionName, desired] of operations) {
  const request = { address: escrow, abi: lockInAbi, functionName, args: [desired], account } as const;
  const gas = addMonadGasBuffer(await publicClient.estimateContractGas(request));
  const hash = await walletClient.writeContract({ ...request, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  hashes[functionName] = hash;
}

console.log(JSON.stringify({ chainId, escrow, owner, pauses: { creation, joining, checkIns }, hashes }, null, 2));
