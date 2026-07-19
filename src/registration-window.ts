export const REGISTRATION_WINDOW_SECONDS = 2 * 60 * 60 + 30 * 60;

function scheduledStart(chainTimestamp: bigint, roundingSeconds: bigint): bigint {
  const earliest = chainTimestamp + BigInt(REGISTRATION_WINDOW_SECONDS);
  return ((earliest + roundingSeconds - 1n) / roundingSeconds) * roundingSeconds;
}

export function scheduledStravaStart(chainTimestamp: bigint): bigint {
  return scheduledStart(chainTimestamp, 15n * 60n);
}

export function scheduledDuolingoStart(chainTimestamp: bigint): bigint {
  return scheduledStart(chainTimestamp, 5n * 60n);
}
