import "dotenv/config";
import { resolve } from "node:path";
import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import { getAddress, isAddress } from "viem";
import { pruneSessionStore, savePendingSession } from "../src/proof-session-store.js";
import {
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
} from "../src/strava-proof-policy.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function parseDate(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an ISO-8601 date`);
  return value;
}

const rawAddress = required("WALLET_ADDRESS");
if (!isAddress(rawAddress)) throw new Error("WALLET_ADDRESS is invalid");

const pactId = process.env.PACT_ID?.trim() || "0";
if (!/^\d+$/.test(pactId)) throw new Error("PACT_ID must be an unsigned integer");
const dayIndex = Number(process.env.DAY_INDEX?.trim() || "0");
if (!Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex > 29) {
  throw new Error("DAY_INDEX must be an integer between 0 and 29");
}

const providerId = process.env.PROVIDER_ID?.trim() || STRAVA_PROVIDER_ID;
const providerVersion = process.env.PROVIDER_VERSION?.trim() || STRAVA_PROVIDER_VERSION;
if (providerId !== STRAVA_PROVIDER_ID || providerVersion !== STRAVA_PROVIDER_VERSION) {
  throw new Error(`Lock In requires Strava provider ${STRAVA_PROVIDER_ID} exactly at ${STRAVA_PROVIDER_VERSION}`);
}


const now = Date.now();
const pactStartsAtMs = parseDate("PACT_STARTS_AT", now);
const startsAtMs = pactStartsAtMs + dayIndex * 24 * 60 * 60 * 1_000;
const endsAtMs = startsAtMs + 24 * 60 * 60 * 1_000;

const minDistanceMeters = Number(process.env.MIN_DISTANCE_METERS?.trim() || "1000");
if (!Number.isSafeInteger(minDistanceMeters) || minDistanceMeters <= 0) {
  throw new Error("MIN_DISTANCE_METERS must be a positive integer");
}

const walletAddress = getAddress(rawAddress).toLowerCase();
const request = await ReclaimProofRequest.init(
  required("ID"),
  required("SECRET"),
  providerId,
  {
    providerVersion,
    acceptTeeAttestation: true,
    canAutoSubmit: true,
    preferredLocale: "en",
  },
);

request.setContext(walletAddress, `${pactId}:${dayIndex}`);
// 7.0.0 takes no parameter: it reads the athlete's most recent run.

const sessionId = request.getSessionId();
const sessionsRoot = resolve("sessions");
await pruneSessionStore(sessionsRoot);
await savePendingSession(sessionsRoot, {
  sessionId,
  providerId,
  providerVersion,
  walletAddress,
  pactId,
  dayIndex,
  startsAtMs,
  endsAtMs,
  minDistanceMeters,
  createdAt: new Date().toISOString(),
});

const requestUrl = await request.getRequestUrl();
let openedInCdp = false;
if (process.argv.includes("--open-cdp")) {
  const response = await fetch(
    `http://127.0.0.1:9222/json/new?${encodeURIComponent(requestUrl)}`,
    { method: "PUT" },
  );
  if (!response.ok) {
    throw new Error(`Could not open Reclaim request in Chrome CDP: ${response.status}`);
  }
  openedInCdp = true;
}

console.log(JSON.stringify({
  requestUrl,
  statusUrl: request.getStatusUrl(),
  sessionId,
  provider: request.getProviderVersion(),
  contextAddress: walletAddress,
  pactId,
  dayIndex,
  activityInstruction: "Record a GPS run inside the window. No title constraint: the most recent run is read.",
  pactStartsAt: new Date(startsAtMs).toISOString(),
  pactEndsAt: new Date(endsAtMs).toISOString(),
  minDistanceMeters,
  openedInCdp,
}, null, 2));
