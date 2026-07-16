import { NextResponse } from "next/server";
import { getAddress, isAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { erc20Abi, lockInAbi, STRAVA_RUN_MISSION } from "@/src/lock-in-abi";
import { readProductFlagState } from "@/src/product-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Whether this deployment is safe to use, checked against the chain rather than against configuration.
 *
 * Under STRAVA_OAUTH_V1 there is no on-chain verifier left to inspect. What matters now is that the escrow
 * we point at is the one we think it is, that its evidence signer is the key THIS server holds (otherwise
 * every check-in it signs would revert), and that the Strava and token-storage secrets exist at all.
 * Anything unproven reports false and the endpoint answers 503.
 */

const EXPECTED_CHAIN_ID = 143;
const EXPECTED_CONTRACT_SCHEMA_ID = 1n;
const EXPECTED_MIN_STAKE = 100_000n;
const EXPECTED_MAX_STAKE = 1_000_000n;
const EXPECTED_STAKE_TOKEN = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");

type ContractPauses = { creation: boolean; joining: boolean; completion: boolean };
type HealthChecks = Record<string, boolean>;

function rpcConfigured(): boolean {
  return Boolean(process.env.MONAD_RPC_URL?.trim() || process.env.NEXT_PUBLIC_MONAD_RPC_URL?.trim());
}

function signerMatches(envKey: string, onchain: unknown): boolean {
  const key = process.env[envKey]?.trim() as Hex | undefined;
  if (!key || typeof onchain !== "string" || !isAddress(onchain)) return false;
  try {
    return privateKeyToAccount(key).address === getAddress(onchain);
  } catch {
    return false;
  }
}

function respond(input: {
  checks: HealthChecks;
  chainId?: number;
  contractSchemaId?: bigint;
  stakeToken?: string;
  contractPauses?: ContractPauses;
  missionPolicyHash?: string;
}) {
  const product = readProductFlagState();
  const flagPauseAlignment = input.contractPauses === undefined
    || (input.contractPauses.creation === !product.actions.newPacts
      && input.contractPauses.joining === !product.actions.join
      && input.contractPauses.completion === !product.actions.checkIns);
  const checks = { ...input.checks, productFlags: product.configuration.allConfigured, flagPauseAlignment };
  const ok = Object.values(checks).every(Boolean);
  const configured = escrowAddress && isAddress(escrowAddress) ? getAddress(escrowAddress) : null;

  const actions = {
    newPacts: ok && product.actions.newPacts && input.contractPauses?.creation === false,
    join: ok && product.actions.join && input.contractPauses?.joining === false,
    checkIns: ok && product.actions.checkIns && input.contractPauses?.completion === false,
    settlement: true as const,
    claim: true as const,
  };
  const enabled = Number(actions.newPacts) + Number(actions.join) + Number(actions.checkIns);

  return NextResponse.json({
    ok,
    mode: enabled === 0 ? "paused" : enabled === 3 ? "open" : "restricted",
    verification: {
      // Stated, so nobody has to infer the trust model from an absence: Lock In reads Strava's own API
      // over the athlete's OAuth grant and signs the result. There is no independent on-chain witness.
      scheme: "STRAVA_OAUTH_V1",
      source: "Strava API, over the athlete's OAuth grant",
      trustedParty: "the Lock In evidence signer",
    },
    network: { name: "Monad mainnet", expectedChainId: EXPECTED_CHAIN_ID, chainId: input.chainId ?? null },
    actions,
    configuration: {
      escrowAddress: Boolean(configured),
      rpcUrl: rpcConfigured(),
      privacyContact: Boolean(process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim()),
      productFlags: product.configuration.configured,
      requestedActions: {
        newPacts: product.actions.newPacts,
        join: product.actions.join,
        checkIns: product.actions.checkIns,
      },
    },
    contract: {
      address: configured,
      expectedSchemaId: EXPECTED_CONTRACT_SCHEMA_ID.toString(),
      schemaId: input.contractSchemaId?.toString() || null,
      stakeToken: input.stakeToken ?? null,
      missionPolicyHash: input.missionPolicyHash ?? null,
      pauses: input.contractPauses ?? null,
    },
    checks,
  }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const product = readProductFlagState();
  const configured = escrowAddress && isAddress(escrowAddress) ? getAddress(escrowAddress) : null;
  const encryptionKey = process.env.STRAVA_TOKEN_ENCRYPTION_KEY?.trim();

  const checks: HealthChecks = {
    configuration: Boolean(configured),
    productFlags: product.configuration.allConfigured,
    privacyContact: Boolean(process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim()),
    // Without these an athlete cannot connect Strava at all, or their tokens cannot be stored safely.
    stravaOAuthConfigured: Boolean(process.env.STRAVA_CLIENT_ID?.trim() && process.env.STRAVA_CLIENT_SECRET?.trim()),
    tokenEncryptionConfigured: Boolean(encryptionKey) && Buffer.from(encryptionKey!, "base64").length === 32,
    tokenStorageConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    stateSigningConfigured: (process.env.SESSION_SIGNING_SECRET?.trim().length ?? 0) >= 32,
    rpc: false,
    chainId: false,
    contractCode: false,
    contractCodeHash: false,
    contractSchema: false,
    stakeTokenAddress: false,
    stakeTokenCode: false,
    stakeTokenMetadata: false,
    oneUsdcCap: false,
    releaseOwner: false,
    evidenceSigner: false,
    accessSigner: false,
    contractPauseControls: false,
  };

  if (!configured || !rpcConfigured()) return respond({ checks });

  try {
    const client = lockInPublicClient();
    const chainId = await client.getChainId();
    checks.rpc = true;
    checks.chainId = chainId === EXPECTED_CHAIN_ID;

    const code = await client.getCode({ address: configured });
    checks.contractCode = Boolean(code && code !== "0x");
    if (!checks.contractCode) return respond({ checks, chainId });

    const expectedCodeHash = process.env.LOCK_IN_ESCROW_CODE_HASH?.trim();
    checks.contractCodeHash = Boolean(
      expectedCodeHash && keccak256(code!).toLowerCase() === expectedCodeHash.toLowerCase(),
    );

    const [schemaId, rawStakeToken, minStake, maxStake, rawEvidenceSigner, rawAccessSigner, rawOwner, creation, joining, completion, policyHash] =
      await Promise.all([
        client.readContract({ address: configured, abi: lockInAbi, functionName: "CONTRACT_SCHEMA_ID" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "stakeToken" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "MIN_STAKE" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "MAX_STAKE" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "evidenceSigner" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "accessSigner" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "owner" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "creationPaused" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "joiningPaused" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "completionPaused" }),
        client.readContract({ address: configured, abi: lockInAbi, functionName: "missionPolicyHash", args: [STRAVA_RUN_MISSION] }),
      ]);

    const stakeToken = getAddress(rawStakeToken as Address);
    checks.contractSchema = (schemaId as bigint) === EXPECTED_CONTRACT_SCHEMA_ID;
    checks.stakeTokenAddress = stakeToken !== zeroAddress && stakeToken === EXPECTED_STAKE_TOKEN;
    checks.oneUsdcCap = (minStake as bigint) === EXPECTED_MIN_STAKE && (maxStake as bigint) === EXPECTED_MAX_STAKE;

    const stakeTokenCode = await client.getCode({ address: stakeToken });
    checks.stakeTokenCode = Boolean(stakeTokenCode && stakeTokenCode !== "0x");
    try {
      const [decimals, symbol] = await Promise.all([
        client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "symbol" }),
      ]);
      checks.stakeTokenMetadata = decimals === 6 && String(symbol).toUpperCase().includes("USDC");
    } catch {
      checks.stakeTokenMetadata = false;
    }

    const owner = getAddress(rawOwner as Address);
    const configuredOwner = process.env.LOCK_IN_OWNER_ADDRESS?.trim();
    const ownerCode = await client.getCode({ address: owner });
    // The owner must be the release Safe, a contract, never an EOA holding unilateral power.
    checks.releaseOwner = Boolean(
      configuredOwner && isAddress(configuredOwner) && owner === getAddress(configuredOwner)
        && ownerCode && ownerCode !== "0x",
    );

    // If this is false, every attestation this server signs would be rejected by the escrow.
    checks.evidenceSigner = signerMatches("EVIDENCE_SIGNER_PRIVATE_KEY", rawEvidenceSigner);
    checks.accessSigner = signerMatches("ACCESS_SIGNER_PRIVATE_KEY", rawAccessSigner);
    checks.contractPauseControls = true;

    return respond({
      checks,
      chainId,
      contractSchemaId: schemaId as bigint,
      stakeToken,
      contractPauses: {
        creation: creation as boolean,
        joining: joining as boolean,
        completion: completion as boolean,
      },
      missionPolicyHash: policyHash as string,
    });
  } catch {
    return respond({ checks });
  }
}
