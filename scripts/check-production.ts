import "dotenv/config";
import { createPublicClient, defineChain, getAddress, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, lockInAbi } from "../src/lock-in-abi.js";
import { readProductFlagState } from "../src/product-flags.js";
import { DUOLINGO_PROVIDER_ID } from "../src/duolingo-proof-policy.js";

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
required("NEXT_PUBLIC_PRIVACY_EMAIL");
required("NEXT_PUBLIC_REPOSITORY_URL");
required("ID");
required("SECRET");
required("SESSION_SIGNING_SECRET");
if (required("DUOLINGO_PROVIDER_ID") !== DUOLINGO_PROVIDER_ID) throw new Error("Duolingo provider does not match the pinned ID");
const evidenceSignerKey = (
  process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() || process.env.RECLAIM_PRIVATE_KEY?.trim() || ""
) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(evidenceSignerKey)) throw new Error("Invalid EVIDENCE_SIGNER_PRIVATE_KEY");
const product = readProductFlagState();
if (!product.configuration.allConfigured) throw new Error("All product action flags must be explicitly true or false");

const chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const [chainId, escrowCode, stakeToken, minStake, maxStake, version, maxDays, evidenceSigner, creationPaused, joiningPaused, checkInsPaused] = await Promise.all([
  client.getChainId(),
  client.getCode({ address: escrow }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "stakeToken" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MIN_STAKE" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MAX_STAKE" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "VERSION" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "MAX_DURATION_DAYS" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "evidenceSigner" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused" }),
  client.readContract({ address: escrow, abi: lockInAbi, functionName: "evidencePaused" }),
]);
const [tokenCode, tokenDecimals, tokenSymbol] = await Promise.all([
  client.getCode({ address: stakeToken }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals" }),
  client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol" }),
]);

const checks = {
  chainId: chainId === 143,
  escrowCode: Boolean(escrowCode && escrowCode !== "0x"),
  tokenCode: Boolean(tokenCode && tokenCode !== "0x"),
  nativeUsdc: getAddress(stakeToken) === EXPECTED_USDC,
  usdcMetadata: tokenDecimals === 6 && tokenSymbol === "USDC",
  stakeBounds: minStake === 100_000n && maxStake === 1_000_000n,
  contractVersion: version === 5n,
  evidenceSigner: getAddress(evidenceSigner) === privateKeyToAccount(evidenceSignerKey).address,
  thirtyDayPrograms: maxDays === 30,
  productFlagsConfigured: product.configuration.allConfigured,
  flagPauseAlignment:
    creationPaused === !product.actions.newPacts
    && joiningPaused === !product.actions.join
    && checkInsPaused === !product.actions.checkIns,
};
if (!Object.values(checks).every(Boolean)) throw new Error(`Production check failed: ${JSON.stringify(checks)}`);

console.log(JSON.stringify({
  ok: true,
  chainId,
  escrow,
  stakeToken: getAddress(stakeToken),
  minStakeAtomicUnits: minStake.toString(),
  maxStakeAtomicUnits: maxStake.toString(),
  actions: product.actions,
  contractPauses: { creation: creationPaused, joining: joiningPaused, checkIns: checkInsPaused },
  checks,
}, null, 2));
