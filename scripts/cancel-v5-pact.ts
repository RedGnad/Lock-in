import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lockInAbi, type PactTuple } from "../src/lock-in-abi.js";
import { addMonadGasBuffer } from "../src/monad-gas.js";

function ownerPrivateKey(): Hex {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
  const value = raw?.startsWith("0x") ? raw : raw ? `0x${raw}` : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Missing valid local V5 owner key");
  return value as Hex;
}

const rawPactId = process.env.PACT_ID?.trim() || "";
if (!/^[1-9][0-9]*$/.test(rawPactId)) throw new Error("Set PACT_ID to the affected positive pact ID");
const pactId = BigInt(rawPactId);
const requiredConfirmation = `CANCEL_V5_PACT_${pactId}`;
const confirmed = process.env.CONFIRM_CANCEL_PACT?.trim() === requiredConfirmation;
const rawEscrow = process.env.NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS?.trim() || "";
if (!isAddress(rawEscrow)) throw new Error("Missing V5 escrow address");
const escrow = getAddress(rawEscrow);
const rpcUrl = process.env.MONAD_RPC_URL?.trim() || "https://rpc.monad.xyz";
const chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(ownerPrivateKey());
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const ownerAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;

const [chainId, version, owner, pact, creationPaused, joiningPaused, evidencePaused] = await Promise.all([
  publicClient.getChainId(),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "VERSION" }),
  publicClient.readContract({ address: escrow, abi: ownerAbi, functionName: "owner" }),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "pacts", args: [pactId] }) as Promise<PactTuple>,
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "creationPaused" }),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "joiningPaused" }),
  publicClient.readContract({ address: escrow, abi: lockInAbi, functionName: "evidencePaused" }),
]);
if (chainId !== 143 || version !== 5n) throw new Error("Refusing to operate a non-V5 Monad contract");
if (getAddress(owner) !== account.address) throw new Error("Local key is not the V5 owner");
if (pact[0] === zeroAddress) throw new Error(`Pact ${pactId} does not exist`);
if (pact[13]) throw new Error(`Pact ${pactId} is already finalized; no owner action is available`);

const snapshot = {
  chainId,
  escrow,
  pactId: pactId.toString(),
  owner,
  creator: pact[0],
  startsAt: pact[1].toString(),
  stakeAtomicUnits: pact[2].toString(),
  dailyTarget: pact[3],
  participants: pact[4],
  missionType: pact[10],
  remainingPoolAtomicUnits: pact[12].toString(),
  cancelled: pact[14],
  finalized: pact[13],
  pauses: { creation: creationPaused, joining: joiningPaused, evidence: evidencePaused },
};

async function execute(functionName: "cancelPactByOwner" | "finalizePact") {
  const request = { address: escrow, abi: lockInAbi, functionName, args: [pactId], account } as const;
  await publicClient.simulateContract(request);
  const gas = addMonadGasBuffer(await publicClient.estimateContractGas(request));
  const [balance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getGasPrice(),
  ]);
  if (balance < gas * gasPrice) throw new Error(`Owner lacks MON for ${functionName}`);
  const hash = await walletClient.writeContract({ ...request, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

if (!confirmed) {
  const functionName = pact[14] ? "finalizePact" : "cancelPactByOwner";
  await publicClient.simulateContract({ address: escrow, abi: lockInAbi, functionName, args: [pactId], account });
  console.log(JSON.stringify({
    dryRun: true,
    snapshot,
    nextStep: `Re-run with CONFIRM_CANCEL_PACT=${requiredConfirmation} to cancel into the refund path and finalize it.`,
  }, null, 2));
} else {
  const cancelTx = pact[14] ? null : await execute("cancelPactByOwner");
  const finalizeTx = await execute("finalizePact");
  console.log(JSON.stringify({
    dryRun: false,
    snapshot,
    result: { cancelled: true, finalized: true, refundClaimsEnabled: true, cancelTx, finalizeTx },
  }, null, 2));
}
