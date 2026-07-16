import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readJsonBody } from "@/src/api-guard";
import {
  ACCESS_CREATE,
  ACCESS_JOIN,
  ACCESS_TTL_SECONDS,
  signAccess,
} from "@/src/access-attestation";
import { escrowAddress, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import { hashPactConfiguration, type PactConfiguration } from "@/src/pact-configuration";
import { isProofActionEnabled, readProductFlagState } from "@/src/product-flags";
import { checkRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AccessBody = {
  walletAddress?: string;
  action?: "create" | "join";
  pactId?: string;
  configuration?: {
    stake?: string;
    dailyTarget?: number;
    durationDays?: number;
    requiredCompletions?: number;
    minParticipants?: number;
    maxParticipants?: number;
    startsAt?: string;
    missionType?: number;
  };
};

const RELEASE_TEMPLATES = new Map([[3, 3], [7, 5], [14, 10], [30, 20]]);
const RELEASE_STAKES = new Set([100_000n, 500_000n, 1_000_000n]);
const RELEASE_CAPACITIES = new Set([2, 4, 8]);
const STRAVA_TARGETS = new Set([1_000, 3_000, 5_000, 10_000]);

function exactInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  return Number(value);
}

function atomicValue(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new Error(`Invalid ${label}`);
  return BigInt(value);
}

function releaseConfiguration(body: AccessBody["configuration"], chainNow: bigint): PactConfiguration {
  if (!body) throw new Error("Lock configuration is required");
  const configuration: PactConfiguration = {
    stake: atomicValue(body.stake, "stake"),
    dailyTarget: exactInteger(body.dailyTarget, "daily target"),
    durationDays: exactInteger(body.durationDays, "duration"),
    requiredCompletions: exactInteger(body.requiredCompletions, "completion target"),
    minParticipants: exactInteger(body.minParticipants, "minimum crew"),
    maxParticipants: exactInteger(body.maxParticipants, "maximum crew"),
    startsAt: atomicValue(body.startsAt, "start time"),
    missionType: exactInteger(body.missionType, "mission"),
  };
  if (!RELEASE_STAKES.has(configuration.stake)) throw new Error("Choose 0.1, 0.5, or 1 USDC");
  if (RELEASE_TEMPLATES.get(configuration.durationDays) !== configuration.requiredCompletions) {
    throw new Error("Choose a supported challenge schedule");
  }
  if (configuration.minParticipants !== 2 || !RELEASE_CAPACITIES.has(configuration.maxParticipants)) {
    throw new Error("Choose a crew of 2, 4, or 8 players");
  }
  if (
    configuration.startsAt < chainNow + 60n * 60n
      || configuration.startsAt > chainNow + 3n * 60n * 60n
  ) throw new Error("The registration window must last between one and three hours");
  if (
    configuration.missionType !== 1 || !STRAVA_TARGETS.has(configuration.dailyTarget)
  ) throw new Error("Choose a supported mission target");
  return configuration;
}

function accessSignerKey(): Hex {
  const value = process.env.ACCESS_SIGNER_PRIVATE_KEY?.trim();
  if (!value || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("Access signing is unavailable");
  return value as Hex;
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit("access", request);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many access requests. Try again later." }, {
      status: 429,
      headers: rateLimitResponseHeaders(rateLimit),
    });
  }
  try {
    const body = await readJsonBody<AccessBody>(request, 16 * 1_024);
    if (!body.walletAddress || !isAddress(body.walletAddress)) throw new Error("Connect a valid wallet first");
    const walletAddress = getAddress(body.walletAddress);
    requireWalletAuthSession(request, walletAddress);
    const action = body.action === "create" ? ACCESS_CREATE : body.action === "join" ? ACCESS_JOIN : 0;
    if (action === 0) throw new Error("Invalid access action");
    const pactId = body.action === "create"
      ? 0n
      : body.pactId && /^\d+$/.test(body.pactId) && BigInt(body.pactId) > 0n
        ? BigInt(body.pactId)
        : 0n;
    if (body.action === "join" && pactId === 0n) throw new Error("Invalid Lock ID");
    const flags = readProductFlagState();
    const enabled = isProofActionEnabled(flags, {
      phase: "baseline",
      intent: body.action,
    });
    if (!enabled) {
      return NextResponse.json({ error: "This action is paused. Settlement and claims remain available." }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!escrowAddress) throw new Error("Escrow is unavailable");
    const privateKey = accessSignerKey();
    const client = lockInPublicClient();
    const block = await client.getBlock({ blockTag: "latest" });
    const configuredSigner = await client.readContract({
      address: escrowAddress,
      abi: lockInAbi,
      functionName: "accessSigner",
      blockNumber: block.number,
    });
    if (privateKeyToAccount(privateKey).address !== getAddress(configuredSigner)) {
      throw new Error("Access signer does not match the escrow contract");
    }
    let configHash;
    if (action === ACCESS_JOIN) {
      const [pact, joined, storedConfigHash] = await Promise.all([
        client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [pactId], blockNumber: block.number }),
        client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "joined", args: [pactId, walletAddress], blockNumber: block.number }),
        client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pactConfigHash", args: [pactId], blockNumber: block.number }),
      ]);
      if (pact[0] === "0x0000000000000000000000000000000000000000") throw new Error("Lock does not exist");
      if (pact[15] || pact[16] || block.timestamp >= pact[1]) throw new Error("Registration is closed");
      if (joined) throw new Error("This wallet already joined");
      if (pact[4] >= pact[10]) throw new Error("This Lock is full");
      configHash = storedConfigHash;
    } else {
      const configuration = releaseConfiguration(body.configuration, block.timestamp);
      const localConfigHash = hashPactConfiguration(configuration);
      const contractConfigHash = await client.readContract({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "hashPactConfiguration",
        args: [
          configuration.stake,
          configuration.dailyTarget,
          configuration.durationDays,
          configuration.requiredCompletions,
          configuration.minParticipants,
          configuration.maxParticipants,
          configuration.startsAt,
          configuration.missionType,
        ],
        blockNumber: block.number,
      });
      if (contractConfigHash !== localConfigHash) throw new Error("Lock configuration hash mismatch");
      configHash = contractConfigHash;
    }
    const access = {
      account: walletAddress,
      action,
      pactId,
      configHash,
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      issuedAt: block.timestamp,
      expiresAt: block.timestamp + BigInt(ACCESS_TTL_SECONDS),
    };
    const signature = await signAccess({
      privateKey,
      chainId: 143,
      verifyingContract: escrowAddress,
      access,
    });
    return NextResponse.json({
      action: body.action,
      pactId: pactId.toString(),
      evidence: {
        configHash: access.configHash,
        nonce: access.nonce,
        issuedAt: access.issuedAt.toString(),
        expiresAt: access.expiresAt.toString(),
        signature,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : error instanceof Error && error.message.length <= 160
          ? error.message
          : "Could not authorize this Lock action",
    }, {
      status: authStatus || 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
