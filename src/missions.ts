export type MissionStatus = "live" | "next" | "blocked";

export type PactTemplate = {
  id: string;
  name: string;
  durationDays: 1 | 3 | 7 | 14 | 30;
  requiredCompletions: number;
  description: string;
  publicCompetition: boolean;
};

export type MissionDefinition = {
  id: "strava-run" | "steps" | "duolingo-learn";
  arena: "MOVE" | "LEARN";
  name: string;
  status: MissionStatus;
  moneyEnabled: boolean;
  source: string;
  promise: string;
  detail: string;
};

export const STRAVA_TEMPLATES: readonly PactTemplate[] = [
  {
    id: "proof-sprint",
    name: "Proof Sprint",
    durationDays: 1,
    requiredCompletions: 1,
    description: "Practice or invite rehearsal with no protocol rewards. A solo stake is refundable; network gas is not.",
    publicCompetition: false,
  },
  {
    id: "kickstart",
    name: "Kickstart",
    durationDays: 3,
    requiredCompletions: 3,
    description: "Three runs in three days. The shortest serious commitment.",
    publicCompetition: true,
  },
  {
    id: "momentum",
    name: "Momentum",
    durationDays: 7,
    requiredCompletions: 5,
    description: "Five runs in seven days, with two recovery days.",
    publicCompetition: true,
  },
  {
    id: "consistency",
    name: "Consistency",
    durationDays: 14,
    requiredCompletions: 8,
    description: "Eight runs across two weeks, with six non-required days.",
    publicCompetition: true,
  },
  {
    id: "build",
    name: "Build",
    durationDays: 30,
    requiredCompletions: 12,
    description: "Twelve runs in a month, roughly three per week.",
    publicCompetition: true,
  },
] as const;

export const MISSIONS: readonly MissionDefinition[] = [
  {
    id: "strava-run",
    arena: "MOVE",
    name: "GPS Run",
    status: "live",
    moneyEnabled: true,
    source: "Strava + Reclaim",
    promise: "Verify a Strava record that matches the pact's GPS-run policy without exposing a detailed route.",
    detail: "GPS, trainer, flags, timing, distance, and motion plausibility are checked.",
  },
  {
    id: "steps",
    arena: "MOVE",
    name: "Daily Steps",
    status: "next",
    moneyEnabled: false,
    source: "Fitbit API / Health Connect",
    promise: "A lower-friction daily movement challenge inspired by crew step games.",
    detail: "An authorized primary health-data source will be used; Moonwalk will not be the oracle.",
  },
  {
    id: "duolingo-learn",
    arena: "LEARN",
    name: "Daily Learning",
    status: "blocked",
    moneyEnabled: false,
    source: "Duolingo permission required",
    promise: "Research concept for consistent learning days; currently unavailable.",
    detail: "No provider and no money mode until an official API or written permission makes the integration supportable.",
  },
] as const;

export function stravaTemplate(durationDays: number): PactTemplate {
  const template = STRAVA_TEMPLATES.find((item) => item.durationDays === durationDays);
  if (!template) throw new Error("Unsupported Strava pact template");
  return template;
}
