import { readFile } from "node:fs/promises";

const MONAD_MAX_RUNTIME_BYTES = 128 * 1024;

const productionArtifacts = [
  ["LockInEscrow", "out/LockInEscrow.sol/LockInEscrow.json"],
  ["LockInStravaClaimParser", "out/LockInStravaReclaimVerifier.sol/LockInStravaClaimParser.json"],
  ["LockInStravaReclaimVerifier", "out/LockInStravaReclaimVerifier.sol/LockInStravaReclaimVerifier.json"],
  ["LockInReclaimVerifier", "out/LockInReclaimVerifier.sol/LockInReclaimVerifier.json"],
] as const;

function byteLength(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${label} is not valid hex bytecode; run forge build first`);
  }
  return (value.length - 2) / 2;
}

const results = await Promise.all(productionArtifacts.map(async ([contract, path]) => {
  const artifact = JSON.parse(await readFile(path, "utf8")) as {
    bytecode?: { object?: unknown };
    deployedBytecode?: { object?: unknown };
  };
  const initcodeBytes = byteLength(artifact.bytecode?.object, `${contract} initcode`);
  const runtimeBytes = byteLength(artifact.deployedBytecode?.object, `${contract} runtime`);
  if (runtimeBytes === 0) throw new Error(`${contract} has empty runtime bytecode`);
  if (runtimeBytes > MONAD_MAX_RUNTIME_BYTES) {
    throw new Error(`${contract} runtime is ${runtimeBytes} bytes, above Monad's ${MONAD_MAX_RUNTIME_BYTES}-byte limit`);
  }
  return {
    contract,
    runtimeBytes,
    initcodeBytes,
    runtimeMarginBytes: MONAD_MAX_RUNTIME_BYTES - runtimeBytes,
  };
}));

console.log(JSON.stringify({
  network: "Monad",
  maxRuntimeBytes: MONAD_MAX_RUNTIME_BYTES,
  contracts: results,
}, null, 2));
