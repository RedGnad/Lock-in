# Lock In V5 security model

V5 is a small-stake, multi-mission escrow on Monad. Completion requires a short-lived EIP-712 attestation produced only after the server verifies a pinned Reclaim zkTLS proof and applies the mission policy.

## Evidence boundaries

**Strava:** the policy binds proof to wallet, pact, day and Reclaim session; requires the exact daily title, Run type, GPS, non-trainer, non-flagged activity, minimum distance, coherent motion values, and plausible speed/pause ratios. Stable athlete identity cannot switch or back two wallets in one pact. Activity nullifiers are global.

**Duolingo:** username alone is rejected. The proof must expose stable profile id, username, exact wallet code in the bio, and cumulative XP in one response. A fresh baseline is accepted atomically with create/join. The contract requires each completion to exceed the maximum of the pact baseline and globally consumed metric by the daily target. One profile cannot back two wallets in one pact and one XP range cannot be reused.

These controls prove what the services returned, not human activity. GPS spoofing, account sharing, bots, modified clients, collusion, upstream compromise, and provider errors remain possible.

## Trust and key model

- Reclaim verifies the HTTPS claim and TEE attestation for an exact provider id and version.
- `EVIDENCE_SIGNER_PRIVATE_KEY` signs only the normalized, policy-accepted fields. It is not the funded deployer key.
- The contract binds the signature to chain, contract, pact, wallet, mission, day, identity, metric, proof hash, event nullifier, occurrence time and expiry.
- A compromised evidence signer can fabricate completions. Pause evidence immediately, rotate the signer, and cancel affected unsettled pacts into refunds.
- The owner can rotate the signer and pause creation, joining or evidence. The owner cannot withdraw escrowed funds or block finalization/claims; emergency cancellation only enables refunds.

## Fund invariants

- Official six-decimal Monad USDC; immutable 1,000,000-unit maximum stake per participant per pact.
- Equal stake, 3–30 days, 2–100 minimum participants, one completion per wallet/day.
- Duolingo ownership proof and baseline acceptance occur before the stake transfer in the same transaction; failure rolls back everything.
- Registration closes at start; completions are current-day only.
- Finishers split the full pool. Nobody-finished, underfilled and cancelled pacts refund all participants.
- Permissionless finalization and self-service claims; no protocol fee, admin withdrawal or abandoned-funds sweep.

## Operations

Website flags are fail-closed UX gates only; direct calls require onchain pauses. Keep V5 paused until provider canaries, source verification, signer-address verification, two-wallet mission rehearsals, and an independent review pass. The contract is currently unaudited.

Keep the funded deployer key out of Vercel. Never expose server secrets through `NEXT_PUBLIC_*`. Never collect wallet keys, seed phrases, Duolingo passwords, Strava passwords, or session cookies in support.

Report vulnerabilities privately to **mookipstore@hotmail.com** with affected contract/pact, transaction hash, UTC time and impact. Do not include secrets.
