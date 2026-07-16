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

A 3-day Lock never competes with a 7-day Lock. Fixed capacity prevents an unexpected late crew from changing exposure. Registration closes at the published start.

## Social loop

The social system is global across Locks but never mixes their pools or payout rules:

- each wallet may claim an optional Lock In handle that is independent from its Strava identity;
- every Lock has one deterministic, checksummed `LOCK-…` invite code derived from its public onchain ID;
- the crew view shows verified progress and permits one high-five from a joined participant to a crewmate for each verified day;
- the Lock Board has Overall, Running, and Learning weekly rankings, plus an all-time Lock Score.

Handles are unique while active, canonical lowercase, 3–16 characters, start with a letter, and otherwise use letters, numbers, or underscores. A participant can change or clear the active handle without changing either external-service profile. Clear releases the handle for reuse and removes it from normal Lock In surfaces, but every historical handle event and wallet link stays public. The owner may hide an abusive handle from product surfaces; the wallet and verified score remain visible, and moderation has no effect on funds or participation.

The scoring rule rewards consistency rather than money or volume. A wallet earns at most 10 overall points per UTC day. Each mission-scoped Strava or Duolingo identity can score only for its first bound wallet; a later accepted completion from another wallet still follows normal payout rules but emits no social score. This limits multi-wallet farming, not human identity across services or accounts. Stake, target, distance, XP, extra Locks, and high-fives cannot multiply the daily award.

Lock Score is non-transferable, non-redeemable reputation metadata. Handles, rank, score, verified days, invite use, and high-fives never affect admission, required completions, finisher status, settlement, claim amount, or payout ordering. An invite code is not a private invitation or authorization credential; every normal join rule still applies.

## Launch missions

- **Strava GPS Run:** daily targets of 1, 3, 5, or 10 km.

The mission uses these commitment templates:

| Duration | Required successful days | Product role |
| --- | ---: | --- |
| 3 days | 3 | Fast onboarding; still requires a real multi-day streak |
| 7 days | 5 | Default social challenge with two recovery days |
| 14 days | 10 | Medium commitment and visible progression |
| 30 days | 20 | Long-form habit challenge |

There is no one-day money-bearing mode. A participant cannot enter immediately before one already-planned activity and complete the whole challenge.

## Verification policy

Lock In reads the run from Strava's official API, over the athlete's OAuth grant, and applies the policy on
the server. A day counts when the activity is a GPS Run, started inside that day of the Lock, reaching the
distance target, not manual, not on a treadmill, not flagged by Strava, and with coherent motion.

The scheme is named on chain as `STRAVA_OAUTH_V1`, and a Lock created under one scheme can never be
completed under another. The backend signs the result with a short-lived EIP-712 attestation, and the
escrow accepts that signature as sufficient: **the evidence signer is a trusted party**, and a compromised
evidence key can create completions that never happened. The zkTLS design this replaced required an
independent on-chain witness as well, so neither signature alone was enough. That property was traded for a
flow an athlete will actually repeat daily, and the trade is stated rather than hidden.

Verification does not prove physical movement, exclusive account use, or the absence of GPS spoofing, bots,
modified devices or upstream errors. It reduces impersonation, replay, identity switching and obvious manual
entries. One activity settles at most once, globally, and one Strava identity backs one wallet per Lock.

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

Lock In keeps one offchain record per athlete: the Strava connection, holding the athlete id, the granted
scopes and both OAuth tokens encrypted with AES-256-GCM under a dedicated key. Nothing there reaches the
browser or the chain; the tokens are decrypted in server memory only to call Strava. Disconnecting revokes
the grant at Strava and deletes the row.

Monad permanently exposes the wallet, the Lock terms, the stake, the day, the completion metric, the motion
fields, the activity start time, and three values derived from Strava data by HMAC under a server-held key:
one standing for the athlete, one for the single activity, one summarising it. Raw Strava identifiers are
not published. A hash is not anonymity: anyone holding the key and a candidate identifier can confirm a
match. The GPS route is never requested.

## Public-release gate

Lock In remains closed until all of these conditions pass:

1. the escrow is deployed paused, and its address, runtime code hash, constructor arguments, USDC, cap,
   owner and both signers are published and verifiable on chain;
2. contract ownership is held by a tested multisig, and opening requires its signature over reviewed calldata;
3. the evidence and access keys run in an auditable KMS or equivalent isolated signer, with least privilege,
   monitoring, rotation and an emergency procedure. This matters more than it did under zkTLS: the evidence
   key alone can now create completions;
4. an independent security review covers the escrow, the attestation signer, and the OAuth token boundary;
5. Strava's developer terms are clarified in writing. Strava reserves the right to revoke applications that
   enable virtual races or competitions, and Lock In is a competition with real stakes. This is unresolved;
6. two controlled wallets, on two distinct Strava accounts, complete create, join, check-in, settle and claim
   at 0.1 USDC, including gas, mobile-wallet handoff and rejection behaviour;
7. the same wallets pass handle uniqueness/change/clear, invite routing, score deduplication, high-five
   uniqueness, moderation, and settlement isolation;
8. disconnect and reconnect are exercised end to end, and the disconnect is confirmed to have revoked at
   Strava and deleted locally;
9. production health, source verification, addresses, privacy, rules, monitoring and support are all green.

Until then, admission and check-ins stay paused and no one is invited to send real funds.
