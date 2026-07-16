import { NextResponse } from "next/server";
import { getAddress, isAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { erc20Abi } from "@/src/lock-in-abi";
import { readProductFlagState } from "@/src/product-flags";
import {
  DUOLINGO_OWNERSHIP_REQUEST_HASH,
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_XP_REQUEST_HASH,
} from "@/src/duolingo-proof-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const EXPECTED_CHAIN_ID = 143;
const EXPECTED_CONTRACT_SCHEMA_ID = 1n;
const EXPECTED_MIN_STAKE = 100_000n;
const EXPECTED_MAX_STAKE = 1_000_000n;
const EXPECTED_STAKE_TOKEN = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const EXPECTED_RECLAIM_WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");
const EXPECTED_STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const EXPECTED_STRAVA_PROVIDER_VERSION = "6.0.0";
const EXPECTED_DUOLINGO_PROVIDER_VERSION = "1.0.8";
const healthAbi = [
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "CONTRACT_SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "accessSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "stravaVerifier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "duolingoVerifier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "baselinePaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completionPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
] as const;
const verifierHealthAbi = [
  { type: "function", name: "WITNESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_OWNERSHIP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DUOLINGO_XP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "PARSER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

type ContractPauses = {
  creation: boolean;
  joining: boolean;
  baseline: boolean;
  completion: boolean;
};

type HealthChecks = {
  configuration: boolean;
  productFlags: boolean;
  privacyContact: boolean;
  rpc: boolean;
  chainId: boolean;
  contractCode: boolean;
  contractCodeHash: boolean;
  releaseOwner: boolean;
  contractSchema: boolean;
  contractPauseControls: boolean;
  flagPauseAlignment: boolean;
  stakeTokenAddress: boolean;
  stakeTokenCode: boolean;
  stakeTokenMetadata: boolean;
  oneUsdcCap: boolean;
  proofConfiguration: boolean;
  evidenceSigner: boolean;
  accessSigner: boolean;
  directVerifierBindings: boolean;
  directVerifierCode: boolean;
  directVerifierCodeHashes: boolean;
  directVerifierLiveSchemas: boolean;
  directVerifierWitnesses: boolean;
  directVerifierProviders: boolean;
  directParser: boolean;
};

function publicResponse(input: {
  checks: HealthChecks;
  chainId: number | null;
  contractSchemaId: bigint | null;
  stakeToken: Address | null;
  contractPauses: ContractPauses | null;
  directVerifiers: {
    strava: Address;
    duolingo: Address;
    stravaParser: Address;
    stravaLive: boolean;
    duolingoLive: boolean;
  } | null;
}) {
  const product = readProductFlagState();
  const flagPauseAlignment = Boolean(input.contractPauses)
    && input.contractPauses!.creation === !product.actions.newPacts
    && input.contractPauses!.joining === !product.actions.join
    && input.contractPauses!.baseline === !(product.actions.newPacts || product.actions.join)
    && input.contractPauses!.completion === !product.actions.checkIns;
  const checks = { ...input.checks, productFlags: product.configuration.allConfigured, flagPauseAlignment };
  const ok = Object.values(checks).every(Boolean);
  const configuredEscrow = escrowAddress && isAddress(escrowAddress) ? getAddress(escrowAddress) : null;
  const actions = {
    newPacts: ok && product.actions.newPacts && input.contractPauses?.creation === false,
    join: ok && product.actions.join && input.contractPauses?.joining === false,
    checkIns: ok && product.actions.checkIns && input.contractPauses?.completion === false,
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
      expectedSchemaId: EXPECTED_CONTRACT_SCHEMA_ID.toString(),
      schemaId: input.contractSchemaId?.toString() || null,
      stakeToken: input.stakeToken,
      pauses: input.contractPauses,
      directVerifiers: input.directVerifiers,
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
    contractCodeHash: false,
    releaseOwner: false,
    contractSchema: false,
    contractPauseControls: false,
    flagPauseAlignment: false,
    stakeTokenAddress: false,
    stakeTokenCode: false,
    stakeTokenMetadata: false,
    oneUsdcCap: false,
    proofConfiguration: Boolean(
      process.env.ID?.trim()
        && process.env.SECRET?.trim()
        && (process.env.SESSION_SIGNING_SECRET?.trim().length || 0) >= 32
        && process.env.DUOLINGO_PROVIDER_ID?.trim() === DUOLINGO_PROVIDER_ID
        && process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim()
        && process.env.ACCESS_SIGNER_PRIVATE_KEY?.trim()
        && process.env.LOCK_IN_ESCROW_CODE_HASH?.trim()
        && process.env.LOCK_IN_STRAVA_PARSER_ADDRESS?.trim()
        && process.env.LOCK_IN_STRAVA_VERIFIER_ADDRESS?.trim()
        && process.env.LOCK_IN_DUOLINGO_VERIFIER_ADDRESS?.trim()
        && process.env.RECLAIM_WITNESS_ADDRESS?.trim()
        && process.env.LOCK_IN_STRAVA_PARSER_CODE_HASH?.trim()
        && process.env.LOCK_IN_STRAVA_VERIFIER_CODE_HASH?.trim()
        && process.env.LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH?.trim()
    ),
    evidenceSigner: false,
    accessSigner: false,
    directVerifierBindings: false,
    directVerifierCode: false,
    directVerifierCodeHashes: false,
    directVerifierLiveSchemas: false,
    directVerifierWitnesses: false,
    directVerifierProviders: false,
    directParser: false,
  };
  let chainId: number | null = null;
  let contractSchemaId: bigint | null = null;
  let stakeToken: Address | null = null;
  let contractPauses: ContractPauses | null = null;
  let directVerifiers: {
    strava: Address;
    duolingo: Address;
    stravaParser: Address;
    stravaLive: boolean;
    duolingoLive: boolean;
  } | null = null;

  if (!configuredEscrow) {
    return publicResponse({ checks, chainId, contractSchemaId, stakeToken, contractPauses, directVerifiers });
  }

  const client = lockInPublicClient();
  try {
    chainId = await client.getChainId();
    checks.rpc = true;
    checks.chainId = chainId === EXPECTED_CHAIN_ID;
  } catch {
    return publicResponse({ checks, chainId, contractSchemaId, stakeToken, contractPauses, directVerifiers });
  }

  try {
    const code = await client.getCode({ address: configuredEscrow });
    checks.contractCode = Boolean(code && code !== "0x");
    if (!checks.contractCode) return publicResponse({ checks, chainId, contractSchemaId, stakeToken, contractPauses, directVerifiers });
    const configuredEscrowCodeHash = process.env.LOCK_IN_ESCROW_CODE_HASH?.trim();
    checks.contractCodeHash = Boolean(
      configuredEscrowCodeHash
      && /^0x[0-9a-fA-F]{64}$/.test(configuredEscrowCodeHash)
      && keccak256(code as Hex).toLowerCase() === configuredEscrowCodeHash.toLowerCase()
    );

    const [rawStakeToken, rawSchemaId, minStake, maxStake, rawEvidenceSigner, rawAccessSigner, rawStravaVerifier, rawDuolingoVerifier, rawOwner, creationPaused, joiningPaused, baselinePaused, completionPaused] = await Promise.all([
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "stakeToken" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "CONTRACT_SCHEMA_ID" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "MIN_STAKE" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "MAX_STAKE" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "evidenceSigner" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "accessSigner" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "stravaVerifier" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "duolingoVerifier" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "owner" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "creationPaused" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "joiningPaused" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "baselinePaused" }),
      client.readContract({ address: configuredEscrow, abi: healthAbi, functionName: "completionPaused" }),
    ]);
    stakeToken = getAddress(rawStakeToken);
    contractSchemaId = rawSchemaId;
    checks.contractSchema = rawSchemaId === EXPECTED_CONTRACT_SCHEMA_ID;
    checks.stakeTokenAddress = stakeToken !== zeroAddress && stakeToken === EXPECTED_STAKE_TOKEN;
    checks.oneUsdcCap = minStake === EXPECTED_MIN_STAKE && maxStake === EXPECTED_MAX_STAKE;
    const owner = getAddress(rawOwner);
    const configuredOwner = process.env.LOCK_IN_OWNER_ADDRESS?.trim();
    const ownerCode = await client.getCode({ address: owner });
    checks.releaseOwner = Boolean(
      configuredOwner
      && isAddress(configuredOwner)
      && getAddress(configuredOwner) === owner
      && ownerCode
      && ownerCode !== "0x"
      && owner !== getAddress(rawEvidenceSigner)
      && owner !== getAddress(rawAccessSigner)
    );
    try {
      const key = process.env.EVIDENCE_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
      checks.evidenceSigner = Boolean(key && privateKeyToAccount(key).address === getAddress(rawEvidenceSigner));
    } catch {
      checks.evidenceSigner = false;
    }
    try {
      const key = process.env.ACCESS_SIGNER_PRIVATE_KEY?.trim() as Hex | undefined;
      checks.accessSigner = Boolean(key && privateKeyToAccount(key).address === getAddress(rawAccessSigner));
    } catch {
      checks.accessSigner = false;
    }
    contractPauses = { creation: creationPaused, joining: joiningPaused, baseline: baselinePaused, completion: completionPaused };
    checks.contractPauseControls = true;

    const strava = getAddress(rawStravaVerifier);
    const duolingo = getAddress(rawDuolingoVerifier);
    checks.directVerifierBindings = strava !== zeroAddress && duolingo !== zeroAddress && strava !== duolingo;
    const [
      stravaCode,
      duolingoCode,
      stravaLive,
      duolingoLive,
      stravaWitness,
      duolingoWitness,
      stravaProviderId,
      stravaProviderVersion,
      duolingoProviderId,
      duolingoProviderVersion,
      duolingoOwnershipRequestHash,
      duolingoXpRequestHash,
      stravaParserRaw,
    ] = await Promise.all([
      client.getCode({ address: strava }),
      client.getCode({ address: duolingo }),
      client.readContract({ address: strava, abi: verifierHealthAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
      client.readContract({ address: duolingo, abi: verifierHealthAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
      client.readContract({ address: strava, abi: verifierHealthAbi, functionName: "WITNESS" }),
      client.readContract({ address: duolingo, abi: verifierHealthAbi, functionName: "WITNESS" }),
      client.readContract({ address: strava, abi: verifierHealthAbi, functionName: "STRAVA_PROVIDER_ID" }),
      client.readContract({ address: strava, abi: verifierHealthAbi, functionName: "STRAVA_PROVIDER_VERSION" }),
      client.readContract({ address: duolingo, abi: verifierHealthAbi, functionName: "DUOLINGO_PROVIDER_ID" }),
      client.readContract({ address: duolingo, abi: verifierHealthAbi, functionName: "DUOLINGO_PROVIDER_VERSION" }),
      client.readContract({ address: duolingo, abi: verifierHealthAbi, functionName: "DUOLINGO_OWNERSHIP_REQUEST_HASH" }),
      client.readContract({ address: duolingo, abi: verifierHealthAbi, functionName: "DUOLINGO_XP_REQUEST_HASH" }),
      client.readContract({ address: strava, abi: verifierHealthAbi, functionName: "PARSER" }),
    ]);
    const stravaParser = getAddress(stravaParserRaw);
    const [parserCode, parserLive, parserSchemaId, parserProviderId, parserProviderVersion] = await Promise.all([
      client.getCode({ address: stravaParser }),
      client.readContract({ address: stravaParser, abi: verifierHealthAbi, functionName: "LIVE_SCHEMA_CONFIRMED" }),
      client.readContract({ address: stravaParser, abi: verifierHealthAbi, functionName: "SCHEMA_ID" }),
      client.readContract({ address: stravaParser, abi: verifierHealthAbi, functionName: "STRAVA_PROVIDER_ID" }),
      client.readContract({ address: stravaParser, abi: verifierHealthAbi, functionName: "STRAVA_PROVIDER_VERSION" }),
    ]);
    const configuredStrava = process.env.LOCK_IN_STRAVA_VERIFIER_ADDRESS?.trim();
    const configuredDuolingo = process.env.LOCK_IN_DUOLINGO_VERIFIER_ADDRESS?.trim();
    const configuredParser = process.env.LOCK_IN_STRAVA_PARSER_ADDRESS?.trim();
    checks.directVerifierBindings = checks.directVerifierBindings
      && Boolean(configuredStrava && isAddress(configuredStrava) && getAddress(configuredStrava) === strava)
      && Boolean(configuredDuolingo && isAddress(configuredDuolingo) && getAddress(configuredDuolingo) === duolingo)
      && Boolean(configuredParser && isAddress(configuredParser) && getAddress(configuredParser) === stravaParser);
    checks.directVerifierCode = Boolean(stravaCode && stravaCode !== "0x" && duolingoCode && duolingoCode !== "0x");
    checks.directVerifierLiveSchemas = stravaLive && duolingoLive;
    const configuredWitness = process.env.RECLAIM_WITNESS_ADDRESS?.trim();
    checks.directVerifierWitnesses = getAddress(stravaWitness) === EXPECTED_RECLAIM_WITNESS
      && getAddress(duolingoWitness) === EXPECTED_RECLAIM_WITNESS
      && Boolean(configuredWitness && isAddress(configuredWitness) && getAddress(configuredWitness) === EXPECTED_RECLAIM_WITNESS);
    checks.directVerifierProviders = stravaProviderId === EXPECTED_STRAVA_PROVIDER_ID
      && stravaProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION
      && duolingoProviderId === DUOLINGO_PROVIDER_ID
      && duolingoProviderVersion === EXPECTED_DUOLINGO_PROVIDER_VERSION
      && duolingoOwnershipRequestHash === DUOLINGO_OWNERSHIP_REQUEST_HASH
      && duolingoXpRequestHash === DUOLINGO_XP_REQUEST_HASH;
    checks.directParser = Boolean(parserCode && parserCode !== "0x")
      && parserLive
      && parserSchemaId !== `0x${"00".repeat(32)}`
      && parserProviderId === EXPECTED_STRAVA_PROVIDER_ID
      && parserProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION;
    const parserCodeHash = process.env.LOCK_IN_STRAVA_PARSER_CODE_HASH?.trim();
    const stravaCodeHash = process.env.LOCK_IN_STRAVA_VERIFIER_CODE_HASH?.trim();
    const duolingoCodeHash = process.env.LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH?.trim();
    checks.directVerifierCodeHashes = Boolean(
      parserCode && parserCode !== "0x"
      && stravaCode && stravaCode !== "0x"
      && duolingoCode && duolingoCode !== "0x"
      && parserCodeHash && /^0x[0-9a-fA-F]{64}$/.test(parserCodeHash)
      && stravaCodeHash && /^0x[0-9a-fA-F]{64}$/.test(stravaCodeHash)
      && duolingoCodeHash && /^0x[0-9a-fA-F]{64}$/.test(duolingoCodeHash)
      && keccak256(parserCode).toLowerCase() === parserCodeHash.toLowerCase()
      && keccak256(stravaCode).toLowerCase() === stravaCodeHash.toLowerCase()
      && keccak256(duolingoCode).toLowerCase() === duolingoCodeHash.toLowerCase()
    );
    directVerifiers = { strava, duolingo, stravaParser, stravaLive, duolingoLive };
  } catch {
    return publicResponse({ checks, chainId, contractSchemaId, stakeToken, contractPauses, directVerifiers });
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

  return publicResponse({ checks, chainId, contractSchemaId, stakeToken, contractPauses, directVerifiers });
}
