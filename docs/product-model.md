# Lock In product model

This document defines the product intended for the public Lock In release. Lock In is not open to participants; the current test deployment remains paused.

## Positioning

Lock In is competitive accountability, not a general betting market. Friends choose one self-improvement mission, stake equally, and commit to a published schedule. The crew creates social momentum, while the payout creates a real consequence: finishers recover their stake and split the stakes of participants who quit.

“Accountability that pays” and “funded by those who quit” express the product clearly, but every short claim must link to the exact payout and zero-finisher rules. Lock In never claims that external service data proves biological movement or learning.

## One Lock, one pool

Every Lock is an independent pool with immutable terms:

- mission and daily target;
- start, duration, and number of successful days required;
- equal stake for every participant;
- minimum crew and maximum capacity.

A 3-day Strava Lock never competes with a 7-day Lock or a Duolingo Lock. Fixed capacity prevents an unexpected late crew from changing exposure. Registration closes at the published start.

## Launch missions

- **Strava GPS Run:** daily targets of 1, 3, 5, or 10 km.
- **Duolingo XP:** daily targets of 10, 20, 30, or 50 new XP above a fresh wallet-bound baseline.

Both missions use the same commitment templates:

| Duration | Required successful days | Product role |
| --- | ---: | --- |
| 3 days | 3 | Fast onboarding; still requires a real multi-day streak |
| 7 days | 5 | Default social challenge with two recovery days |
| 14 days | 10 | Medium commitment and visible progression |
| 30 days | 20 | Long-form habit challenge |

There is no one-day money-bearing mode. A participant cannot enter immediately before one already-planned activity and complete the whole challenge.

## Proof policy

Reclaim zkTLS proves what Strava or Duolingo returned over HTTPS. The release design requires two matching checks of the same canonical proof set: a mission-specific direct Reclaim witness verifier and a short-lived, contract-bound backend attestation after TEE and business-policy validation. The escrow rejects either check alone and rejects any mismatch between them.

For Strava, the policy requires a challenge-titled GPS Run with coherent motion data, the target distance, non-trainer status, and no Strava flag. It binds a stable athlete identity and globally consumes the activity nullifier.

For Duolingo, a username alone is insufficient. The participant must control the claimed profile well enough to temporarily set its public Name to the exact wallet-specific code at proof time. The proof captures stable profile ID, username, public Name, and cumulative XP together. Only XP earned after the accepted baseline can count, and consumed XP cannot be reused.

Neither policy proves who performed the activity. GPS spoofing, imports, account sharing, bots, modified clients, outside help, upstream errors, and collusion remain residual risks. The product promise is replay-resistant, policy-checked service evidence—not impossible cheating.

## Admission and cohort control

Create and join calls require short-lived admission attestations bound to chain, contract, action, wallet, internal Lock identifier, nonce, and expiry. The Solidity and signed-data schemas retain the field name `pactId` for compatibility; all consumer surfaces call the product a **Lock**. This makes the initial controlled cohort enforceable onchain instead of relying only on website flags. It is a safety and capacity control, not real-world identity verification.

The website also authenticates the connected wallet with an origin-bound signed challenge. No participant key or seed phrase is collected.

## Settlement

- If some participants finish, finishers split the full pool equally.
- If everyone finishes, every participant effectively receives their own stake back.
- If nobody finishes, every participant is eligible to recover their own stake.
- If the minimum crew is not reached or the Lock is cancelled, every participant is eligible for a refund.
- Settlement and claims are permissionless and stay available while admission or evidence is paused.
- Lock In charges no protocol fee during controlled testing.

The contract has no operator withdrawal or abandoned-funds sweep.

## Money and eligibility

Every participant stakes from 0.1 to 1 USDC. The 1 USDC cap is **per participant, per Lock**, not a global wallet limit. Monad gas is separate. The interface should default controlled tests to 0.1 USDC and show the maximum before the wallet transaction, not after an invalid entry.

The initial cohort is adults-only. Participants must determine whether stake-based challenges are permitted where they live. Small stakes do not create a legal exemption or remove smart-contract risk.

## Privacy

Lock In does not intentionally retain the full Reclaim SDK proof object in a product-profile database. Monad permanently exposes wallets, Lock terms, membership, stake, mission, day, accepted metric, hashed identity, nullifier, settlement, and claims.

The proof transaction also carries the SDK's `transformForOnchain` output. Signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata, and witness signatures are public and permanent calldata even when their contents are not copied into contract state or events. Duolingo calldata can expose username, stable profile ID, temporary public Name code, cumulative XP, Reclaim session, wallet, internal Lock identifier, and phase. Strava calldata can expose athlete marker, activity ID and title, start time, distance, motion and elevation values, GPS-presence status, trainer and flag status, Reclaim session, wallet, internal Lock identifier, and day. The top-level TEE attestation JWT is excluded from the transform. The GPS route is not requested or published.

Before opening, Lock In must reject any signed proof containing a cookie, Authorization header, access token, API key, secret, or similar sensitive header before transaction preparation.

## Public-release gate

Lock In remains closed until all of these conditions pass:

1. the final escrow and direct verifiers are deployed paused and their source, constructor, verifier addresses and code hashes, USDC, cap, owner, authorities, mission policies, and pause states are publicly verified;
2. Strava and Duolingo providers pass live exact-schema, TEE, witness, secret-header, positive, negative, stale, wrong-wallet, and replay canaries;
3. admission and evidence keys run in an auditable KMS or equivalent isolated signer with least privilege, monitoring, rotation, and emergency revocation;
4. contract ownership is transferred to a tested multisig;
5. the direct parsers and verifiers, escrow, oracle boundary, signer services, wallet authentication, deployment, rules, and privacy model receive independent review;
6. two controlled wallets complete both hybrid mission paths at 0.1 USDC, including transformed-calldata size and gas, mobile-wallet handoff, capacity, partial completion, payout, zero-finisher, underfilled, cancellation, and emergency-refund branches;
7. production monitoring, liability reconciliation, incident response, and staffed support are operational.

Passing the gate permits a small monitored cohort, not an uncapped public rollout.
