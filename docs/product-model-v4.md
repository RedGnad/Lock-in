# Lock In V4 — product model and proof boundaries

Status: V4 release specification for the private, invitation-only Monad mainnet beta. Updated July 15, 2026.

## Product in one sentence

Friends put the same small USDC stake into a time-boxed pact; wallets that record enough valid Monad check-ins split the final pool according to the contract.

This is social, stake-backed accountability. It is not currently proof of the real-world promise participants may discuss among themselves.

## The active mission

V4 supports exactly one mission type: `MONAD_CHECK_IN_MISSION_KEY`, version 1.

A valid completion is a successful `checkIn(pactId, dayIndex)` transaction where:

1. `msg.sender` previously joined the pact;
2. the pact reached its published minimum participant count;
3. the pact is active and check-ins are not paused;
4. `dayIndex` belongs to the pact and the current block timestamp is inside that exact 24-hour window;
5. the wallet has not completed that pact day before;
6. the wallet/pact/day event identifier has not been used.

The contract stores a completion bitmap and count, then emits the pact, wallet, day index, deterministic event identifier, and block timestamp.

### What it proves

It proves that a transaction authorized by the participating wallet was included on Monad under the contract's timing and uniqueness rules.

### What it does not prove

It does not prove:

- that a human personally submitted the transaction;
- who controlled the wallet at that moment;
- physical exercise, movement, location, attendance, sleep, study, language learning, or focus;
- a Strava activity, social post, step count, app action, or external account;
- effort, honesty, uniqueness of a person, or resistance to multiple wallets.

Wallet software, a bot, a scheduled job, delegated access, or any other authorized automation can submit the check-in. A participant can control several wallets. These are properties of the active mission, not edge cases that marketing may omit.

The optional `missionConfigHash` commits to display metadata but the V4 contract does not know its preimage and does not verify that the label describes an event in the world.

## Pact parameters

The contract accepts:

| Parameter | V4 rule |
| --- | --- |
| Stake | More than 0 and no more than 1 USDC per participant per pact |
| Duration | 3–30 consecutive 24-hour periods anchored to `startsAt` |
| Target | 1 through `durationDays` successful check-ins |
| Minimum participants | 2–100 |
| Maximum joined wallets | 100 |
| Registration | Open before `startsAt`; closed at and after it |
| Daily credit | At most one check-in per wallet, pact, and day |

The consumer templates are 3/3, 5/7, 10/14, and 20/30 check-ins. They are interface defaults, not separate pools or ranked leagues. Each created pact is its own pool and everyone in that pact receives the same terms.

The 1 USDC limit is not a global wallet limit. Joining five 1 USDC pacts exposes 5 USDC, plus gas. The interface, rules, and support must describe the cap as **per participant, per pact**.

## State and timing

```text
registration ── startsAt ── active daily windows ── end ── finalized ── claimed
      │                         │                      │
      ├─ creator cancel ────────┴──────────────────────┤
      └─ underfilled at start → cancelled/refundable  │
                         owner emergency cancel ───────┘
```

- The creator can cancel only before the start.
- Anyone can finalize an underfilled pact at or after its start; it enters the refund path.
- Anyone can finalize a filled pact after its full duration.
- The owner can cancel an unsettled pact as an emergency action. This cannot redirect the pool: it makes participants eligible for refunds after finalization.
- Creation, joining, and check-ins have independent onchain pauses.
- Finalization and claim remain permissionless and unpaused so an incident switch cannot intentionally hide the exit path.

Web flags are a second, fail-closed interface layer. They do not stop a user from calling an unpaused public contract directly.

## Pool settlement

Every joined wallet deposits the same stake. Lock In currently takes no protocol fee.

If at least one wallet reaches the target, only finishers are eligible and the complete pool is divided across them. Economically, each finisher receives its stake back plus an equal share of non-finishers' stakes. If everyone finishes, this reduces to a return of each stake.

If zero wallets reach the target, every participant is eligible for a refund of their stake. A cancelled or underfilled pact uses the same participant-refund outcome. This zero-finisher refund is deliberate: the product does not pay an operator or burn the pool when the accountability mechanism produces no winner.

Each eligible wallet submits its own claim transaction. Integer division is applied against the remaining pool and remaining claims, so the final eligible claimant can receive minor atomic-unit rounding dust. Gas is never part of the pool and is not refunded.

### Examples, before gas

| Participants | Stake each | Finishers | Contract outcome |
| ---: | ---: | ---: | --- |
| 2 | 0.50 USDC | 1 | The finisher claims 1.00 USDC; the non-finisher cannot claim |
| 4 | 0.25 USDC | 2 | Each finisher claims approximately 0.50 USDC |
| 4 | 0.25 USDC | 4 | Each participant gets 0.25 USDC back |
| 4 | 0.25 USDC | 0 | Each participant gets 0.25 USDC back |
| Underfilled | Any valid stake | N/A | Every joined wallet can recover its stake after finalization |

“Funded by those who quit” is acceptable campaign shorthand only when a pact has at least one finisher. Product explanations should use the exact terms “finishers split non-finishers' stakes; zero finishers are refunded.”

## Privacy model

V4 deliberately avoids external identity and activity providers. It creates no product user profile and requests no health, fitness, GPS, learning, social-media, or biometric data.

It is not anonymous. Public chain state exposes wallets, pact membership and configuration, USDC amounts and transfers, check-in days and events, timestamps, cancellations, finalization, claims, transaction hashes, and block metadata. Observers can correlate this graph with other wallet activity. The configuration hash must never be described as hiding or anonymizing the public wallet graph.

The web app reads wallet and public chain state. Infrastructure may produce normal request and RPC logs. Support should request only a public wallet, pact ID, transaction hash, UTC time, visible error, and wallet/browser name. It must never request a seed phrase, private key, export, reusable signature, or health/activity data.

## Threat model and honest positioning

The beta accepts these unresolved behaviors:

- fully automated or scheduled check-ins;
- one person using several wallets;
- wallet sharing or delegated wallet control;
- social coordination outside the app;
- users joining several pools to increase total exposure;
- public-chain and RPC availability affecting transaction inclusion;
- participants forgetting or being unable to claim;
- contract, wallet, token, chain, and operator-key risk.

V4 therefore tests social coordination, pact UX, escrow settlement, operational controls, and willingness to return. It does not validate anti-cheat for real-world missions. Success metrics must not count a check-in as a verified run, lesson, post, or human habit.

The contract is not independently audited. A private cohort, 18+ restriction, 1 USDC per-pact cap, and real-funds warning reduce exposure but do not create a legal exemption or guarantee suitability in a tester's jurisdiction. Product documentation is not legal advice.

## Admission gate for a future mission

No provider or mission appears in the consumer interface until a versioned specification answers all of the following:

1. **Claim:** What exact event does a completion assert?
2. **Source:** Which authenticated primary response or onchain event supplies it?
3. **Binding:** How are wallet, external account, pact, day, and event linked?
4. **Freshness:** Which timestamp is trusted and what window is accepted?
5. **Uniqueness:** How are replay, duplicate content, and reuse across pacts handled?
6. **Automation:** Can the source event be scheduled, botted, delegated, edited, or deleted? This must be disclosed, not hidden.
7. **Fields:** What data reaches the browser, server, verifier, contract, events, and calldata?
8. **Platform terms:** Is the intended API, scraping, proof, storage, and display permitted and operationally sustainable?
9. **Failure path:** What happens to active funds during API, verifier, account, moderation, or chain failure?
10. **Evidence:** Have positive, negative, adversarial, two-wallet, settlement, refund, and production-environment tests passed?

### Twitter/X post pacts: ruled out for funded missions

“Post at least X characters and tag @monad each day” is not active in V4 and must not be added to a money-bearing pact. X's Developer Policy says API-based services may not give or receive monetary or virtual compensation for Posts, follows, reposts, likes, comments, replies, or other X actions. A non-funded community prompt could be explored separately, but it cannot decide an escrow payout.

Even without money, a responsible specification would still need to define at minimum:

- how a wallet is bound to the intended X account without exposing credentials;
- whether replies, reposts, quotes, scheduled posts, API posts, and edited posts count;
- Unicode-aware character counting and whether a real account mention entity—not plain lookalike text—is required;
- creation-time and day-window rules from an authenticated source;
- one-time use of a post across wallets, days, and pacts;
- what happens when a post is deleted, made private, moderated, or unavailable after proof;
- explicit disclosure that the proof can establish platform state, not human authorship, effort, truth, or resistance to bots;
- X API access, rate limits, developer terms, privacy impact, and incident behavior.

A mission is differentiated by a useful, honest claim and reliable settlement—not by adding another logo to the selector.

## External-provider roadmap

### Strava: possible only through an authorized production integration

Strava is not technically impossible forever, but it is a legal/platform-permission gate rather than an engineering shortcut. Strava's developer site explicitly reserves the right to revoke API tokens for uses that enable virtual races or competitions. Its 2026 API Policy also prohibits scraping or automated extraction, requires consent, deletion and limited retention, and restricts disclosure of one user's Strava data to other users. The retired V3 private Reclaim provider therefore cannot be used for funded production.

A future Strava adapter requires the official OAuth/API path and prior written approval for Lock In's exact competition-and-payout model. It must support revocation and deletion, keep raw data offchain and short-lived, and publish only a versioned nullifier plus pass/fail. Even with approval it proves a Strava record rather than biological movement, so GPS spoofing, imported/manual sources, a borrowed device, and account sharing remain residual risks.

### Garmin Connect: preferred external fitness candidate

Garmin Connect is the strongest next service to investigate. Its official Activity API returns exercise data recorded by Garmin wearables and cycling computers; its Health API can provide device-sourced steps, heart rate, intensity minutes, sleep, and related metrics after user consent. The program is business-only, requires Garmin approval, uses OAuth 2.0, and a typical integration is documented as taking one to four weeks; commercial access to some metrics may involve fees.

Lock In should request approval for one narrow mission first: a Garmin-device activity or daily step threshold, excluding manual/imported records where the API exposes their origin. Raw route and health data remain offchain and short-lived. The verifier publishes only wallet, pact/day, provider version, a one-use event nullifier, occurred-at time, and pass/fail. Garmin makes cheating more expensive than an aggregator-only record, but a lent wearable, mechanical movement, compromised account, or sophisticated device spoof still prevents an “impossible to cheat” claim.

### Organizer-attested event attendance: useful partner lane

For Monad meetups and hackathons, a Luma-organized event can become a milestone mission when the organizer participates. Luma's official API is calendar-scoped, requires Luma Plus, and can retrieve event guests; the organizer must bind a guest to a wallet and perform the check-in. Lock In then verifies a signed, one-use attendance attestation rather than publishing the guest's email or ticket. This proves the organizer recorded attendance—not that the attendee stayed, participated, or resisted QR sharing/collusion.

## Private tester release criteria

Real-funds invitations stay closed until:

- source and constructor arguments are publicly verified;
- the complete test/build suite passes from the release commit;
- two internal wallets complete a 0.1 USDC success path;
- an independent rehearsal completes the underfilled/refund path;
- `/api/health` monitoring, action flags, onchain pauses, and the incident owner are ready;
- production Rules, Privacy, support contact, addresses, and explorer links match the release;
- every invited tester sees the check-in limitation, cumulative-exposure warning, real-funds warning, unaudited-contract warning, and non-refundable gas before the first value-moving transaction.

Operational steps and the pause/refund matrix are maintained in [`tester-runbook.md`](tester-runbook.md).
