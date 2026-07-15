# Duolingo V5 integration

## Current decision

V5 supports Duolingo as an experimental hackathon mission next to Strava. It does not trust a username alone. Before staking, the user places a wallet-derived 128-bit `LI-<32 HEX>` code in the Duolingo bio. One Reclaim proof must expose the stable profile id, username, exact bio code, and cumulative `totalXp` from the same HTTPS response. The fresh XP baseline and the USDC stake are accepted atomically.

The integration remains independent and unofficial. The private provider is published and pinned. Its captured request and anonymous replay succeeded, as expected for this public endpoint. Production stays paused until full live ownership, negative, baseline, delta, and replay canaries pass end to end.

## Reclaim registry audit

The active Reclaim registry was checked on July 15, 2026 through the authenticated Reclaim MCP. Fourteen entries match Duolingo; all are approved community entries but none is marked verified. The most relevant expose cumulative `totalXp`, `streakData`, or a profile id. They do not prove an authenticated self identity, a lesson/event id and a server completion time together.

The public XP providers accept a user id in the request URL without proving account ownership. The inspected provider `7c57a498-6b0e-4b3a-8235-de7ba938e823` extracts only `totalXp`; a user can target somebody else&apos;s profile. V5 does not use it. The Lock In provider closes that attack by requiring the wallet code in the same profile response and by binding the stable id to one wallet per pact.

## What the proof establishes

Reclaim can prove that Duolingo returned the wallet code and credited progress to that profile. It cannot prove that a person learned without automation, account sharing, or outside help. Product wording therefore says “new Duolingo XP,” never “you learned.”

A streak is never accepted. V5 requires:

1. A fresh ownership-coded baseline bound to wallet and pact before stake transfer.
2. A fresh current-day snapshot from the same stable profile identity.
3. `current totalXp - max(pact baseline, globally consumed totalXp) >= daily target`.
4. Global snapshot nullifiers and one profile per wallet within a pact.

Raw XP must never be used as a competitive ranking because earning rates differ by exercise, bonuses, and product mechanics.

## Data and privacy

The proof uses the public profile response and does not need a Duolingo password or cookie inside Reclaim. The server processes id, username, bio, total XP, proof time, wallet, pact and phase without a product database. Cumulative XP, wallet, hashed profile identity, metric and nullifier are public on Monad; username, raw id and bio are not written onchain.

## Activation checklist

1. Confirm the published `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.0` provider and pinned request hash match production.
2. Pass live ownership, wrong-profile, wrong-bio, stale proof, baseline/final mixing, XP delta and replay tests.
3. Complete an independent contract/security review; V5 is currently unaudited.
4. Confirm private beta eligibility and 18+ messaging before enabling funds.
