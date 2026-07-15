# Privacy policy — Lock In

Updated July 15, 2026. This policy covers Lock In. The service is not open to participants yet and the current test deployment is paused. Privacy, incident, and support contact: **mookipstore@hotmail.com**.

## Scope

Lock In does not create a product user account or maintain a user-profile database. The app reads the connected public wallet address and public Monad state to display pacts and prepare transactions requested by the user.

Before requesting admission or a Reclaim proof, the app asks the connected wallet to sign a human-readable challenge that identifies the website domain and origin, wallet, Monad chain ID, nonce, and five-minute expiration. A valid signature creates a strictly necessary HttpOnly, Secure, SameSite=Strict browser cookie bound to that wallet and origin for up to 12 hours. The cookie contains a server-authenticated session token, not the wallet signature or private key. Lock In does not write this session to a product database.

The operator may temporarily configure a comma-separated wallet allowlist for website authentication and the Reclaim proof API. The server then compares the connected public wallet address against that configuration. This is not an onchain allowlist and cannot prevent direct contract calls.

Any controlled test is restricted to adults aged 18 or older. Do not send a seed phrase, private key, reusable signature, health information, or other sensitive information to support.

For a create or join request, the server processes the authenticated public wallet, requested action, pact ID where applicable, nonce, and expiry to return a short-lived admission attestation. It does not require a real-world name.

## Strava verification

During a Strava proof, Reclaim and the verification function process the signed athlete marker, activity ID and title, sport, start time, distance, moving time, elapsed time, elevation, GPS-presence status, trainer status, Strava flag status, proof time, wallet, pact, day, and Reclaim session. These signed fields can appear in the proof transaction calldata described below. The GPS route itself is neither requested nor published by Lock In.

The server uses those fields to verify the pinned provider and policy and return a short-lived evidence attestation. The release contract also checks the matching direct Reclaim witness proof. Lock In does not intentionally write the full Reclaim SDK proof object to a product database.

## Duolingo verification

The user enters a Duolingo username and must control that profile well enough to temporarily set its public Name to a wallet-specific grouped `LOCK-ABCDE-FGHIJ` ownership code at proof time. Reclaim and the verification function process the stable profile ID, username, temporary Name code, cumulative XP, proof time, wallet, internal Lock identifier, phase, and Reclaim session. These signed fields can appear in the proof transaction calldata described below. The code demonstrates profile control at that time; cumulative XP establishes the baseline and later progress. It does not prove who earned the XP.

## Public, permanent Monad data

The release design requires each accepted mission proof to satisfy two checks in the same transaction: a direct Reclaim witness proof and a short-lived backend EIP-712 attestation derived from the same canonical proof set.

The Reclaim SDK's `transformForOnchain` output is included in transaction calldata. It contains the signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata such as identifier, owner, timestamp and epoch, and witness signatures. This transformed proof is not the complete SDK object, but it is also not only a hash. Calldata is public, copyable, and effectively permanent even when a value is not copied into contract storage or emitted in an event.

As a result, proof calldata can expose:

- for Duolingo: username, stable profile ID, temporary public Name code, cumulative XP, Reclaim session, wallet, internal Lock identifier, phase, provider/request metadata, and proof time;
- for Strava: athlete marker, activity ID and title, sport, start time, distance, moving and elapsed time, elevation, GPS-presence status, trainer and flag status, Reclaim session, wallet, pact, day, provider/request metadata, and proof time.

The top-level TEE attestation JWT used by the backend is excluded by `transformForOnchain` and is not sent as contract calldata. The signed claim context remains public. Before Lock In opens, the release gate must reject any proof whose signed parameters or context contain a `Cookie`, `Authorization`, access token, API key, secret, or similar sensitive header. Such a proof must never reach the wallet transaction.

Separately, contract state, token transfers, and events expose:

- wallet addresses, pact membership, mission, schedule, target, crew capacity, and equal stake;
- day indexes, timestamps, completion metric, hashed external identity, and event/proof nullifier;
- cancellations, settlement, claims, amounts paid, transaction hashes, and normal block metadata.

For Strava, the stored completion metric is run distance. For Duolingo, the stored metric is cumulative XP and is linked to the wallet through a hashed profile identity. The detailed fields above are not intentionally copied into Lock In contract state or events, but they are still public in the transformed proof calldata. The GPS route is not requested and is not included in that calldata.

Monad data is public, copyable, and effectively permanent. Lock In cannot modify or erase it.

## Offchain providers and retention

Lock In does not intentionally retain the full Reclaim SDK proof object in a product database after verification. This does not erase or make private the transformed proof already submitted in Monad calldata. The wallet-authentication cookie expires after at most 12 hours. Reclaim, Vercel, Monad RPC and explorer services, wallet providers, Circle, browser providers, email, and any later-disclosed analytics provider may process and retain technical data such as IP address, device, request time, and logs under their own policies.

Support messages are kept only as long as needed to respond, secure the unreleased service, meet applicable obligations, or resolve a funds incident. Lock In does not sell a user profile.

## Purpose and rights

Data is used to bind evidence to the requesting wallet and pact, reject impersonation and replay, prepare requested transactions, render public state, account for funds, secure controlled testing, and answer support.

Depending on applicable law, a person may request access, correction, deletion, restriction, or objection for offchain information controlled by Lock In by writing to **mookipstore@hotmail.com**. They may also contact their local data-protection authority. Lock In cannot erase Monad records or data controlled by independent providers.

This notice is not legal advice and does not guarantee compliance, reimbursement, or an exemption in any jurisdiction.
