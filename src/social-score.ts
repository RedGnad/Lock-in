import type { Address } from "viem";

export const LOCK_SCORE_PER_VERIFIED_DAY = 10;
export const RUNNING_MISSION_TYPE = 1;
export const LEARNING_MISSION_TYPE = 2;

export type LeaderboardFilter = "overall" | "running" | "learning";
export type ScoreDayEvent = { account: Address | string; utcDay: bigint | number | string };
export type MissionDayScoreEvent = ScoreDayEvent & { missionType: number };
export type PlayerHandleEvent = { account: Address | string; handle: string };
export type PlayerVisibilityEvent = { account: Address | string; hidden: boolean };

export type LeaderboardEntry = {
  account: Address;
  handle: string | null;
  weeklyScore: number;
  weeklyVerifiedDays: number;
  allTimeScore: number;
  allTimeVerifiedDays: number;
  lockScore: number;
};

export type SocialLeaderboardData = {
  week: {
    startUtcDay: number;
    endUtcDayExclusive: number;
    startsAt: string;
    endsAt: string;
  };
  leaderboards: Record<LeaderboardFilter, LeaderboardEntry[]>;
};

type BuildLeaderboardInput = {
  scoreEvents: readonly ScoreDayEvent[];
  missionEvents: readonly MissionDayScoreEvent[];
  handleEvents?: readonly PlayerHandleEvent[];
  visibilityEvents?: readonly PlayerVisibilityEvent[];
  now?: Date | number;
};

const DAY_MS = 86_400_000;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function utcDay(value: bigint | number | string) {
  const day = BigInt(value);
  if (day < 0n || day > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Invalid UTC day");
  return day;
}

function addressKey(account: Address | string) {
  if (!ADDRESS_PATTERN.test(account)) throw new TypeError("Invalid player address");
  return account.toLowerCase();
}

export function utcWeekStartDay(now: Date | number = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid leaderboard date");
  const day = Math.floor(timestamp / DAY_MS);
  const daysSinceMonday = ((day + 3) % 7 + 7) % 7;
  return day - daysSinceMonday;
}

function addDay(map: Map<string, Set<bigint>>, key: string, day: bigint) {
  const days = map.get(key) || new Set<bigint>();
  days.add(day);
  map.set(key, days);
}

function buildEntries(
  daysByAccount: Map<string, Set<bigint>>,
  overallDaysByAccount: Map<string, Set<bigint>>,
  handles: Map<string, string>,
  hiddenProfiles: Set<string>,
  accounts: Map<string, Address>,
  weekStart: bigint,
) {
  const weekEnd = weekStart + 7n;
  const entries: LeaderboardEntry[] = [];

  for (const [key, days] of daysByAccount) {
    const weeklyVerifiedDays = [...days].filter((day) => day >= weekStart && day < weekEnd).length;
    if (weeklyVerifiedDays === 0) continue;
    const overallDays = overallDaysByAccount.get(key)?.size || 0;
    entries.push({
      account: accounts.get(key) as Address,
      handle: hiddenProfiles.has(key) ? null : handles.get(key) || null,
      weeklyScore: weeklyVerifiedDays * LOCK_SCORE_PER_VERIFIED_DAY,
      weeklyVerifiedDays,
      allTimeScore: days.size * LOCK_SCORE_PER_VERIFIED_DAY,
      allTimeVerifiedDays: days.size,
      lockScore: overallDays * LOCK_SCORE_PER_VERIFIED_DAY,
    });
  }

  return entries.sort((left, right) =>
    right.weeklyScore - left.weeklyScore
    || right.allTimeScore - left.allTimeScore
    || right.lockScore - left.lockScore
    || (left.handle || left.account).localeCompare(right.handle || right.account),
  );
}

/**
 * Rebuilds the public rankings from deduplicated onchain day events. Amount
 * staked, distance, XP and the number of Locks completed on one day are absent
 * by design: one wallet can earn at most ten points per UTC day in each table.
 */
export function buildSocialLeaderboards({ scoreEvents, missionEvents, handleEvents = [], visibilityEvents = [], now = Date.now() }: BuildLeaderboardInput): SocialLeaderboardData {
  const overallDays = new Map<string, Set<bigint>>();
  const runningDays = new Map<string, Set<bigint>>();
  const learningDays = new Map<string, Set<bigint>>();
  const handles = new Map<string, string>();
  const hiddenProfiles = new Set<string>();
  const accounts = new Map<string, Address>();

  for (const event of scoreEvents) {
    const key = addressKey(event.account);
    accounts.set(key, event.account as Address);
    addDay(overallDays, key, utcDay(event.utcDay));
  }
  for (const event of missionEvents) {
    const key = addressKey(event.account);
    accounts.set(key, event.account as Address);
    const target = event.missionType === RUNNING_MISSION_TYPE
      ? runningDays
      : event.missionType === LEARNING_MISSION_TYPE
        ? learningDays
        : null;
    if (target) addDay(target, key, utcDay(event.utcDay));
  }
  for (const event of handleEvents) {
    const key = addressKey(event.account);
    accounts.set(key, event.account as Address);
    handles.set(key, event.handle);
  }
  for (const event of visibilityEvents) {
    const key = addressKey(event.account);
    accounts.set(key, event.account as Address);
    if (event.hidden) hiddenProfiles.add(key);
    else hiddenProfiles.delete(key);
  }

  const startUtcDay = utcWeekStartDay(now);
  const endUtcDayExclusive = startUtcDay + 7;
  const weekStart = BigInt(startUtcDay);
  return {
    week: {
      startUtcDay,
      endUtcDayExclusive,
      startsAt: new Date(startUtcDay * DAY_MS).toISOString(),
      endsAt: new Date(endUtcDayExclusive * DAY_MS).toISOString(),
    },
    leaderboards: {
      overall: buildEntries(overallDays, overallDays, handles, hiddenProfiles, accounts, weekStart),
      running: buildEntries(runningDays, overallDays, handles, hiddenProfiles, accounts, weekStart),
      learning: buildEntries(learningDays, overallDays, handles, hiddenProfiles, accounts, weekStart),
    },
  };
}
