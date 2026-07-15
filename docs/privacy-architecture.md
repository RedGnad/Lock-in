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

- **Duolingo:** username, stable profile ID, temporary public Name code, cumulative XP, Reclaim session, wallet, internal Lock identifier, phase, provider/request metadata, and proof time.
- **Strava:** athlete marker, activity ID and title, sport, start time, distance, moving and elapsed time, elevation, GPS-presence status, trainer and flag status, Reclaim session, wallet, pact, day, provider/request metadata, and proof time.

The top-level TEE attestation JWT is not part of `transformForOnchain`; the backend verifies it offchain. The signed claim context itself is public. The Strava provider does not request the GPS route, so the route is not included in the proof calldata.

## Public contract state and events

The escrow separately records or emits only what settlement needs:

- pact, wallet, mission, day, schedule, capacity, and stake;
- hashed external identity scoped to the policy;
- completion metric and occurrence time;
- globally unique proof or activity nullifier;
- settlement, claims, token transfers, and normal transaction metadata.

For Strava, the stored metric is distance. For Duolingo, it is cumulative XP. Detailed username, display Name, profile, athlete, and activity fields remain absent from Lock In storage and events, but are still public when present in proof calldata.

## Offchain handling and secret gate

Lock In does not intentionally write the full SDK proof object to a product database. The proof exists transiently in the browser and verification function long enough to verify it, derive the attestation, transform it, and submit the requested transaction. This retention choice does not erase public calldata after submission.

Before public opening, a release gate must inspect real signed `parameters` and `context` and reject any proof containing a `Cookie`, `Authorization`, access token, API key, secret, or similar sensitive header. Rejection must happen before transaction preparation. Synthetic fixtures are not sufficient evidence that a live provider is safe.

Operational logs should contain request IDs, public wallet, internal Lock identifier, policy result, provider/version commitment, transaction hash where applicable, latency, and a coarse failure class. They should not duplicate full proofs, signed contexts, credentials, cookies, GPS routes, profile Names, raw external IDs, or free-form activity titles.

## Trust trade-off

The hybrid AND condition narrows the oracle boundary, but it does not prove the underlying human action and is not trustless. Reclaim establishes what an external HTTPS service returned. Residual risks include an incorrect direct parser, bad witness or provider configuration, upstream compromise, GPS spoofing, imported data, account sharing, bots, modified clients, outside help, and collusion.

The admission authority remains separate. It can authorize short-lived create or join access but cannot fabricate mission completion or move escrowed funds. Contract ownership can pause or rotate authorities and cancel an unsettled pact into refunds; it cannot withdraw participant funds.

## Required release controls

Before public opening:

1. capture current live Strava and Duolingo proofs and confirm exact provider versions, signed schemas, TEE binding, witness configuration, context grammar, proof counts, and secret-free headers;
2. make the direct verifier live-schema gates pass only for those reviewed shapes and pin the verifier addresses and runtime code hashes in each mission policy;
3. run evidence and admission keys in a managed KMS, HSM-backed service, or equivalent isolated signer with separate identities, least privilege, audit logs, rotation, alerting, and rehearsed revocation;
4. authenticate, schema-validate, rate-limit, bind, expire, and single-use every signing request without logging the full proof content;
5. transfer contract ownership to a tested multisig with documented threshold, signer independence, backups, and response times;
6. independently review the Reclaim path, direct parsers and verifiers, policy service, signer services, wallet authentication, escrow, deployment, and log-retention configuration;
7. test transformed-calldata size, gas, mobile-wallet handoff, rejected transactions, privacy notice, and both missions end to end with two controlled wallets at 0.1 USDC;
8. monitor provider/request drift, verifier code, signer use, unexpected pacts or participants, and escrow liability.

The funded deployer key must never be present in Vercel, a signer service, support tooling, or the repository.

## Broader consumer gate

Before expansion beyond a small monitored cohort, Lock In needs an identified operator, lawful-basis and jurisdiction review, data-processing agreements where required, a data-protection impact assessment where applicable, deletion and provider-revocation procedures for offchain data, and evidence that real incident and support processes work.

Further improvements could use selective disclosure, independently attested verifier upgrades, or a threshold policy service. They do not change the present requirement to describe public proof calldata and residual fraud risk honestly.
