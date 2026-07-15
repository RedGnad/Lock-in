# Duolingo integration

## Current decision

Duolingo is an unreleased mission next to Strava. Lock In never trusts a username alone. Before staking, the participant must control the claimed profile well enough to temporarily set its public Name to a wallet-derived `LOCK-ABCDE-FGHIJ` code. It uses 10 grouped Crockford Base32 characters and excludes ambiguous letters. One Reclaim proof must expose the stable profile ID, username, exact Name code, and cumulative `totalXp` from the same HTTPS response. The fresh XP baseline and the USDC stake are accepted atomically.

The integration remains independent and unofficial. The private provider is published and pinned. Its captured request and anonymous replay succeeded, as expected for this public endpoint. This only validates provider transport and extraction; it is not a complete user journey. The public release stays closed until live account-control, negative, baseline, delta, and replay rehearsals pass end to end, together with the contract and operations release gate.

## Reclaim registry audit

The active Reclaim registry was checked on July 15, 2026 through the authenticated Reclaim MCP. Fourteen entries match Duolingo; all are approved community entries but none is marked verified. The most relevant expose cumulative `totalXp`, `streakData`, or a profile id. They do not prove an authenticated self identity, a lesson/event id and a server completion time together.

The public XP providers accept a user ID in the request URL without proving account control. The inspected provider `7c57a498-6b0e-4b3a-8235-de7ba938e823` extracts only `totalXp`; a user can target somebody else's profile. Lock In does not use it. The Lock In provider closes that impersonation path by requiring the wallet code in the same profile response and binding the stable ID to one wallet per pact.

## What the proof establishes

Reclaim can prove that Duolingo returned the wallet code and credited progress to that profile. The code demonstrates profile control at proof time. It cannot establish who earned the XP or prove learning without automation, account sharing, or outside help. Product wording therefore says “new Duolingo XP,” never “you learned.”

A streak alone is never accepted. Lock In requires:

1. A fresh account-control-coded baseline bound to wallet and pact before stake transfer.
2. A fresh current-day snapshot from the same stable profile identity.
3. `current totalXp - max(pact baseline, globally consumed totalXp) >= daily target`.
4. Global snapshot nullifiers and one profile per wallet within a pact.

Raw XP must never be used as a competitive ranking because earning rates differ by exercise, bonuses, and product mechanics.

## Data and privacy

The proof uses the public profile response and does not need a Duolingo password or cookie inside Reclaim. The server processes stable profile ID, username, temporary public Name code, total XP, proof time, Reclaim session, wallet, internal Lock identifier, and phase without a product database.

The release transaction carries the Reclaim SDK's `transformForOnchain` output. Signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata, and witness signatures are public and permanent Monad calldata. The username, stable profile ID, temporary public Name code, total XP, Reclaim session, wallet, internal Lock identifier, and phase can therefore be public even though detailed profile fields are not copied into Lock In contract storage or events. The top-level TEE attestation JWT is excluded from the onchain transform.

Any proof whose signed data contains a cookie, Authorization header, access token, API key, secret, or similar sensitive header must be rejected before transaction preparation. Lock In does not intentionally retain the full SDK proof object in a product database after verification; that does not erase public transaction calldata.

## Activation checklist

1. Confirm the published `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.3` provider and pinned request hash match production.
2. Capture a current live proof and confirm the exact signed schema, provider version, top-level TEE binding, witness configuration, direct-verifier output, proof-set hash, and absence of sensitive headers.
3. Pass live account-control, wrong-profile, wrong-Name, stale proof, baseline/final mixing, XP delta, direct/backend mismatch, and replay tests.
4. Test transformed-calldata size, gas, mobile-wallet handoff, and the transaction-time public-data notice end to end.
5. Move the evidence and admission signing authorities into an auditable KMS or equivalent isolated signer, and move contract ownership to a tested multisig.
6. Complete an independent review of the provider, direct verifier, oracle boundary, signer service, contract, deployment, and privacy model.
7. Confirm controlled-cohort eligibility and 18+ messaging before enabling real funds.
