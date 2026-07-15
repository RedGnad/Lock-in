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

## Social loop

The social system is global across Locks but never mixes their pools or payout rules:

- each wallet may claim an optional Lock In handle that is independent from its Strava or Duolingo identity;
- every Lock has one deterministic, checksummed `LOCK-…` invite code derived from its public onchain ID;
- the crew view shows verified progress and permits one high-five from a joined participant to a crewmate for each verified day;
- the Lock Board has Overall, Running, and Learning weekly rankings, plus an all-time Lock Score.

Handles are unique while active, canonical lowercase, 3–16 characters, start with a letter, and otherwise use letters, numbers, or underscores. A participant can change or clear the active handle without changing either external-service profile. Clear releases the handle for reuse and removes it from normal Lock In surfaces, but every historical handle event and wallet link stays public. The owner may hide an abusive handle from product surfaces; the wallet and verified score remain visible, and moderation has no effect on funds or participation.

The scoring rule rewards consistency rather than money or volume. A wallet earns at most 10 overall points per UTC day. Each mission-scoped Strava or Duolingo identity can score only for its first bound wallet; a later accepted completion from another wallet still follows normal payout rules but emits no social score. This limits multi-wallet farming, not human identity across services or accounts. Stake, target, distance, XP, extra Locks, and high-fives cannot multiply the daily award.

Lock Score is non-transferable, non-redeemable reputation metadata. Handles, rank, score, verified days, invite use, and high-fives never affect admission, required completions, finisher status, settlement, claim amount, or payout ordering. An invite code is not a private invitation or authorization credential; every normal join rule still applies.

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

For Duolingo, a username or public XP lookup alone is insufficient. The server resolves the username to a stable numeric profile ID, then Reclaim returns two linked claims for that ID: an authenticated self-only privacy-settings request that discloses only the constant marker name `disable_social`, and a profile request that discloses only stable ID and cumulative XP. Duolingo returned `200` for the signed-in profile, `403` for another requested profile ID, and `401` without a session. Participants keep their normal username and display Name, and neither is published in the proof. Only XP earned after the accepted baseline can count, and consumed XP cannot be reused.

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

Social actions are outside the settlement calculation. The contract owner cannot change a participant's score to change winner status, and hiding a profile does not change that wallet's claim rights.

## Money and eligibility

Every participant stakes from 0.1 to 1 USDC. The 1 USDC cap is **per participant, per Lock**, not a global wallet limit. Monad gas is separate. The interface should default controlled tests to 0.1 USDC and show the maximum before the wallet transaction, not after an invalid entry.

The initial cohort is adults-only. Participants must determine whether stake-based challenges are permitted where they live. Small stakes do not create a legal exemption or remove smart-contract risk.

## Privacy

Lock In does not intentionally retain the full Reclaim SDK proof object in a product-profile database. Monad permanently exposes wallets, Lock terms, membership, stake, mission, day, accepted metric, hashed identity, nullifier, settlement, claims, optional current and historical Lock In handles, handle-visibility moderation, Lock Score, overall and mission verified-day counters, and high-five sender/recipient/Lock/day events. Invite codes are deterministically derived from public Lock IDs and are not secrets.

The proof transaction also carries the SDK's `transformForOnchain` output. Signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata, and witness signatures are public and permanent calldata even when their contents are not copied into contract state or events. Duolingo calldata can expose stable profile ID, cumulative XP, the non-sensitive marker name `disable_social`, Reclaim session, wallet, internal Lock identifier, and phase; the username is not included. It must not disclose cookies, credentials, or privacy-setting values. Strava calldata can expose athlete marker, activity ID and title, start time, distance, motion and elevation values, GPS-presence status, trainer and flag status, Reclaim session, wallet, internal Lock identifier, and day. The top-level TEE attestation JWT is excluded from the transform. The GPS route is not requested or published.

Before opening, Lock In must reject any signed proof containing a cookie, Authorization header, access token, API key, secret, privacy-setting value, unexpected personal field, or similar sensitive header before transaction preparation.

## Public-release gate

Lock In remains closed until all of these conditions pass:

1. the final escrow and direct verifiers are deployed paused and their source, constructor, verifier addresses and code hashes, USDC, cap, owner, authorities, mission policies, and pause states are publicly verified;
2. Strava and two-claim Duolingo providers pass live exact-schema, request-hash, claim-ordering, TEE, witness, secret-header, privacy-value, positive, negative, stale, wrong-wallet, wrong-profile, and replay canaries;
3. admission and evidence keys run in an auditable KMS or equivalent isolated signer with least privilege, monitoring, rotation, and emergency revocation;
4. contract ownership is transferred to a tested multisig;
5. the direct parsers and verifiers, escrow, oracle boundary, signer services, wallet authentication, deployment, rules, and privacy model receive independent review;
6. two controlled wallets complete both hybrid mission paths at 0.1 USDC, including transformed-calldata size and gas, mobile-wallet handoff, capacity, partial completion, payout, zero-finisher, underfilled, cancellation, and emergency-refund branches;
7. the same wallets pass handle uniqueness/change/clear, invite routing, weekly and mission score deduplication, high-five uniqueness, hide/unhide moderation, and proof that none of those paths changes settlement;
8. production monitoring, handle-abuse response, liability reconciliation, incident response, and staffed support are operational.

Passing the gate permits a small monitored cohort, not an uncapped public rollout.
