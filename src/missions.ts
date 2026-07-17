import { STRAVA_RUN_MISSION } from "./lock-in-abi";

export type MissionId = "strava";

export type Mission = {
  id: MissionId;
  type: typeof STRAVA_RUN_MISSION;
  name: string;
  verb: string;
  unit: string;
  targets: readonly { value: number; label: string }[];
  defaultTarget: number;
  description: string;
};

export const MISSIONS: readonly Mission[] = [
  {
    id: "strava",
    type: STRAVA_RUN_MISSION,
    name: "Strava run",
    verb: "runs",
    unit: "km",
    targets: [
      { value: 1_000, label: "1 km" },
      { value: 3_000, label: "3 km" },
      { value: 5_000, label: "5 km" },
      { value: 10_000, label: "10 km" },
    ],
    defaultTarget: 3_000,
    description: "A GPS run recorded by Strava.",
  },
] as const;

export type PactTemplate = {
  id: string;
  name: string;
  durationDays: 3 | 7 | 15 | 30;
  requiredCompletions: number;
  description: string;
};

/**
 * Every template leaves room to miss a day.
 *
 * The escrow only requires 3 <= durationDays <= 30 and 1 <= requiredCompletions <= durationDays, so these
 * are a product choice, not a constraint. Demanding a perfect streak punished one bad day as harshly as
 * quitting, which is the opposite of what an accountability product should do. The trade is deliberate:
 * an easier target means everyone finishing more often, and a Lock where everyone finishes just returns
 * each stake.
 */
export const PACT_TEMPLATES: readonly PactTemplate[] = [
  { id: "quickfire", name: "Quickfire", durationDays: 3, requiredCompletions: 2, description: "Two wins in three days." },
  { id: "momentum", name: "Momentum", durationDays: 7, requiredCompletions: 4, description: "Four wins in a week." },
  { id: "discipline", name: "Discipline", durationDays: 15, requiredCompletions: 8, description: "Eight wins in a fortnight." },
  { id: "long-game", name: "Long Game", durationDays: 30, requiredCompletions: 15, description: "Fifteen wins in a month." },
] as const;

export function pactTemplate(durationDays: number): PactTemplate {
  const template = PACT_TEMPLATES.find((item) => item.durationDays === durationDays);
  if (!template) throw new Error("Unsupported pact template");
  return template;
}

export function missionByType(type: number): Mission {
  const mission = MISSIONS.find((item) => item.type === type);
  if (!mission) throw new Error("Unsupported mission");
  return mission;
}

export function formatMissionTarget(type: number, target: number): string {
  return type === STRAVA_RUN_MISSION ? `${target / 1_000} km` : `${target} XP`;
}
