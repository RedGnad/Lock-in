export function addMonadGasBuffer(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error("Gas estimate must be positive");
  // Monad charges the submitted gas limit, so keep the safety margin tight.
  return estimate + (estimate * 5n + 99n) / 100n;
}
