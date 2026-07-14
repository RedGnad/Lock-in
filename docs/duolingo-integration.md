# Duolingo research gate

## Current decision

Duolingo is not a live Lock In mission and cannot be used for a money-bearing pact. Duolingo does not expose a supported public API for this use, and its [terms](https://www.duolingo.com/Terms) restrict automated extraction. Lock In will not publish a provider or activate an escrow until an official API or written permission makes the integration supportable.

The consumer UI does not render a disabled or coming-soon Duolingo card. There is no Duolingo provider owned by Lock In, API route, contract adapter, environment variable, or activation control in the product.

## Reclaim registry audit

The active Reclaim registry was checked on July 15, 2026 through the authenticated Reclaim MCP. Fourteen entries match Duolingo; all are approved community entries but none is marked verified. The most relevant expose cumulative `totalXp`, `streakData`, or a profile id. They do not prove an authenticated self identity, a lesson/event id and a server completion time together.

The public XP providers accept a user id in the request URL without proving that it belongs to the logged-in account. Because Duolingo profiles expose progress statistics, this can let one account target another public profile. A cumulative XP delta also cannot identify when or how the XP was earned. Those providers are therefore unsuitable for settlement and were not connected to the escrow.

## What a future proof could establish

If the permission gate is cleared, Reclaim could prove that Duolingo credited activity to an authenticated account. It could not prove that a person learned without automation, account sharing, or outside help. Product wording must therefore say “Duolingo credited progress,” never “you learned.”

A streak alone is insufficient because it can be protected or repaired. A final XP total alone does not show when XP was earned. A future adapter would need:

1. A fresh authenticated baseline bound to the wallet and pact.
2. A fresh final state from the same Duolingo account.
3. Active-day evidence or a capped progression threshold inside the pact window.
4. Account commitments and proof nullifiers that prevent replay and multi-wallet reuse within a pool.

Raw XP must never be used as a competitive ranking because earning rates differ by exercise, bonuses, and product mechanics.

## Research-only technical candidates

Authenticated responses for the current user and daily XP summaries may be technically observable, but they are internal endpoints rather than a supported developer contract. They may be inspected only in a non-monetary research environment after confirming that the test complies with platform rules. No credentials, cookies, tokens, email addresses, or unnecessary profile fields may be retained.

## Activation checklist

1. Obtain a supported API or written permission.
2. Complete a privacy and legal review, including the fact that Duolingo serves minors while Lock In money modes are 18+.
3. Capture the minimum authenticated fields and prove that account A cannot submit account B’s data.
4. Publish and pin a separate provider and adapter; never weaken the Strava verifier to accommodate it.
5. Test replay, wrong-account, stale-state, baseline/final mixing, bot-like progression, cancellation, and refund paths.
6. Update the privacy policy and rules before any public activation.
