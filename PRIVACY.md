# Privacy policy — Lock In V5

Updated July 15, 2026. This policy covers the limited-cohort Lock In V5 beta. Privacy, incident, and beta-support contact: **mookipstore@hotmail.com**.

## Scope

Lock In does not create a product user account or maintain a user-profile database. The app reads the connected public wallet address and public Monad state to display pacts and prepare transactions requested by the user.

The beta is restricted to adults aged 18 or older. Do not send a seed phrase, private key, reusable signature, health information, or other sensitive information to support.

## Strava verification

During a Strava proof, Reclaim and the verification function process the signed athlete marker, activity ID and title, sport, start time, distance, moving time, elapsed time, elevation, GPS presence, trainer status, Strava flag status, proof time, wallet, pact, day, and Reclaim session. The GPS route is neither requested by Lock In nor written onchain.

The server uses those fields only to apply the pinned proof policy and return a short-lived evidence attestation. Lock In does not intentionally write raw proofs to a product database.

## Duolingo verification

The user enters a Duolingo username and places a wallet-specific 128-bit `LI-<32 HEX>` ownership code in the public profile bio. Reclaim and the verification function process the stable profile ID, username, bio, cumulative XP, proof time, wallet, pact, phase, and Reclaim session. The code demonstrates profile control; the cumulative XP establishes the baseline and later progress.

## Public, permanent Monad data

Contract state, transactions, token transfers, and events expose:

- wallet addresses, pact membership, mission, schedule, target, and equal stake;
- day indexes, timestamps, completion metric, hashed external identity, and event/proof nullifier;
- cancellations, settlement, claims, amounts paid, transaction hashes, and normal block metadata.

For Strava, the completion metric is run distance. For Duolingo, the stored metric is cumulative XP and is linked to the wallet through a hashed profile identity. Username, raw Duolingo profile ID, bio, raw Strava athlete marker, raw activity ID, and GPS route are not published by V5.

Monad data is public, copyable, and effectively permanent. Lock In cannot modify or erase it.

## Offchain providers and retention

Lock In does not intentionally retain raw Reclaim proofs after returning the attestation. Reclaim, Vercel, Monad RPC and explorer services, wallet providers, Circle, browser providers, email, and any later-disclosed analytics provider may process and retain technical data such as IP address, device, request time, and logs under their own policies.

Support messages are kept only as long as needed to respond, secure the beta, meet applicable obligations, or resolve a funds incident. Lock In does not sell a user profile.

## Purpose and rights

Data is used to bind evidence to the requesting wallet and pact, reject impersonation and replay, prepare requested transactions, render public state, account for funds, secure the beta, and answer support.

Depending on applicable law, a person may request access, correction, deletion, restriction, or objection for offchain information controlled by Lock In by writing to **mookipstore@hotmail.com**. They may also contact their local data-protection authority. Lock In cannot erase Monad records or data controlled by independent providers.

This notice is not legal advice and does not guarantee compliance, reimbursement, or an exemption in any jurisdiction.
