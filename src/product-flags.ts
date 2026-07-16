export const PRODUCT_FLAG_ENV_NAMES = [
  "NEW_PACTS_ENABLED",
  "JOIN_ENABLED",
  "CHECK_INS_ENABLED",
] as const;

export type ProductFlagEnvName = (typeof PRODUCT_FLAG_ENV_NAMES)[number];

export type ProductActions = Readonly<{
  newPacts: boolean;
  join: boolean;
  checkIns: boolean;
  settlement: true;
  claim: true;
}>;

export type ProductFlagConfiguration = Readonly<{
  allConfigured: boolean;
  configured: Readonly<Record<ProductFlagEnvName, boolean>>;
}>;

export type ProductFlagState = Readonly<{
  actions: ProductActions;
  configuration: ProductFlagConfiguration;
  mode: "paused" | "restricted" | "open";
}>;

export type ProofAction = Readonly<{
  phase: "admission" | "completion";
  intent?: "create" | "join";
}>;

type ProductFlagEnvironment = { [name: string]: string | undefined };

function readBooleanFlag(value: string | undefined): { enabled: boolean; configured: boolean } {
  const normalized = value?.trim();
  return {
    enabled: normalized === "true",
    configured: normalized === "true" || normalized === "false",
  };
}

/**
 * Reads server-side product gates. Missing, misspelled, or non-boolean values
 * always disable the risky action. UI clients consume the sanitized booleans
 * from /api/health; the environment itself is never exposed.
 *
 * Settlement and claim are literals, not environment flags. An operator can
 * stop new exposure or check-ins, but can never use configuration to hide the
 * users' exit path.
 */
export function readProductFlagState(
  environment: ProductFlagEnvironment = process.env,
): ProductFlagState {
  const newPacts = readBooleanFlag(environment.NEW_PACTS_ENABLED);
  const join = readBooleanFlag(environment.JOIN_ENABLED);
  const checkIns = readBooleanFlag(environment.CHECK_INS_ENABLED);
  const enabledCount = Number(newPacts.enabled) + Number(join.enabled) + Number(checkIns.enabled);

  const configured = {
    NEW_PACTS_ENABLED: newPacts.configured,
    JOIN_ENABLED: join.configured,
    CHECK_INS_ENABLED: checkIns.configured,
  } as const;

  return {
    actions: {
      newPacts: newPacts.enabled,
      join: join.enabled,
      checkIns: checkIns.enabled,
      settlement: true,
      claim: true,
    },
    configuration: {
      allConfigured: Object.values(configured).every(Boolean),
      configured,
    },
    mode: enabledCount === 0 ? "paused" : enabledCount === 3 ? "open" : "restricted",
  };
}

/**
 * Maps every signed-attestation request to the same fail-closed release gate used by the UI.
 * This stops a paused deployment from issuing a short-lived signature through a direct API call,
 * which matters more now that the evidence signature is the whole of the completion check.
 */
export function isProofActionEnabled(state: ProductFlagState, action: ProofAction): boolean {
  if (action.phase === "completion") return state.actions.checkIns;
  if (action.intent === "create") return state.actions.newPacts;
  if (action.intent === "join") return state.actions.join;
  return false;
}
