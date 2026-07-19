import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  recoverTypedDataAddress,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCESS_CREATE,
  accessDomain,
  accessTypes,
} from "../src/access-attestation.js";
import { lockInAbi } from "../src/lock-in-abi.js";
import { PACT_TEMPLATES, RELEASE_TEMPLATES } from "../src/missions.js";
import { hashPactConfiguration } from "../src/pact-configuration.js";
import {
  createWalletAuthChallenge,
  issueWalletAuthSession,
  WALLET_AUTH_COOKIE_NAME,
} from "../src/wallet-auth-server.js";

const CHAIN_NOW = 1_800_000_000n;
const ESCROW = getAddress("0x1111111111111111111111111111111111111111");
const ACCESS_SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCESS_SIGNER = privateKeyToAccount(ACCESS_SIGNER_KEY);
const WALLET = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const HASH = `0x${"11".repeat(32)}` as Hex;
const LOGS_BLOOM = `0x${"00".repeat(256)}`;

function configuration(durationDays: number, requiredCompletions: number) {
  return {
    stake: "100000",
    dailyTarget: 3_000,
    durationDays,
    requiredCompletions,
    minParticipants: 2,
    maxParticipants: 4,
    startsAt: (CHAIN_NOW + 2n * 60n * 60n).toString(),
    missionType: 1,
  };
}

function rpcResult(method: string, params: unknown[]): unknown {
  if (method === "eth_getBlockByNumber") {
    return {
      baseFeePerGas: "0x1",
      difficulty: "0x0",
      extraData: "0x",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      hash: HASH,
      logsBloom: LOGS_BLOOM,
      miner: zeroAddress,
      mixHash: HASH,
      nonce: "0x0000000000000000",
      number: "0x1",
      parentHash: HASH,
      receiptsRoot: HASH,
      sha3Uncles: HASH,
      size: "0x1",
      stateRoot: HASH,
      timestamp: toHex(CHAIN_NOW),
      totalDifficulty: "0x0",
      transactions: [],
      transactionsRoot: HASH,
      uncles: [],
    };
  }
  if (method === "eth_call") {
    const call = params[0] as { data: Hex };
    const decoded = decodeFunctionData({ abi: lockInAbi, data: call.data });
    if (decoded.functionName === "accessSigner") {
      return encodeFunctionResult({
        abi: lockInAbi,
        functionName: "accessSigner",
        result: ACCESS_SIGNER.address,
      });
    }
    if (decoded.functionName === "hashPactConfiguration") {
      const [stake, dailyTarget, durationDays, requiredCompletions, minParticipants, maxParticipants, startsAt, missionType]
        = decoded.args;
      const configHash = hashPactConfiguration({
        stake,
        dailyTarget,
        durationDays,
        requiredCompletions,
        minParticipants,
        maxParticipants,
        startsAt,
        missionType,
      });
      return encodeFunctionResult({
        abi: lockInAbi,
        functionName: "hashPactConfiguration",
        result: configHash,
      });
    }
  }
  throw new Error(`Unexpected RPC method: ${method}`);
}

const rpcServer = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    id: number;
    method: string;
    params: unknown[];
  };
  try {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: rpcResult(payload.method, payload.params) }));
  } catch (error) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      error: { code: -32603, message: error instanceof Error ? error.message : "RPC test error" },
    }));
  }
});

await new Promise<void>((resolve, reject) => {
  rpcServer.once("error", reject);
  rpcServer.listen(0, "127.0.0.1", resolve);
});
const rpcAddress = rpcServer.address();
if (!rpcAddress || typeof rpcAddress === "string") throw new Error("Could not start the access API test RPC");
const ORIGIN = `http://127.0.0.1:${rpcAddress.port}`;

process.env.ACCESS_SIGNER_PRIVATE_KEY = ACCESS_SIGNER_KEY;
process.env.CANARY_ALLOWED_WALLETS = WALLET.address;
process.env.MONAD_RPC_URL = ORIGIN;
process.env.NEW_PACTS_ENABLED = "true";
process.env.NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS = ESCROW;
process.env.NEXT_PUBLIC_MONAD_RPC_URL = ORIGIN;
process.env.SESSION_SIGNING_SECRET = "test-wallet-session-secret-that-is-longer-than-32-bytes";

const { POST } = await import("../app/api/access/route.js");
const challenge = createWalletAuthChallenge({ walletAddress: WALLET.address, origin: ORIGIN });
const walletSignature = await WALLET.signMessage({ message: challenge.message });
const session = await issueWalletAuthSession({
  challenge: challenge.challenge,
  signature: walletSignature,
  origin: ORIGIN,
});
const cookie = `${WALLET_AUTH_COOKIE_NAME}=${session.token}`;

after(() => new Promise<void>((resolve, reject) => {
  rpcServer.close((error) => error ? reject(error) : resolve());
}));

function accessRequest(durationDays: number, requiredCompletions: number, ip: string): Request {
  return new Request(`${ORIGIN}/api/access`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: ORIGIN,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({
      walletAddress: WALLET.address,
      action: "create",
      configuration: configuration(durationDays, requiredCompletions),
    }),
  });
}

test("the access API schedule map is derived from the four product templates", () => {
  assert.deepEqual(
    [...RELEASE_TEMPLATES],
    [
      [3, 2],
      [7, 4],
      [15, 8],
      [30, 15],
    ],
  );
});

for (const [index, template] of PACT_TEMPLATES.entries()) {
  test(`POST /api/access accepts ${template.durationDays} days / ${template.requiredCompletions} runs`, async () => {
    const response = await POST(accessRequest(
      template.durationDays,
      template.requiredCompletions,
      `192.0.2.${index + 1}`,
    ));
    assert.equal(response.status, 200);
    const json = await response.json() as {
      action: string;
      pactId: string;
      evidence: {
        configHash: Hex;
        nonce: Hex;
        issuedAt: string;
        expiresAt: string;
        signature: Hex;
      };
    };
    assert.equal(json.action, "create");
    assert.equal(json.pactId, "0");
    assert.equal(await recoverTypedDataAddress({
      domain: accessDomain(143, ESCROW),
      types: accessTypes,
      primaryType: "Access",
      message: {
        account: WALLET.address,
        action: ACCESS_CREATE,
        pactId: 0n,
        configHash: json.evidence.configHash,
        nonce: json.evidence.nonce,
        issuedAt: BigInt(json.evidence.issuedAt),
        expiresAt: BigInt(json.evidence.expiresAt),
      },
      signature: json.evidence.signature,
    }), ACCESS_SIGNER.address);
  });
}

for (const [index, [durationDays, requiredCompletions]] of [
  [3, 3],
  [7, 5],
  [14, 10],
  [15, 10],
  [30, 20],
].entries()) {
  test(`POST /api/access rejects ${durationDays} days / ${requiredCompletions} runs`, async () => {
    const response = await POST(accessRequest(durationDays, requiredCompletions, `198.51.100.${index + 1}`));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Choose a supported challenge schedule" });
  });
}
