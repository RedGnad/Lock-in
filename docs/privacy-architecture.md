# Proof privacy and oracle architecture

This document describes the architecture required for the first Lock In release. Lock In is not open to participants, no release contract has been deployed, and the reachable historical test deployment remains paused.

## Hybrid proof decision

Lock In does not accept a backend signature as the only proof of mission completion. The release escrow candidate requires two independent views of the same canonical Reclaim proof set:

1. Reclaim returns the full SDK proof object to the proof flow.
2. The backend verifies the exact provider and version, top-level TEE attestation, freshness, wallet session, and mission policy, then signs short-lived EIP-712 evidence.
3. The client validates the SDK proof shape, rejects signed data containing sensitive headers, and applies the SDK's `transformForOnchain` without changing the signed bytes.
4. The wallet submits the transformed witness proof and backend attestation in one Monad transaction.
5. The mission-specific direct verifier checks the Reclaim witness signature, exact signed schema and context, and normalized evidence. The escrow requires the direct result and backend attestation to agree on their proof-set hash, session, identity, metric, time, and mission-specific fields.

A mismatch reverts. This means the evidence signing key alone cannot fabricate a completion. The candidate is still closed because live proof schemas and modern TEE contexts have not been confirmed, the verifier gates fail closed, and the complete web-to-wallet path has not passed a real canary.

## Public transaction calldata

`transformForOnchain` includes signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata such as identifier, owner, timestamp and epoch, and witness signatures. Those values become public, copyable, and effectively permanent Monad transaction calldata. A value does not become private merely because the contract does not copy it into storage or emit it in an event.

The signed fields can expose:

- **Duolingo:** username, stable profile ID, cumulative XP, the non-sensitive self-endpoint marker name `disable_social`, Reclaim session, wallet, internal Lock identifier, phase, provider/request metadata, and proof time. The authenticated request must not disclose cookies, credentials, Authorization headers, access tokens, or privacy-setting values.
- **Strava:** athlete marker, activity ID and title, sport, start time, distance, moving and elapsed time, elevation, GPS-presence status, trainer and flag status, Reclaim session, wallet, pact, day, provider/request metadata, and proof time.

The top-level TEE attestation JWT is not part of `transformForOnchain`; the backend verifies it offchain. The signed claim context itself is public. The Strava provider does not request the GPS route, so the route is not included in the proof calldata.

## Public contract state and events

The escrow separately records or emits the following settlement state:

- pact, wallet, mission, day, schedule, capacity, and stake;
- hashed external identity scoped to the policy;
- completion metric and occurrence time;
- globally unique proof or activity nullifier;
- settlement, claims, token transfers, and normal transaction metadata.

For Strava, the stored metric is distance. For Duolingo, it is cumulative XP. Detailed username, profile, athlete, and activity fields remain absent from Lock In storage and events, but are still public when present in proof calldata. A Duolingo display Name is not requested and does not need to change.

## Public social state and events

The social layer is intentionally wallet-native and does not reuse an external-service identity:

- an optional, unique active Lock In handle maps directly to a public wallet; setting, changing, and clearing it emits `PlayerHandleSet`;
- `LockScoreAwarded` records at most 10 overall points for a wallet's first verified completion in each UTC day, and `MissionDayVerified` independently deduplicates running and learning days;
- `MissionIdentityBound` publicly binds each mission-scoped hashed Strava or Duolingo identity to the first wallet eligible to score with it;
- `HighFiveSent` records Lock ID, sender, recipient, and verified day index;
- `PlayerProfileVisibilityUpdated` records whether the owner has hidden a profile's handle from normal Lock In surfaces;
- a checksummed `LOCK-…` invite code is deterministically derived from the public Lock ID. It is an addressable sharing aid, not an access secret or identity proof.

Handle and moderation mappings describe the current app presentation, but their event history is permanent. Clearing a handle deletes its active mapping and makes it available for reuse; it cannot erase earlier wallet-to-handle events or third-party copies. Hiding a profile suppresses the handle on Lock In surfaces but does not suppress the wallet, verified days, or scores. Product and moderation copy must not imply onchain deletion.

Lock Score is a non-transferable contract counter rather than a token. A wallet earns at most 10 overall points per UTC day, and each mission identity scores only for its first bound wallet. Another wallet's accepted completion can still settle its Lock but emits no score. This limits multi-wallet farming; it is not proof of one human across Strava, Duolingo, or multiple accounts. Scores and reactions remain excluded from payout calculations.

## Offchain handling and secret gate

Lock In does not intentionally write the full SDK proof object to a product database. The proof exists transiently in the browser and verification function long enough to verify it, derive the attestation, transform it, and submit the requested transaction. This retention choice does not erase public calldata after submission.

Before public opening, a release gate must inspect real signed `parameters` and `context` and reject any proof containing a `Cookie`, `Authorization`, access token, API key, secret, privacy-setting value, unexpected personal field, or similar sensitive header. Rejection must happen before transaction preparation. Synthetic fixtures are not sufficient evidence that a live provider is safe.

Operational logs should contain request IDs, public wallet, internal Lock identifier, policy result, provider/version and request-hash commitments, transaction hash where applicable, latency, and a coarse failure class. They should not duplicate full proofs, signed contexts, credentials, cookies, GPS routes, Duolingo usernames or raw stable IDs, privacy-setting values, free-form activity titles, or redundant copies of onchain social history.

## Trust trade-off

The hybrid AND condition narrows the oracle boundary, but it does not prove the underlying human action and is not trustless. Reclaim establishes what an external HTTPS service returned. Residual risks include an incorrect direct parser, bad witness or provider configuration, upstream compromise, GPS spoofing, imported data, account sharing, bots, modified clients, outside help, and collusion.

The admission authority remains separate. It can authorize short-lived create or join access but cannot fabricate mission completion or move escrowed funds. Contract ownership can pause or rotate authorities, cancel an unsettled pact into refunds, and hide an abusive handle from normal product surfaces. Profile moderation cannot delete chain history, alter scores, change finishers, or redirect participant funds.

## Required release controls

Before public opening:

1. capture current live Strava proofs and paired Duolingo ownership/XP proofs, then confirm exact provider versions, both Duolingo request hashes, signed schemas, claim ordering, TEE binding, witness configuration, context grammar, proof counts, secret-free headers, and absence of privacy-setting values;
2. make the direct verifier live-schema gates pass only for those reviewed shapes and pin the verifier addresses and runtime code hashes in each mission policy;
3. run evidence and admission keys in a managed KMS, HSM-backed service, or equivalent isolated signer with separate identities, least privilege, audit logs, rotation, alerting, and rehearsed revocation;
4. authenticate, schema-validate, rate-limit, bind, expire, and single-use every signing request without logging the full proof content;
5. transfer contract ownership to a tested multisig with documented threshold, signer independence, backups, and response times;
6. independently review the Reclaim path, direct parsers and verifiers, policy service, signer services, wallet authentication, escrow, deployment, and log-retention configuration;
7. test transformed-calldata size, gas, mobile-wallet handoff, rejected transactions, privacy notice, and both missions end to end with two controlled wallets at 0.1 USDC;
8. test handle uniqueness/change/clear semantics, invite-code routing, daily and mission score deduplication, high-five uniqueness, and hide/unhide moderation without any payout change;
9. monitor provider/request drift, verifier code, signer use, unexpected pacts or participants, abusive handles, and escrow liability.

The funded deployer key must never be present in Vercel, a signer service, support tooling, or the repository.

## Broader consumer gate

Before expansion beyond a small monitored cohort, Lock In needs an identified operator, lawful-basis and jurisdiction review, data-processing agreements where required, a data-protection impact assessment where applicable, deletion and provider-revocation procedures for offchain data, and evidence that real incident and support processes work.

Further improvements could use selective disclosure, independently attested verifier upgrades, or a threshold policy service. They do not change the present requirement to describe public proof calldata and residual fraud risk honestly.
