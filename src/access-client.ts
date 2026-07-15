import type { AccessEvidence } from "./access-attestation";
import type { PactConfiguration } from "./pact-configuration";

export async function requestAccessEvidence(input: {
  walletAddress: string;
  action: "create" | "join";
  pactId?: string;
  configuration?: PactConfiguration;
}): Promise<AccessEvidence> {
  const response = await fetch("/api/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      walletAddress: input.walletAddress,
      action: input.action,
      pactId: input.pactId,
      configuration: input.configuration ? {
        ...input.configuration,
        stake: input.configuration.stake.toString(),
        startsAt: input.configuration.startsAt.toString(),
      } : undefined,
    }),
  });
  const value = await response.json() as {
    evidence?: {
      configHash?: `0x${string}`;
      nonce?: `0x${string}`;
      issuedAt?: string;
      expiresAt?: string;
      signature?: `0x${string}`;
    };
    error?: string;
  };
  if (
    !response.ok || !value.evidence?.configHash || !value.evidence.nonce
      || !value.evidence.issuedAt || !value.evidence.expiresAt || !value.evidence.signature
  ) {
    throw new Error(value.error || "Could not authorize this pact action");
  }
  return [
    value.evidence.configHash,
    value.evidence.nonce,
    BigInt(value.evidence.issuedAt),
    BigInt(value.evidence.expiresAt),
    value.evidence.signature,
  ];
}
