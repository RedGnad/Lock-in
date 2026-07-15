import { NextResponse } from "next/server";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { erc20Abi } from "@/src/lock-in-abi";
import { readProductFlagState } from "@/src/product-flags";
import { DUOLINGO_PROVIDER_ID } from "@/src/duolingo-proof-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const EXPECTED_CHAIN_ID = 143;
const EXPECTED_CONTRACT_VERSION = 5n;
const EXPECTED_MIN_STAKE = 100_000n;
const EXPECTED_MAX_STAKE = 1_000_000n;
const EXPECTED_STAKE_TOKEN = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const v5HealthAbi = [
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "evidencePaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
] as const;

type ContractPauses = {
  creation: boolean;
  joining: boolean;
  checkIns: boolean;
};

type HealthChecks = {
  configuration: boolean;
  productFlags: boolean;
  privacyContact: boolean;
  rpc: boolean;
  chainId: boolean;
  contractCode: boolean;
  contractVersion: boolean;
  contractPauseControls: boolean;
  flagPauseAlignment: boolean;
  stakeTokenAddress: boolean;
  stakeTokenCode: boolean;
  stakeTokenMetadata: boolean;
  oneUsdcCap: boolean;
  proofConfiguration: boolean;
  evidenceSigner: boolean;
};

function publicResponse(input: {
  checks: HealthChecks;
  chainId: number | null;
  contractVersion: bigint | null;
  stakeToken: Address | null;
  contractPauses: ContractPauses | null;
}) {
  const product = readProductFlagState();
  const flagPauseAlignment = Boolean(input.contractPauses)
    && input.contractPauses!.creation === !product.actions.newPacts
    && input.contractPauses!.joining === !product.actions.join
    && input.contractPauses!.checkIns === !product.actions.checkIns;
  const checks = { ...input.checks, productFlags: product.configuration.allConfigured, flagPauseAlignment };
  const ok = Object.values(checks).every(Boolean);
  const configuredEscrow = escrowAddress && isAddress(escrowAddress) ? getAddress(escrowAddress) : null;
  const actions = {
    newPacts: ok && product.actions.newPacts && input.contractPauses?.creation === false,
    join: ok && product.actions.join && input.contractPauses?.joining === false,
    checkIns: ok && product.actions.checkIns && input.contractPauses?.checkIns === false,
    settlement: true as const,
    claim: true as const,
  };
  const enabledCount = Number(actions.newPacts) + Number(actions.join) + Number(actions.checkIns);
  const mode = enabledCount === 0 ? "paused" : enabledCount === 3 ? "open" : "restricted";

  return NextResponse.json({
    ok,
    mode,
    network: {
      name: "Monad mainnet",
      expectedChainId: EXPECTED_CHAIN_ID,
      chainId: input.chainId,
    },
    actions,
    configuration: {
      escrowAddress: Boolean(configuredEscrow),
      rpcUrl: Boolean(process.env.MONAD_RPC_URL?.trim() || process.env.NEXT_PUBLIC_MONAD_RPC_URL?.trim()),
      privacyContact: Boolean(process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim()),
      productFlags: product.configuration.configured,
      requestedActions: {
        newPacts: product.actions.newPacts,
        join: product.actions.join,
        checkIns: product.actions.checkIns,
      },
    },
    contract: {
      address: configuredEscrow,
      expectedVersion: EXPECTED_CONTRACT_VERSION.toString(),
      version: input.contractVersion?.toString() || null,
      stakeToken: input.stakeToken,
      pauses: input.contractPauses,
    },
    checks,
  }, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  const product = readProductFlagState();
  const configuredEscrow = escrowAddress && isAddress(escrowAddress) ? getAddress(escrowAddress) : null;
  const checks: HealthChecks = {
    configuration: Boolean(configuredEscrow),
    productFlags: product.configuration.allConfigured,
    privacyContact: Boolean(process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim()),
    rpc: false,
    chainId: false,
    contractCode: false,
    contractVersion: false,
    contractPauseControls: false,
    flagPauseAlignment: false,
    stakeTokenAddress: false,
    stakeTokenCode: false,
    stakeTokenMetadata: false,
    oneUsdcCap: false,
    proofConfiguration: Boolean(
      process.env.ID?.trim()
        && process.env.SECRET?.trim()
        && process.env.SESSION_SIGNING_SECRET?.trim()
        && process.env.DUOLINGO_PROVIDER_ID?.trim() === DUOLINGO_PROVIDER_ID
        && process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim()
    ),
    evidenceSigner: false,
  };
  let chainId: number | null = null;
  let contractVersion: bigint | null = null;
  let stakeToken: Address | null = null;
  let contractPauses: ContractPauses | null = null;

  if (!configuredEscrow) {
    return publicResponse({ checks, chainId, contractVersion, stakeToken, contractPauses });
  }

  const client = lockInPublicClient();
  try {
    chainId = await client.getChainId();
    checks.rpc = true;
    checks.chainId = chainId === EXPECTED_CHAIN_ID;
  } catch {
    return publicResponse({ checks, chainId, contractVersion, stakeToken, contractPauses });
  }

  try {
    const code = await client.getCode({ address: configuredEscrow });
    checks.contractCode = Boolean(code && code !== "0x");
    if (!checks.contractCode) return publicResponse({ checks, chainId, contractVersion, stakeToken, contractPauses });

    const [rawStakeToken, rawVersion, minStake, maxStake, rawEvidenceSigner, creationPaused, joiningPaused, checkInsPaused] = await Promise.all([
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "stakeToken" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "VERSION" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "MIN_STAKE" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "MAX_STAKE" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "evidenceSigner" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "creationPaused" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "joiningPaused" }),
      client.readContract({ address: configuredEscrow, abi: v5HealthAbi, functionName: "evidencePaused" }),
    ]);
    stakeToken = getAddress(rawStakeToken);
    contractVersion = rawVersion;
    checks.contractVersion = rawVersion === EXPECTED_CONTRACT_VERSION;
    checks.stakeTokenAddress = stakeToken !== zeroAddress && stakeToken === EXPECTED_STAKE_TOKEN;
    checks.oneUsdcCap = minStake === EXPECTED_MIN_STAKE && maxStake === EXPECTED_MAX_STAKE;
    try {
      const key = process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
      checks.evidenceSigner = Boolean(key && privateKeyToAccount(key).address === getAddress(rawEvidenceSigner));
    } catch {
      checks.evidenceSigner = false;
    }
    contractPauses = { creation: creationPaused, joining: joiningPaused, checkIns: checkInsPaused };
    checks.contractPauseControls = true;
  } catch {
    return publicResponse({ checks, chainId, contractVersion, stakeToken, contractPauses });
  }

  try {
    const [tokenCode, decimals, symbol] = await Promise.all([
      client.getCode({ address: stakeToken }),
      client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol" }),
    ]);
    checks.stakeTokenCode = Boolean(tokenCode && tokenCode !== "0x");
    checks.stakeTokenMetadata = decimals === 6 && symbol === "USDC";
  } catch {
    // A failed token read is represented by false checks; no provider error or
    // potentially credential-bearing RPC URL is returned to the public client.
  }

  return publicResponse({ checks, chainId, contractVersion, stakeToken, contractPauses });
}
