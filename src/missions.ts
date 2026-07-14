export type PactTemplate = {
  id: string;
  name: string;
  durationDays: 1 | 3 | 7 | 14 | 30;
  requiredCompletions: number;
  description: string;
  publicCompetition: boolean;
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

export function stravaTemplate(durationDays: number): PactTemplate {
  const template = STRAVA_TEMPLATES.find((item) => item.durationDays === durationDays);
  if (!template) throw new Error("Unsupported Strava pact template");
  return template;
}
