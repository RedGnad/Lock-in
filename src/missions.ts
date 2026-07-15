export type PactTemplate = {
  id: string;
  name: string;
  durationDays: 3 | 7 | 14 | 30;
  requiredCompletions: number;
  description: string;
};

export const PACT_TEMPLATES: readonly PactTemplate[] = [
  {
    id: "quickfire",
    name: "Quickfire",
    durationDays: 3,
    requiredCompletions: 3,
    description: "Three days. No misses.",
  },
  {
    id: "momentum",
    name: "Momentum",
    durationDays: 7,
    requiredCompletions: 5,
    description: "Five check-ins in seven days.",
  },
  {
    id: "discipline",
    name: "Discipline",
    durationDays: 14,
    requiredCompletions: 10,
    description: "Ten check-ins across two weeks.",
  },
  {
    id: "long-game",
    name: "Long Game",
    durationDays: 30,
    requiredCompletions: 20,
    description: "Twenty check-ins across a month.",
  },
] as const;

export function pactTemplate(durationDays: number): PactTemplate {
  const template = PACT_TEMPLATES.find((item) => item.durationDays === durationDays);
  if (!template) throw new Error("Unsupported pact template");
  return template;
}
