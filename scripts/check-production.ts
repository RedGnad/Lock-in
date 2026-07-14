import "dotenv/config";
import { createPublicClient, defineChain, getAddress, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, lockInAbi } from "../src/lock-in-abi.js";

const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const rawEscrow = required("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS");
if (!isAddress(rawEscrow)) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS is invalid");
const escrow = getAddress(rawEscrow);
const signerKey = (process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() || required("RECLAIM_PRIVATE_KEY")) as Hex;
if (required("SESSION_SIGNING_SECRET").length < 32) throw new Error("SESSION_SIGNING_SECRET is too short");
required("ID");
required("SECRET");
required("NEXT_PUBLIC_PRIVACY_EMAIL");
required("NEXT_PUBLIC_REPOSITORY_URL");

const chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const [chainId, escrowCode, stakeToken, reclaim, evidenceSigner, maxStake, version, maxDays] = await Promise.all([
  client.getChainId(),
  client.getCode({ address: escrow }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "stakeToken" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "reclaim" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "evidenceSigner" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "maxStake" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "VERSION" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MAX_DAYS" }),
]);
const [reclaimCode, tokenCode, tokenDecimals, tokenSymbol] = await Promise.all([
  client.getCode({ address: reclaim }),
  client.getCode({ address: stakeToken }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals" }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol" }),
]);

const checks = {
  chainId: chainId === 143,
  escrowCode: Boolean(escrowCode && escrowCode !== "0x"),
  reclaimCode: Boolean(reclaimCode && reclaimCode !== "0x"),
  tokenCode: Boolean(tokenCode && tokenCode !== "0x"),
  nativeUsdc: getAddress(stakeToken) === EXPECTED_USDC,
  usdcMetadata: tokenDecimals === 6 && tokenSymbol === "USDC",
  oneDollarCap: maxStake === 1_000_000n,
  contractVersion: version === 3n,
  thirtyDayPrograms: maxDays === 30n,
  evidenceSigner: privateKeyToAccount(signerKey).address === getAddress(evidenceSigner),
};
if (!Object.values(checks).every(Boolean)) {
  throw new Error(`Production check failed: ${JSON.stringify(checks)}`);
}

console.log(JSON.stringify({
  ok: true,
  chainId,
  escrow,
  reclaim: getAddress(reclaim),
  stakeToken: getAddress(stakeToken),
  evidenceSigner: getAddress(evidenceSigner),
  maxStakeAtomicUnits: maxStake.toString(),
  checks,
}, null, 2));
