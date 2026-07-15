# Lock In security model

This document describes the **unreleased Lock In build**. Lock In is not open to participants. The currently reachable test deployment remains paused and must not be used as evidence that the release is production-ready.

Lock In is a small-stake, multi-mission escrow on Monad. Creation and joining require short-lived admission attestations. The release escrow candidate accepts mission evidence only when a direct Reclaim witness proof and a short-lived backend EIP-712 attestation derived from the same canonical proof set independently agree on every settlement field. The backend verifies the pinned provider, TEE attestation, freshness, and mission policy; the direct verifier checks the signed claim, witness signature, exact schema, context binding, and normalized fields.

## Evidence boundaries

**Strava:** the policy binds proof to wallet, pact, day, and Reclaim session; requires the exact daily title, Run type, GPS presence, non-trainer and non-flagged status, minimum distance, coherent motion values, and plausible speed and pause ratios. A stable athlete identity cannot switch or back two wallets in one pact. Activity nullifiers are global.

**Duolingo:** a username or public XP lookup alone is never accepted. Reclaim must return two linked claims for the same requested stable profile ID: an authenticated self-only privacy-settings request disclosing only the constant marker name `disable_social`, and a profile request disclosing stable ID, username, and cumulative XP. The direct verifier pins both request hashes and rejects a missing claim, wrong order, wrong marker, or ID mismatch. Duolingo returned `200` for the signed-in profile, `403` for another requested ID, and `401` without a session. The participant keeps their normal username and display Name. A fresh baseline is accepted atomically with create or join. Each completion must exceed the maximum of the Lock baseline and globally consumed metric by the daily target. One profile cannot back two wallets in one Lock, and the same XP range cannot be reused.

These controls prove what the external service returned, not the underlying human activity. GPS spoofing, imported data, account sharing, bots, modified clients, collusion, outside help, upstream compromise, and provider errors remain possible. Lock In must never claim that zkTLS makes cheating impossible.

## Social boundaries

A Lock In handle is an optional wallet label, not authentication, legal identity, or proof of control over a Strava or Duolingo account. Active handles are unique and canonical, but a cleared or changed handle is released for reuse while every earlier event remains public. Clients must resolve the current contract mapping and moderation state rather than treat an old event or display string as authoritative.

Lock Score is a non-transferable counter with no transfer, redemption, payout, settlement, admission, or governance path. The contract awards 10 overall points at most once per wallet and UTC day. `missionIdentityOwner` also binds each mission-scoped hashed Strava or Duolingo identity to the first wallet whose accepted completion carries it. A later accepted completion from another wallet remains valid for its Lock but returns before social scoring. This limits multi-wallet Sybil farming; separate service identities and accounts do not establish one human. Stake, excess performance, multiple Locks, and high-fives cannot multiply the overall award. A high-five is unique per sender, recipient, Lock, and day.

Invite codes are deterministic encodings of public Lock IDs with a checksum against casual typos. They are not secrets or admission capabilities. Every join still requires the normal wallet authentication, admission attestation, capacity, timing, equal stake, and mission baseline where applicable.

## Authority and oracle model

The escrow candidate is wired to require both proof paths. It binds them through the mission policy hash, Reclaim session hash, canonical proof-set hash, identity, metric, occurrence time, and mission-specific fields. A mismatch reverts the transaction.

- Reclaim witnesses sign the HTTPS claim. The direct mission verifier checks that signature through the pinned Reclaim verifier and accepts only the exact provider schema and proof context expected by Lock In.
- The backend independently verifies the exact provider and version, top-level TEE attestation, freshness, wallet session, and higher-level mission policy before signing normalized EIP-712 evidence.
- The evidence authority cannot move escrowed funds and, under the hybrid contract, its key alone cannot fabricate a completion without a direct proof accepted by the mission verifier. Compromise still requires immediate closure and investigation.
- The admission authority signs only short-lived create or join authorization bound to chain, contract, action, wallet, pact, nonce, and expiry. It limits direct-contract admission while the cohort is controlled; it is not identity verification.
- The contract binds evidence to chain, contract, verifier address and code hash, pact, wallet, mission, day, Reclaim session, external-identity commitment, metric, proof-set hash, event nullifier, occurrence time, and expiry.
- Creation, joining, baseline acceptance, and daily completion have separate onchain pause controls. Settlement and claims remain permissionless.
- The owner can rotate authorities, cancel an unsettled pact only into participant refunds, and hide or restore an abusive handle on normal product surfaces. Profile moderation cannot delete historical events, change verified scores, alter winner status, withdraw escrowed funds, redirect payouts, or block finalization and claims.

The hybrid design removes unilateral evidence-signer authority; it does not make the system trustless or cheating impossible. A flawed parser, incorrect witness or provider configuration, upstream compromise, compromised backend plus an accepted proof, GPS spoofing, account sharing, bots, modified clients, and collusion remain possible.

The current verifier live-schema gates remain false and the modern TEE context is rejected until current live proofs are captured and audited. No release deployment exists. Before Lock In opens, both unfunded signing keys must move to a managed KMS, HSM-backed service, or equivalent isolated signer with least-privilege policies, audit logs, rotation, alerting, and a rehearsed revocation path. Contract ownership must move from the deployer to a documented multisig whose threshold, signers, backups, and incident process have been tested. The deployed verifier bytecode, signer addresses, and owner address must be verified publicly.

## Public-proof and secret boundary

The direct proof is sent as Monad transaction calldata using the Reclaim SDK's `transformForOnchain` output. Signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata, and witness signatures are therefore public and effectively permanent. Detailed proof fields are not copied into Lock In contract state or events and the full SDK proof object is not intentionally written to a product database, but neither fact makes transaction calldata private.

Duolingo calldata can expose username, stable profile ID, cumulative XP, the non-sensitive marker name `disable_social`, Reclaim session, wallet, internal Lock identifier, and phase. It must not expose a Duolingo password, cookie, Authorization header, access token, or privacy-setting value. Strava calldata can expose athlete marker, activity ID and title, start time, distance, motion and elevation values, GPS-presence status, trainer and flag status, Reclaim session, wallet, internal Lock identifier, and day. Lock In does not request the GPS route. The top-level TEE attestation JWT is verified by the backend but excluded by `transformForOnchain`.

The release path must reject a proof before transaction preparation if its signed parameters or context contain a cookie, Authorization header, access token, API key, secret, privacy-setting value, unexpected personal field, or similar sensitive header. Tests must inspect real provider output rather than assume redaction from synthetic fixtures.

Social state and events are also public and effectively permanent: wallet-to-handle history, profile visibility, mission-scoped hashed identity-to-scoring-wallet bindings, verified days, Lock Score awards, and high-five sender, recipient, Lock, and day. Clearing a handle changes active state but does not erase chain history. Weekly leaderboards are derived from these events; invite codes come from public Lock IDs.

## Fund invariants

- Official six-decimal Monad USDC and an immutable 1,000,000-unit maximum stake per participant, per pact.
- Equal stake, fixed 3–30 day schedule, immutable participant capacity, and one completion per wallet and pact day.
- The paired Duolingo account-control/XP proofs and baseline acceptance occur before the stake transfer in the same transaction; failure rolls back the entire transaction.
- Registration closes at start. Completion activity must occur during its claimed pact day, and its proof may be submitted during that day or the following 24 hours.
- Any completion-verification pause overlapping a pact from its start through its final proof deadline makes that pact refundable to every participant at finalization.
- If some participants finish, finishers split the full pool. If everyone or nobody finishes, joined participants recover their own stakes.
- Underfilled and cancelled pacts refund participants.
- Finalization and claims are permissionless; there is no protocol fee, owner withdrawal, or abandoned-funds sweep.
- Handles, moderation, rankings, invite codes, scores, verified-day counters, and reactions are absent from payout arithmetic.

## Release and operations

Website flags and wallet sessions are fail-closed UX and API controls. They do not protect direct contract calls; onchain admission checks and pauses are authoritative.

Keep every admission and evidence control paused until all of the following are complete:

1. live pinned Strava and paired Duolingo provider canaries, including exact schema, both Duolingo request hashes, claim ordering, TEE, witness, wrong-context, wrong-profile, secret-header, privacy-setting-value, negative, and replay cases;
2. source and constructor verification for the final paused escrow and both direct verifiers, including verifier addresses and runtime code hashes;
3. evidence signer, admission signer, USDC, cap, chain, mission policies, pause, and owner-address verification;
4. independent review of the contract, direct parsers and verifiers, oracle boundary, signer services, web authentication, and deployment configuration;
5. two-wallet rehearsals for both missions at 0.1 USDC, including the full direct-proof calldata path, gas and mobile-wallet behavior, settlement, claim, capacity, underfilled refund, and emergency refund;
6. social rehearsals covering handle uniqueness/change/clear and reuse, current-state resolution over historical events, invite-code checksum/routing, UTC-day score deduplication across simultaneous Locks, mission boards, high-five uniqueness, and hide/unhide moderation with unchanged payouts;
7. KMS-backed signing, multisig ownership, handle-abuse monitoring, liability reconciliation, incident response, accurate transaction-time privacy notice, public rules, and staffed support.

The 1 USDC cap reduces impact; it does not make an unaudited contract safe, remove legal obligations, or eliminate the possibility of loss. Do not invite real-funds testers before the release gate passes.

Keep funded keys out of Vercel and the repository. Never expose server secrets through `NEXT_PUBLIC_*`. Never collect wallet keys, seed phrases, reusable wallet signatures, Duolingo or Strava passwords, cookies, or access tokens in support.

Report vulnerabilities privately to **mookipstore@hotmail.com** with the affected contract or pact, transaction hash, UTC time, and impact. Do not include secrets, credentials, or the complete SDK proof object; reference already-public transaction data by hash.
