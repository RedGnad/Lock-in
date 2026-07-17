import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import type { Hex } from "viem";
import { readJsonBody } from "@/src/api-guard";
import { DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION } from "@/src/duolingo-proof-policy";
import { resolvePublicDuolingoProfile } from "@/src/duolingo-profile";
import { hashDuolingoConfiguration } from "@/src/duolingo-attestation";
import {
  escrowContextMessage,
  escrowVerifyingContract,
  type EscrowIntent,
} from "@/src/duolingo-escrow-attestation";
import { EscrowConfigError, parseEscrowCreateTerms } from "@/src/duolingo-escrow-config";
import { assertEscrowWalletAllowed, EscrowAccessError } from "@/src/duolingo-escrow-access";
import {
  assertEscrowFinalOpen,
  EscrowChainUnavailableError,
  readEscrowPact,
} from "@/src/duolingo-escrow-chain";
import { loadEscrowBaseline, pruneExpiredEscrowSessions, saveEscrowSession } from "@/src/duolingo-escrow-store";
import { checkRateLimit, rateLimitResponseHeaders } from "@/src/rate-limit";
import {
  requireWalletAuthSession,
  walletAuthErrorStatus,
  walletAuthPublicMessage,
} from "@/src/wallet-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PACT_ID = /^[1-9]\d{0,29}$/;

function parsePactId(value: unknown): bigint {
  const raw = String(value ?? "").trim();
  if (!PACT_ID.test(raw)) throw new Error("Choose a valid Lock");
  return BigInt(raw);
}

/**
 * Opens a Reclaim session for one phase of the FINANCIAL Duolingo escrow (real USDC).
 *
 * The wallet comes from the signed session cookie, never the body. The signed Reclaim context is scoped to
 * the exact action: a create baseline is bound to a fresh server createNonce (no pactId exists yet), while
 * a join baseline and a final are bound to the on-chain pactId. The profile id is resolved from Duolingo's
 * public API, so the proof is bound to the account we asked about rather than whichever one is signed in.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const authed = requireWalletAuthSession(request, String(body.walletAddress || ""));
    const wallet = authed.walletAddress;
    assertEscrowWalletAllowed(wallet);
    // Refuse before spending a proof if the escrow is not deployed and pinned yet, without leaking which
    // variable is missing.
    try {
      escrowVerifyingContract();
    } catch {
      throw new EscrowChainUnavailableError("The Duolingo escrow is not available yet");
    }
    const rate = checkRateLimit("session", request, wallet);
    if (!rate.allowed) {
      return NextResponse.json({ error: "Too many attempts. Try again shortly." }, {
        status: 429,
        headers: rateLimitResponseHeaders(rate),
      });
    }
    void pruneExpiredEscrowSessions().catch(() => {});

    const intent: EscrowIntent =
      body.intent === "create" || body.intent === "join" || body.intent === "final" ? body.intent : "create";
    const username = String(body.username || "").trim();
    if (!username) throw new Error("Enter your Duolingo username");
    const profile = await resolvePublicDuolingoProfile(username);

    let phase: "baseline" | "final" = "baseline";
    let pactId: bigint | null = null;
    let createNonce: Hex | null = null;
    let configHash: Hex;
    let targetXp: number;
    let contextMessage: string;

    if (intent === "create") {
      const terms = parseEscrowCreateTerms(body);
      createNonce = `0x${randomBytes(32).toString("hex")}` as Hex;
      configHash = hashDuolingoConfiguration({ ...terms, createNonce });
      targetXp = terms.targetXp;
      contextMessage = escrowContextMessage({ intent: "create", createNonce });
    } else if (intent === "join") {
      pactId = parsePactId(body.pactId);
      const pact = await readEscrowPact(pactId, wallet);
      if (!pact) throw new Error("That Lock does not exist");
      if (pact.cancelled || pact.finalized) throw new Error("That Lock is closed");
      if (pact.joined) throw new Error("You have already joined this Lock");
      if (pact.startsAt <= Math.floor(Date.now() / 1_000)) throw new Error("This Lock has already started");
      if (pact.participantCount >= pact.maxParticipants) throw new Error("This Lock is full");
      configHash = pact.configHash;
      targetXp = pact.targetXp;
      contextMessage = escrowContextMessage({ intent: "join", pactId });
    } else {
      pactId = parsePactId(body.pactId);
      const pact = await readEscrowPact(pactId, wallet);
      if (!pact) throw new Error("That Lock does not exist");
      // Refuse before spending a proof if the Lock cannot take a fresh final right now.
      assertEscrowFinalOpen(pact, "capture");
      // The baseline must already exist for this exact Lock, keyed by its on-chain configHash.
      const baseline = await loadEscrowBaseline(wallet, pact.configHash);
      if (!baseline) throw new Error("Verify your starting XP before your final XP");
      if (baseline.duolingoProfileId !== profile.id) {
        throw new Error("This is a different Duolingo account than the one you started with");
      }
      configHash = pact.configHash;
      targetXp = pact.targetXp;
      contextMessage = escrowContextMessage({ intent: "final", pactId });
      phase = "final";
    }

    const appId = process.env.ID?.trim();
    const appSecret = process.env.SECRET?.trim();
    if (!appId || !appSecret) throw new Error("The Reclaim application is not configured");

    const proofRequest = await ReclaimProofRequest.init(appId, appSecret, DUOLINGO_PROVIDER_ID, {
      providerVersion: DUOLINGO_PROVIDER_VERSION,
      acceptAiProviders: false,
    });
    proofRequest.setParams({ duolingo_user_id: profile.id });
    proofRequest.addContext(wallet.toLowerCase(), contextMessage);

    const sessionId = proofRequest.getStatusUrl().split("/").pop() || "";
    const requestUrl = await proofRequest.getRequestUrl();

    await saveEscrowSession({
      sessionId,
      walletAddress: wallet,
      intent,
      phase,
      pactId: pactId === null ? null : pactId.toString(),
      createNonce,
      configHash,
      targetXp,
      duolingoProfileId: profile.id,
      contextMessage,
    });

    // The response carries the createNonce (the client needs it for createPact) and the configHash, but
    // never the raw Duolingo profile id: the on-chain identity is the HMAC pseudonym, minted at verify.
    return NextResponse.json({
      sessionId,
      intent,
      phase,
      requestUrl,
      createNonce,
      configHash,
      targetXp,
      pactId: pactId === null ? null : pactId.toString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EscrowAccessError || error instanceof EscrowChainUnavailableError) {
      const status = error instanceof EscrowAccessError ? error.status : 503;
      return NextResponse.json({ error: error.message }, { status, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof EscrowConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const authStatus = walletAuthErrorStatus(error);
    return NextResponse.json({
      error: authStatus
        ? walletAuthPublicMessage(error)
        : error instanceof Error ? error.message : "Could not start the Duolingo proof",
    }, { status: authStatus || 400, headers: { "Cache-Control": "no-store" } });
  }
}
