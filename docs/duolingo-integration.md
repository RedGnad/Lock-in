# Duolingo integration

## Current decision

Duolingo is an unreleased mission next to Strava. Lock In never trusts a username or a public XP lookup alone, and it never asks a participant to rename their Duolingo profile. The participant keeps their normal username and display Name.

The private provider `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.4` requires two Reclaim claims for the same stable Duolingo profile ID:

1. **Authenticated ownership claim.** Reclaim requests `/2023-05-23/users/{{duolingo_user_id}}/privacy-settings` in the participant's active Duolingo session. Duolingo returned `200` for the signed-in profile, `403` when the same session targeted another stable profile ID, and `401` without a session. The provider discloses only the constant settings-key marker `disable_social`; it does not disclose whether that setting, or any other setting, is enabled.
2. **XP profile claim.** Reclaim requests `/2023-05-23/users/{{duolingo_user_id}}?fields=id,totalXp,username` and discloses the returned stable ID, username, and cumulative XP.

Both claims carry the same requested `duolingo_user_id`, wallet-bound context, Reclaim session, internal Lock identifier, and phase. The direct verifier requires both claims in their pinned order, requires the self-only marker, and requires the returned profile ID to equal the requested ID. Creation or joining, baseline acceptance, and the USDC stake remain atomic.

The published request hashes are:

- ownership: `0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e`
- XP: `0x1e2b7c4c1dbfe8694e49eee2c1e92ccac09ef048be735e5c54af7c006509b2ac`

Authenticated replay and local zkTLS proof generation succeeded for both requests; anonymous replay was rejected. The public release still stays closed until the exact live app/TEE proof shapes, transformed calldata, direct verifier, baseline, delta, negative, and replay paths pass end to end.

## Why public XP providers are insufficient

The Reclaim registry was checked on July 15, 2026. The relevant community providers expose cumulative `totalXp`, streak data, or a profile ID, but the inspected public XP flow accepts a user-selected ID and can therefore target somebody else's profile. Lock In does not use a public lookup as ownership evidence.

The server first resolves the entered username to Duolingo's stable numeric ID. Reclaim then proves that an authenticated session was authorized for the self-only endpoint for that exact ID and separately proves the XP snapshot for that ID. The user-facing username remains unchanged; the wallet-to-profile binding is the stable ID, not an editable display field.

## What the proof establishes

The pair of Reclaim claims establishes that Duolingo authorized the active session to access the self-only endpoint for the requested stable profile ID and that Duolingo returned a specific username and cumulative XP for that same ID. This is stronger than a public username lookup. It does not establish the person's legal identity, exclusive account control, who earned the XP, or learning without automation, account sharing, or outside help. Product wording therefore says “new Duolingo XP,” never “you learned.”

A streak alone is never accepted. Lock In requires:

1. A fresh two-claim authenticated baseline bound to wallet and Lock before stake transfer.
2. A fresh current-day two-claim snapshot from the same stable profile identity.
3. `current totalXp - max(Lock baseline, globally consumed totalXp) >= daily target`.
4. Global proof-set nullifiers and one stable profile per wallet within a Lock.

Raw XP must never be used as a competitive ranking because earning rates differ by exercise, bonuses, and product mechanics.

## Data and privacy

The participant may need to sign in to Duolingo inside Reclaim's isolated browser. Lock In does not ask for or receive the Duolingo password. The provider uses the authenticated session as a private request input; cookies, Authorization headers, access tokens, and privacy-setting values must not be disclosed in either signed claim.

The server transiently processes the requested stable profile ID, username, cumulative XP, the non-sensitive marker name `disable_social`, proof time, Reclaim session, wallet, internal Lock identifier, and phase without a product database. The release transaction carries the Reclaim SDK's `transformForOnchain` output. Signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata, and witness signatures are public and permanent Monad calldata, so those disclosed fields can be public even when they are not copied into contract storage or events. The top-level TEE attestation JWT is excluded from the onchain transform.

Any proof whose signed data contains a cookie, Authorization header, access token, API key, secret, privacy-setting value, or unexpected personal field must be rejected before transaction preparation. Lock In does not intentionally retain the full SDK proof object in a product database after verification; that does not erase public transaction calldata.

## Activation checklist

1. Confirm `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.4` and both pinned request hashes match the published provider and deployed verifier.
2. Capture a current two-claim app proof and confirm ordering, signed schema, provider version, request hashes, top-level TEE binding, witness configuration, direct-verifier output, proof-set hash, and absence of sensitive headers or privacy-setting values.
3. Pass live own-profile, other-profile (`403`), anonymous (`401`), mismatched-ID, stale proof, baseline/final mixing, XP delta, direct/backend mismatch, and replay tests.
4. Test transformed-calldata size, gas, mobile-wallet handoff, Duolingo sign-in recovery, and the transaction-time public-data notice end to end.
5. Move evidence and admission signing authorities into an auditable KMS or equivalent isolated signer, and keep contract ownership in the tested multisig.
6. Complete an independent review of the provider, direct verifier, oracle boundary, signer service, contract, deployment, privacy model, and the operational implications of Duolingo's terms and provider drift.
7. Confirm controlled-cohort eligibility and 18+ messaging before enabling real funds.
