import { DUOLINGO_XP_MISSION, STRAVA_RUN_MISSION } from "./lock-in-abi";

export type MissionId = "strava" | "duolingo";

export type Mission = {
  id: MissionId;
  type: typeof STRAVA_RUN_MISSION | typeof DUOLINGO_XP_MISSION;
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
  {
    id: "duolingo",
    type: DUOLINGO_XP_MISSION,
    name: "Duolingo XP",
    verb: "learning days",
    unit: "XP",
    targets: [
      { value: 10, label: "10 XP" },
      { value: 20, label: "20 XP" },
      { value: 30, label: "30 XP" },
      { value: 50, label: "50 XP" },
    ],
    defaultTarget: 20,
    description: "New XP earned after joining, from your linked profile.",
  },
] as const;

export type PactTemplate = {
  id: string;
  name: string;
  durationDays: 3 | 7 | 14 | 30;
  requiredCompletions: number;
  description: string;
};

export const PACT_TEMPLATES: readonly PactTemplate[] = [
  { id: "quickfire", name: "Quickfire", durationDays: 3, requiredCompletions: 3, description: "Three days. No misses." },
  { id: "momentum", name: "Momentum", durationDays: 7, requiredCompletions: 5, description: "Five wins in seven days." },
  { id: "discipline", name: "Discipline", durationDays: 14, requiredCompletions: 10, description: "Ten wins across two weeks." },
  { id: "long-game", name: "Long Game", durationDays: 30, requiredCompletions: 20, description: "Twenty wins across a month." },
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
