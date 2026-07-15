import "dotenv/config";
import {
  createPublicClient,
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, lockInAbi } from "../src/lock-in-abi.js";
import { releaseMetadataAbi, releasePactAbi, type ReleasePactTuple } from "./release-contract.js";

const CHAIN_ID = 143;
const EXPECTED_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const EXPECTED_RECLAIM_WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");
const EXPECTED_STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const EXPECTED_STRAVA_PROVIDER_VERSION = "1.0.3";
const EXPECTED_DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
const EXPECTED_DUOLINGO_PROVIDER_VERSION = "1.0.4";
const EXPECTED_DUOLINGO_OWNERSHIP_REQUEST_HASH = "0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e";
const EXPECTED_DUOLINGO_XP_REQUEST_HASH = "0x1e2b7c4c1dbfe8694e49eee2c1e92ccac09ef048be735e5c54af7c006509b2ac";
const CANARY_STAKE = 100_000n;
const REQUIRED_USDC_PER_WALLET = 200_000n;
const DEFAULT_APP_URL = "https://lock-in-liart-theta.vercel.app";

type CheckValue = boolean | null;
type PauseState = { creation: boolean; joining: boolean; baseline: boolean; completion: boolean };

type HealthSummary = {
  reachable: boolean;
  ok: boolean;
  mode: string | null;
  actions: { newPacts: boolean; join: boolean; checkIns: boolean } | null;
  escrowAddress: Address | null;
  pauses: PauseState | null;
};

type ParticipantSnapshot = {
  address: Address;
  joined: boolean;
  completionBitmap: string;
  completionCount: number;
  identityHash: string;
  lastMetric: string;
  claimed: boolean;
  usdcBalanceAtomic: string;
};

function optionalAddress(name: "CANARY_WALLET_A" | "CANARY_WALLET_B"): Address | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!isAddress(value)) throw new Error(`${name}_INVALID`);
  return getAddress(value);
}

function optionalConfiguredAddress(name: string): Address | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!isAddress(value)) throw new Error(`${name}_INVALID`);
  return getAddress(value);
}

function optionalConfiguredHash(name: string): Hex | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name}_INVALID`);
  return value.toLowerCase() as Hex;
}

function optionalSigner(name: "EVIDENCE_SIGNER_PRIVATE_KEY" | "ACCESS_SIGNER_PRIVATE_KEY"): Address | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name}_INVALID`);
  return privateKeyToAccount(value).address;
}

function expectedPactIds(): bigint[] | null {
  const value = process.env.CANARY_EXPECTED_PACT_IDS?.trim();
  if (!value) return null;
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => !/^[1-9][0-9]*$/.test(item))) throw new Error("CANARY_EXPECTED_PACT_IDS_INVALID");
  return Array.from(new Set(values.map((value) => BigInt(value))))
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function pactIdArgument(): bigint {
  const args = process.argv.slice(3);
  const optionIndex = args.indexOf("--pact");
  const inline = args.find((value) => value.startsWith("--pact="))?.slice("--pact=".length);
  const value = inline || (optionIndex >= 0 ? args[optionIndex + 1] : undefined) || process.env.PACT_ID?.trim();
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error("PACT_ID_MISSING_OR_INVALID");
  return BigInt(value);
}

function allChecksPass(checks: Record<string, CheckValue>): boolean {
  return Object.values(checks).every((value) => value === true);
}

function configuredCanaryAllowlist(): Address[] | null {
  const raw = process.env.CANARY_ALLOWED_WALLETS?.trim();
  if (!raw) return null;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !isAddress(value))) {
    throw new Error("CANARY_ALLOWED_WALLETS_INVALID");
  }
  return Array.from(new Set(values.map((value) => getAddress(value))));
}

function sameAddressSet(left: readonly Address[], right: readonly Address[]): boolean {
  const normalize = (values: readonly Address[]) => values.map((value) => value.toLowerCase()).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function signedDelta(balance: bigint, liability: bigint): string {
  return balance >= liability ? (balance - liability).toString() : `-${liability - balance}`;
}

function pactState(pact: ReleasePactTuple, now: bigint, submissionGracePeriod: bigint): string {
  const endsAt = pact[1] + BigInt(pact[7]) * 86_400n;
  if (pact[15] && pact[16]) return "refund-ready";
  if (pact[15]) return "finalized";
  if (pact[16]) return "cancelled";
  if (now < pact[1]) return "registration";
  if (pact[4] < pact[9]) return "underfilled";
  if (now < endsAt) return "active";
  if (now < endsAt + submissionGracePeriod) return "submission-grace";
  return "settlement-ready";
}

function liabilityFor(pact: ReleasePactTuple): bigint {
  return pact[15] ? pact[14] : pact[2] * BigInt(pact[4]);
}

function print(value: unknown, ok: boolean): void {
  console.log(JSON.stringify(value, null, 2));
  if (!ok) process.exitCode = 1;
}

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const rawEscrow = process.env.NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS?.trim() || "";
const escrow = isAddress(rawEscrow) ? getAddress(rawEscrow) : zeroAddress;
const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const verifierAbi = [
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

async function contractIdentity(blockNumber?: bigint) {
  const block = blockNumber === undefined ? {} : { blockNumber };
  const [
    chainId,
    code,
    schemaId,
    stakeToken,
    minStake,
    maxStake,
    submissionGracePeriod,
    owner,
    evidenceSigner,
    accessSigner,
    stravaVerifier,
    duolingoVerifier,
    creation,
    joining,
    baseline,
    completion,
  ] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: escrow, ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "CONTRACT_SCHEMA_ID", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "stakeToken", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "MIN_STAKE", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "MAX_STAKE", ...block }),
    client.readContract({ address: escrow, abi: releaseMetadataAbi, functionName: "SUBMISSION_GRACE_PERIOD", ...block }),
    client.readContract({ address: escrow, abi: releaseMetadataAbi, functionName: "owner", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "evidenceSigner", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "accessSigner", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "stravaVerifier", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "duolingoVerifier", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "baselinePaused", ...block }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "completionPaused", ...block }),
  ]);
  const canonicalOwner = getAddress(owner);
  const ownerCode = await client.getCode({ address: canonicalOwner, ...block });
  const canonicalStravaVerifier = getAddress(stravaVerifier);
  const canonicalDuolingoVerifier = getAddress(duolingoVerifier);
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
    client.getCode({ address: canonicalStravaVerifier, ...block }),
    client.getCode({ address: canonicalDuolingoVerifier, ...block }),
    client.readContract({ address: canonicalStravaVerifier, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", ...block }),
    client.readContract({ address: canonicalDuolingoVerifier, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", ...block }),
    client.readContract({ address: canonicalStravaVerifier, abi: verifierAbi, functionName: "WITNESS", ...block }),
    client.readContract({ address: canonicalDuolingoVerifier, abi: verifierAbi, functionName: "WITNESS", ...block }),
    client.readContract({ address: canonicalStravaVerifier, abi: verifierAbi, functionName: "STRAVA_PROVIDER_ID", ...block }),
    client.readContract({ address: canonicalStravaVerifier, abi: verifierAbi, functionName: "STRAVA_PROVIDER_VERSION", ...block }),
    client.readContract({ address: canonicalDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_ID", ...block }),
    client.readContract({ address: canonicalDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_PROVIDER_VERSION", ...block }),
    client.readContract({ address: canonicalDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_OWNERSHIP_REQUEST_HASH", ...block }),
    client.readContract({ address: canonicalDuolingoVerifier, abi: verifierAbi, functionName: "DUOLINGO_XP_REQUEST_HASH", ...block }),
    client.readContract({ address: canonicalStravaVerifier, abi: verifierAbi, functionName: "PARSER", ...block }),
  ]);
  const canonicalStravaParser = getAddress(stravaParserRaw);
  const [parserCode, parserLive, parserSchemaId, parserProviderId, parserProviderVersion] = await Promise.all([
    client.getCode({ address: canonicalStravaParser, ...block }),
    client.readContract({ address: canonicalStravaParser, abi: verifierAbi, functionName: "LIVE_SCHEMA_CONFIRMED", ...block }),
    client.readContract({ address: canonicalStravaParser, abi: verifierAbi, functionName: "SCHEMA_ID", ...block }),
    client.readContract({ address: canonicalStravaParser, abi: verifierAbi, functionName: "STRAVA_PROVIDER_ID", ...block }),
    client.readContract({ address: canonicalStravaParser, abi: verifierAbi, functionName: "STRAVA_PROVIDER_VERSION", ...block }),
  ]);
  return {
    chainId,
    codePresent: Boolean(code && code !== "0x"),
    codeHash: code && code !== "0x" ? keccak256(code) : null,
    schemaId,
    stakeToken: getAddress(stakeToken),
    minStake,
    maxStake,
    submissionGracePeriod,
    owner: canonicalOwner,
    ownerCodePresent: Boolean(ownerCode && ownerCode !== "0x"),
    evidenceSigner: getAddress(evidenceSigner),
    accessSigner: getAddress(accessSigner),
    directVerifiers: {
      strava: canonicalStravaVerifier,
      duolingo: canonicalDuolingoVerifier,
      stravaParser: canonicalStravaParser,
      codePresent: Boolean(stravaCode && stravaCode !== "0x" && duolingoCode && duolingoCode !== "0x"),
      stravaCodeHash: stravaCode && stravaCode !== "0x" ? keccak256(stravaCode) : null,
      duolingoCodeHash: duolingoCode && duolingoCode !== "0x" ? keccak256(duolingoCode) : null,
      parserCodeHash: parserCode && parserCode !== "0x" ? keccak256(parserCode) : null,
      liveSchemas: stravaLive && duolingoLive,
      witnessesPinned:
        getAddress(stravaWitness) === EXPECTED_RECLAIM_WITNESS
        && getAddress(duolingoWitness) === EXPECTED_RECLAIM_WITNESS,
      providersPinned:
        stravaProviderId === EXPECTED_STRAVA_PROVIDER_ID
        && stravaProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION
        && duolingoProviderId === EXPECTED_DUOLINGO_PROVIDER_ID
        && duolingoProviderVersion === EXPECTED_DUOLINGO_PROVIDER_VERSION
        && duolingoOwnershipRequestHash === EXPECTED_DUOLINGO_OWNERSHIP_REQUEST_HASH
        && duolingoXpRequestHash === EXPECTED_DUOLINGO_XP_REQUEST_HASH,
      parserPinned:
        Boolean(parserCode && parserCode !== "0x")
        && parserLive
        && parserSchemaId !== `0x${"00".repeat(32)}`
        && parserProviderId === EXPECTED_STRAVA_PROVIDER_ID
        && parserProviderVersion === EXPECTED_STRAVA_PROVIDER_VERSION,
    },
    pauses: { creation, joining, baseline, completion },
  };
}

async function productionHealth(): Promise<HealthSummary> {
  const appUrl = process.env.CANARY_APP_URL?.trim() || DEFAULT_APP_URL;
  try {
    const endpoint = new URL("/api/health", appUrl);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("INVALID_PROTOCOL");
    const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const value = await response.json() as {
      ok?: boolean;
      mode?: string;
      actions?: { newPacts?: boolean; join?: boolean; checkIns?: boolean };
      contract?: { address?: string; pauses?: Partial<PauseState> };
    };
    const address = value.contract?.address && isAddress(value.contract.address)
      ? getAddress(value.contract.address)
      : null;
    const pauses = value.contract?.pauses;
    return {
      reachable: true,
      ok: value.ok === true,
      mode: typeof value.mode === "string" ? value.mode : null,
      actions: value.actions ? {
        newPacts: value.actions.newPacts === true,
        join: value.actions.join === true,
        checkIns: value.actions.checkIns === true,
      } : null,
      escrowAddress: address,
      pauses: pauses ? {
        creation: pauses.creation === true,
        joining: pauses.joining === true,
        baseline: pauses.baseline === true,
        completion: pauses.completion === true,
      } : null,
    };
  } catch {
    return { reachable: false, ok: false, mode: null, actions: null, escrowAddress: null, pauses: null };
  }
}

async function walletSnapshot(address: Address) {
  const [nativeBalance, usdcBalance, allowance] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: EXPECTED_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    client.readContract({ address: EXPECTED_USDC, abi: erc20Abi, functionName: "allowance", args: [address, escrow] }),
  ]);
  return {
    address,
    nativeBalanceWei: nativeBalance.toString(),
    nativeBalanceMon: formatEther(nativeBalance),
    usdcBalanceAtomic: usdcBalance.toString(),
    usdcBalance: formatUnits(usdcBalance, 6),
    allowanceAtomic: allowance.toString(),
    hasNativeGas: nativeBalance > 0n,
    hasParallelCanaryUsdc: usdcBalance >= REQUIRED_USDC_PER_WALLET,
  };
}

async function preflight(): Promise<void> {
  const walletA = optionalAddress("CANARY_WALLET_A");
  const walletB = optionalAddress("CANARY_WALLET_B");
  const expectedEvidenceSigner = optionalSigner("EVIDENCE_SIGNER_PRIVATE_KEY");
  const expectedAccessSigner = optionalSigner("ACCESS_SIGNER_PRIVATE_KEY");
  const expectedEscrowCodeHash = optionalConfiguredHash("LOCK_IN_ESCROW_CODE_HASH");
  const expectedOwner = optionalConfiguredAddress("LOCK_IN_OWNER_ADDRESS");
  const expectedStravaParser = optionalConfiguredAddress("LOCK_IN_STRAVA_PARSER_ADDRESS");
  const expectedStravaVerifier = optionalConfiguredAddress("LOCK_IN_STRAVA_VERIFIER_ADDRESS");
  const expectedDuolingoVerifier = optionalConfiguredAddress("LOCK_IN_DUOLINGO_VERIFIER_ADDRESS");
  const expectedStravaParserCodeHash = optionalConfiguredHash("LOCK_IN_STRAVA_PARSER_CODE_HASH");
  const expectedStravaVerifierCodeHash = optionalConfiguredHash("LOCK_IN_STRAVA_VERIFIER_CODE_HASH");
  const expectedDuolingoVerifierCodeHash = optionalConfiguredHash("LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH");
  const allowedWallets = configuredCanaryAllowlist();
  const missingInputs = [
    ...(!walletA ? ["CANARY_WALLET_A"] : []),
    ...(!walletB ? ["CANARY_WALLET_B"] : []),
    ...(!expectedEvidenceSigner ? ["EVIDENCE_SIGNER_PRIVATE_KEY"] : []),
    ...(!expectedAccessSigner ? ["ACCESS_SIGNER_PRIVATE_KEY"] : []),
    ...(!expectedEscrowCodeHash ? ["LOCK_IN_ESCROW_CODE_HASH"] : []),
    ...(!expectedOwner ? ["LOCK_IN_OWNER_ADDRESS"] : []),
    ...(!expectedStravaParser ? ["LOCK_IN_STRAVA_PARSER_ADDRESS"] : []),
    ...(!expectedStravaVerifier ? ["LOCK_IN_STRAVA_VERIFIER_ADDRESS"] : []),
    ...(!expectedDuolingoVerifier ? ["LOCK_IN_DUOLINGO_VERIFIER_ADDRESS"] : []),
    ...(!expectedStravaParserCodeHash ? ["LOCK_IN_STRAVA_PARSER_CODE_HASH"] : []),
    ...(!expectedStravaVerifierCodeHash ? ["LOCK_IN_STRAVA_VERIFIER_CODE_HASH"] : []),
    ...(!expectedDuolingoVerifierCodeHash ? ["LOCK_IN_DUOLINGO_VERIFIER_CODE_HASH"] : []),
    ...(!allowedWallets ? ["CANARY_ALLOWED_WALLETS"] : []),
  ];
  const [identity, health, nextPactId, escrowBalance, walletASnapshot, walletBSnapshot] = await Promise.all([
    contractIdentity(),
    productionHealth(),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "nextPactId" }),
    client.readContract({ address: EXPECTED_USDC, abi: erc20Abi, functionName: "balanceOf", args: [escrow] }),
    walletA ? walletSnapshot(walletA) : Promise.resolve(null),
    walletB ? walletSnapshot(walletB) : Promise.resolve(null),
  ]);
  const checks: Record<string, CheckValue> = {
    requiredInputsComplete: missingInputs.length === 0,
    walletsDistinct: walletA && walletB ? walletA !== walletB : false,
    canaryAccessRestricted:
      walletA !== null
      && walletB !== null
      && allowedWallets !== null
      && allowedWallets.length === 2
      && sameAddressSet(allowedWallets, [walletA, walletB]),
    chainId: identity.chainId === CHAIN_ID,
    contractCode: identity.codePresent,
    contractCodeHash: expectedEscrowCodeHash === identity.codeHash,
    contractSchema: identity.schemaId === 1n,
    officialUsdc: identity.stakeToken === EXPECTED_USDC,
    stakeBounds: identity.minStake === CANARY_STAKE && identity.maxStake === 1_000_000n,
    submissionGracePeriod: identity.submissionGracePeriod === 86_400n,
    evidenceSignerMatches: expectedEvidenceSigner ? identity.evidenceSigner === expectedEvidenceSigner : false,
    accessSignerMatches: expectedAccessSigner ? identity.accessSigner === expectedAccessSigner : false,
    signersSeparated: identity.evidenceSigner !== identity.accessSigner,
    directVerifierAddressesDistinct: identity.directVerifiers.strava !== identity.directVerifiers.duolingo,
    directVerifierBindings:
      expectedStravaParser === identity.directVerifiers.stravaParser
      && expectedStravaVerifier === identity.directVerifiers.strava
      && expectedDuolingoVerifier === identity.directVerifiers.duolingo,
    directVerifierCode: identity.directVerifiers.codePresent,
    directVerifierCodeHashes:
      expectedStravaParserCodeHash === identity.directVerifiers.parserCodeHash
      && expectedStravaVerifierCodeHash === identity.directVerifiers.stravaCodeHash
      && expectedDuolingoVerifierCodeHash === identity.directVerifiers.duolingoCodeHash,
    directVerifierLiveSchemas: identity.directVerifiers.liveSchemas,
    directVerifierWitnesses: identity.directVerifiers.witnessesPinned,
    directVerifierProviders: identity.directVerifiers.providersPinned,
    directParser: identity.directVerifiers.parserPinned,
    ownerConfigured: expectedOwner === identity.owner,
    ownerContract: identity.ownerCodePresent,
    ownerSeparated: identity.owner !== identity.evidenceSigner && identity.owner !== identity.accessSigner,
    contractInitiallyPaused: Object.values(identity.pauses).every(Boolean),
    productionHealthReachable: health.reachable,
    productionHealthGreen: health.ok,
    productionPaused: health.mode === "paused"
      && health.actions !== null
      && Object.values(health.actions).every((enabled) => !enabled),
    productionEscrowMatches: health.escrowAddress === escrow,
    productionPausesMatch: health.pauses !== null
      && (Object.keys(identity.pauses) as Array<keyof PauseState>)
        .every((name) => health.pauses?.[name] === identity.pauses[name]),
    walletAHasGas: walletASnapshot?.hasNativeGas ?? false,
    walletBHasGas: walletBSnapshot?.hasNativeGas ?? false,
    walletAHasTwoPactUsdc: walletASnapshot?.hasParallelCanaryUsdc ?? false,
    walletBHasTwoPactUsdc: walletBSnapshot?.hasParallelCanaryUsdc ?? false,
  };
  const ok = allChecksPass(checks);
  print({
    command: "preflight",
    ok,
    missingInputs,
    requirements: {
      canaryStakeAtomicPerParticipation: CANARY_STAKE.toString(),
      canaryStakeUsdcPerParticipation: formatUnits(CANARY_STAKE, 6),
      minimumUsdcAtomicPerWalletForParallelStravaAndDuolingo: REQUIRED_USDC_PER_WALLET.toString(),
      distinctExternalAccountsRequired: { strava: 2, duolingo: 2 },
    },
    contract: {
      address: escrow,
      runtimeCodeHash: identity.codeHash,
      chainId: identity.chainId,
      schemaId: identity.schemaId.toString(),
      stakeToken: identity.stakeToken,
      evidenceSigner: identity.evidenceSigner,
      accessSigner: identity.accessSigner,
      pauses: identity.pauses,
      submissionGracePeriodSeconds: identity.submissionGracePeriod.toString(),
      owner: identity.owner,
      ownerContract: identity.ownerCodePresent,
      nextPactId: nextPactId.toString(),
      escrowUsdcBalanceAtomic: escrowBalance.toString(),
    },
    production: health,
    wallets: { a: walletASnapshot, b: walletBSnapshot },
    checks,
  }, ok);
}

async function participantSnapshot(pactId: bigint, address: Address, blockNumber: bigint): Promise<ParticipantSnapshot> {
  const [joined, bitmap, completed, identityHash, lastMetric, claimed, balance] = await Promise.all([
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "joined", args: [pactId, address], blockNumber }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, address], blockNumber }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "completionCount", args: [pactId, address], blockNumber }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "participantIdentity", args: [pactId, address], blockNumber }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "lastMetric", args: [pactId, address], blockNumber }),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "claimed", args: [pactId, address], blockNumber }),
    client.readContract({ address: EXPECTED_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber }),
  ]);
  return {
    address,
    joined,
    completionBitmap: bitmap.toString(),
    completionCount: Number(completed),
    identityHash,
    lastMetric: lastMetric.toString(),
    claimed,
    usdcBalanceAtomic: balance.toString(),
  };
}

async function snapshot(): Promise<void> {
  const pactId = pactIdArgument();
  const walletA = optionalAddress("CANARY_WALLET_A");
  const walletB = optionalAddress("CANARY_WALLET_B");
  const configuredWallets = [walletA, walletB].filter((value): value is Address => value !== null);
  const block = await client.getBlock({ blockTag: "latest" });
  const [identity, pactValue, contractBalance] = await Promise.all([
    contractIdentity(block.number),
    client.readContract({ address: escrow, abi: releasePactAbi, functionName: "pacts", args: [pactId], blockNumber: block.number }),
    client.readContract({ address: EXPECTED_USDC, abi: erc20Abi, functionName: "balanceOf", args: [escrow], blockNumber: block.number }),
  ]);
  const pact = pactValue as ReleasePactTuple;
  if (pact[0] === zeroAddress) throw new Error("PACT_NOT_FOUND");
  const participants = await Promise.all(configuredWallets.map((address) => participantSnapshot(pactId, address, block.number)));
  const knownJoined = participants.filter((participant) => participant.joined);
  const liability = liabilityFor(pact);
  const checks: Record<string, CheckValue> = {
    chainId: identity.chainId === CHAIN_ID,
    contractCodeHash: optionalConfiguredHash("LOCK_IN_ESCROW_CODE_HASH") === identity.codeHash,
    ownerConfigured: optionalConfiguredAddress("LOCK_IN_OWNER_ADDRESS") === identity.owner,
    ownerContract: identity.ownerCodePresent,
    contractSchema: identity.schemaId === 1n,
    officialUsdc: identity.stakeToken === EXPECTED_USDC,
    canaryStake: pact[2] === CANARY_STAKE,
    participantCapacityValid: pact[10] >= pact[9] && pact[4] <= pact[10],
    creatorIsConfiguredCanary: configuredWallets.length === 2
      ? configuredWallets.some((address) => address.toLowerCase() === pact[0].toLowerCase())
      : null,
    configuredWalletsCoverAllParticipants: configuredWallets.length === 2 ? knownJoined.length === pact[4] : null,
    creatorJoined: configuredWallets.length === 2
      ? knownJoined.some((participant) => participant.address.toLowerCase() === pact[0].toLowerCase())
      : null,
    unfinalizedAccountingFields: pact[15] || (pact[6] === 0 && pact[14] === 0n),
    finalizedAccountingFields: !pact[15] || (pact[6] > 0 || pact[14] === 0n),
  };
  const ok = allChecksPass(checks);
  print({
    command: "snapshot",
    ok,
    pactId: pactId.toString(),
    observedAtBlock: block.number.toString(),
    observedAtTimestamp: block.timestamp.toString(),
    contract: {
      address: escrow,
      runtimeCodeHash: identity.codeHash,
      owner: identity.owner,
      pauses: identity.pauses,
      usdcBalanceAtomic: contractBalance.toString(),
    },
    pact: {
      creator: pact[0],
      state: pactState(pact, block.timestamp, identity.submissionGracePeriod),
      missionType: pact[11],
      startsAt: pact[1].toString(),
      endsAt: (pact[1] + BigInt(pact[7]) * 86_400n).toString(),
      submissionDeadline: (pact[1] + BigInt(pact[7]) * 86_400n + identity.submissionGracePeriod).toString(),
      stakeAtomic: pact[2].toString(),
      dailyTarget: pact[3],
      participantCount: pact[4],
      finisherCount: pact[5],
      claimsRemaining: pact[6],
      durationDays: pact[7],
      requiredCompletions: pact[8],
      minParticipants: pact[9],
      maxParticipants: pact[10],
      completionPauseGenerationAtCreation: pact[12].toString(),
      remainingPoolAtomic: pact[14].toString(),
      liabilityAtomic: liability.toString(),
      finalized: pact[15],
      cancelled: pact[16],
    },
    participants,
    checks,
  }, ok);
}

async function reconcile(): Promise<void> {
  const walletA = optionalAddress("CANARY_WALLET_A");
  const walletB = optionalAddress("CANARY_WALLET_B");
  const configuredWallets = [walletA, walletB].filter((value): value is Address => value !== null);
  const expectedIds = expectedPactIds();
  const block = await client.getBlock({ blockTag: "latest" });
  const [identity, nextPactId, contractBalance] = await Promise.all([
    contractIdentity(block.number),
    client.readContract({ address: escrow, abi: lockInAbi, functionName: "nextPactId", blockNumber: block.number }),
    client.readContract({ address: EXPECTED_USDC, abi: erc20Abi, functionName: "balanceOf", args: [escrow], blockNumber: block.number }),
  ]);
  if (nextPactId > 10_001n) throw new Error("PACT_COUNT_TOO_LARGE");
  const ids = Array.from({ length: Number(nextPactId - 1n) }, (_, index) => BigInt(index + 1));
  const pactValues = await Promise.all(ids.map((pactId) => client.readContract({
    address: escrow,
    abi: releasePactAbi,
    functionName: "pacts",
    args: [pactId],
    blockNumber: block.number,
  }) as Promise<ReleasePactTuple>));
  const knownParticipants = configuredWallets.length === 2
    ? await Promise.all(ids.map(async (pactId) => {
      const results = await Promise.all(configuredWallets.map(async (address) => ({
        address,
        joined: await client.readContract({
          address: escrow,
          abi: lockInAbi,
          functionName: "joined",
          args: [pactId, address],
          blockNumber: block.number,
        }),
      })));
      return results.filter((participant) => participant.joined).map((participant) => participant.address);
    }))
    : ids.map(() => [] as Address[]);

  let totalLiability = 0n;
  const pacts = ids.map((pactId, index) => {
    const pact = pactValues[index];
    const known = knownParticipants[index];
    const liability = liabilityFor(pact);
    totalLiability += liability;
    return {
      pactId: pactId.toString(),
      creator: pact[0],
      state: pactState(pact, block.timestamp, identity.submissionGracePeriod),
      missionType: pact[11],
      stakeAtomic: pact[2].toString(),
      participants: pact[4],
      maxParticipants: pact[10],
      knownCanaryParticipants: known,
      finishers: pact[5],
      claimsRemaining: pact[6],
      completionPauseGenerationAtCreation: pact[12].toString(),
      remainingPoolAtomic: pact[14].toString(),
      liabilityAtomic: liability.toString(),
      finalized: pact[15],
      cancelled: pact[16],
      creatorIsConfiguredCanary: configuredWallets.length === 2
        ? configuredWallets.some((address) => address.toLowerCase() === pact[0].toLowerCase())
        : null,
      configuredWalletsCoverAllParticipants: configuredWallets.length === 2 ? known.length === pact[4] : null,
      capacityValid: pact[10] >= pact[9] && pact[4] <= pact[10],
      accountingFieldsValid: pact[15] ? (pact[6] > 0 || pact[14] === 0n) : (pact[6] === 0 && pact[14] === 0n),
    };
  });
  const unexpectedPactIds = configuredWallets.length === 2
    ? pacts.filter((pact) => !pact.creatorIsConfiguredCanary || !pact.configuredWalletsCoverAllParticipants)
      .map((pact) => pact.pactId)
    : [];
  const checks: Record<string, CheckValue> = {
    chainId: identity.chainId === CHAIN_ID,
    contractCodeHash: optionalConfiguredHash("LOCK_IN_ESCROW_CODE_HASH") === identity.codeHash,
    ownerConfigured: optionalConfiguredAddress("LOCK_IN_OWNER_ADDRESS") === identity.owner,
    ownerContract: identity.ownerCodePresent,
    contractSchema: identity.schemaId === 1n,
    officialUsdc: identity.stakeToken === EXPECTED_USDC,
    pactIdsContiguous: pactValues.every((pact) => pact[0] !== zeroAddress),
    allPactsUseCanaryStake: pacts.every((pact) => pact.stakeAtomic === CANARY_STAKE.toString()),
    capacitiesValid: pacts.every((pact) => pact.capacityValid),
    accountingFieldsValid: pacts.every((pact) => pact.accountingFieldsValid),
    exactEscrowAccounting: contractBalance === totalLiability,
    canaryWalletsDistinct: configuredWallets.length === 2 ? configuredWallets[0] !== configuredWallets[1] : null,
    canaryWalletsOnly: configuredWallets.length === 2 ? unexpectedPactIds.length === 0 : null,
    expectedPactIdsOnly: expectedIds
      ? expectedIds.length === ids.length && expectedIds.every((id, index) => id === ids[index])
      : null,
  };
  const ok = allChecksPass(checks);
  print({
    command: "reconcile",
    ok,
    observedAtBlock: block.number.toString(),
    observedAtTimestamp: block.timestamp.toString(),
    contract: {
      address: escrow,
      runtimeCodeHash: identity.codeHash,
      owner: identity.owner,
      pauses: identity.pauses,
      nextPactId: nextPactId.toString(),
      usdcBalanceAtomic: contractBalance.toString(),
      totalLiabilityAtomic: totalLiability.toString(),
      balanceDeltaAtomic: signedDelta(contractBalance, totalLiability),
    },
    expected: { wallets: configuredWallets, pactIds: expectedIds?.map(String) || null },
    unexpectedPactIds,
    pacts,
    checks,
  }, ok);
}

const command = process.argv[2];
try {
  if (escrow === zeroAddress) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS_MISSING_OR_INVALID");
  if (command === "preflight") await preflight();
  else if (command === "snapshot") await snapshot();
  else if (command === "reconcile") await reconcile();
  else throw new Error("USAGE_PREFLIGHT_SNAPSHOT_RECONCILE");
} catch (error) {
  const safeErrors = new Set([
    "NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS_MISSING_OR_INVALID",
    "CANARY_WALLET_A_INVALID",
    "CANARY_WALLET_B_INVALID",
    "EVIDENCE_SIGNER_PRIVATE_KEY_INVALID",
    "ACCESS_SIGNER_PRIVATE_KEY_INVALID",
    "CANARY_EXPECTED_PACT_IDS_INVALID",
    "CANARY_ALLOWED_WALLETS_INVALID",
    "PACT_ID_MISSING_OR_INVALID",
    "PACT_NOT_FOUND",
    "PACT_COUNT_TOO_LARGE",
    "USAGE_PREFLIGHT_SNAPSHOT_RECONCILE",
  ]);
  const message = error instanceof Error && safeErrors.has(error.message) ? error.message : "CANARY_READ_FAILED";
  print({ command: command || null, ok: false, error: message }, false);
}
