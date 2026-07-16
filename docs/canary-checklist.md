# Canary checklist

One phone, two browser profiles, two wallets, two Strava accounts. Wallet A creates and finishes, wallet B
joins and does not. Stake `0.1 USDC` each. Real money, paused-by-default escrow, Monad mainnet.

Escrow `0xD37121112F240fE03a18D754B2fdB9dC750034d4`, owner Safe `0xf1be884698B9Ba4438f529699eC92320427b4dA1` (2/2).

## The two constraints that decide the schedule

**A three-day Lock needs three runs.** The only template the UI offers at three days is Quickfire, which is
three completions out of three days. One run makes A a non-finisher, and a Lock where nobody finishes
refunds everyone. If A runs once, A does not take the pot: each wallet just gets its own `0.1` back.

**Completion cannot be closed while the Lock is live.** `finalizePact` refunds every participant, finishers
included, if a completion pause overlaps `[startsAt, submissionDeadline)`. So the completion pause is
opened once, before the Lock starts, and stays open until settlement. Both facts are pinned in
`test/LockInEscrowRelease.t.sol`.

Settlement is therefore `startsAt + 3 days + 24h grace`, and it cannot be shortened without redeploying.

## Before any Safe transaction

- [ ] `/api/health` fully green, `mode: paused`, all three pauses `true`.
- [ ] Both wallets connected to Strava in their own browser profile, persistence confirmed after refresh.
- [ ] `pnpm strava:connections` shows two rows, two distinct athletes, both tokens as `v1` envelopes.
- [ ] Disconnect, deletion and reconnect exercised on at least one wallet.
- [ ] `CANARY_WALLET_A` / `CANARY_WALLET_B` set, `pnpm canary:preflight` green.
- [ ] `CANARY_ALLOWED_WALLETS` in production holds exactly those two addresses. This, not the pause, is what
      keeps the public out once creation is open: no other wallet can obtain an admission attestation.
- [ ] Both wallets hold MON for gas and at least `0.2 USDC`.

## Safe transactions, in opening order

`pnpm exec tsx scripts/set-pauses.ts <creation> <joining> <completion>` prints the calldata; it never holds a key.

| # | Call | Target state | Why this order |
|---|---|---|---|
| 1 | `setCompletionPaused(false)` | completion open | Opens first and stays open. A Lock must never exist while check-ins are shut. |
| 2 | `setJoiningPaused(false)` | joining open | Meaningless before completion works. |
| 3 | `setCreationPaused(false)` | creation open | Last: it is the only call that lets a stranger stake into an unaudited escrow. |

Then `pnpm exec tsx scripts/set-pauses.ts --verify false false false`, and Vercel flags set to `true/true/true` and redeployed, or
`/api/health` fails `flagPauseAlignment` and answers 503.

Close creation and joining (`true true false`) as soon as B has joined. Leave completion open.

## create — wallet A

| | |
|---|---|
| Transactions | `approve(escrow, 100000)` then `createPact(...)` |
| Arguments | stake `100000`, target `1000` m, 3 days, 3 required, min 2, max 2, `startsAt` within 3h, mission `1` |
| Expect | `PactCreated`, `nextPactId` advances by exactly 1, escrow USDC `+0.1` |
| Record | pact ID, both hashes, gas, the `LOCK-…` invite code |
| Fails if | `startsAt` more than 3h out (`InvalidSchedule`), or admission attestation older than 10 min |

- [ ] Invite code resolves to the created Lock ID.
- [ ] `pnpm exec tsx scripts/canary.ts snapshot --pact <id>` shows 1 participant, not finalized, not cancelled.

## join — wallet B

Before `startsAt`. `joinPact` reverts at the start time.

| | |
|---|---|
| Transactions | `approve(escrow, 100000)` then `joinPact(pactId, access)` |
| Expect | `PactJoined`, `participantCount == 2`, escrow USDC `+0.1` → `0.2` total |
| Fails if | after `startsAt` (`JoinClosed`), or B reuses A's Strava identity |

- [ ] An altered invite checksum is rejected.
- [ ] Close creation and joining now: Safe `setCreationPaused(true)`, `setJoiningPaused(true)`.

## submitCompletion — wallet A, once per day, three days

Day `d` runs from `startsAt + d*24h` to `+24h`. A real GPS run of at least 1 km, outdoors, not manual, not a
treadmill, inside that day. Submission stays open for that day plus 24h.

| | |
|---|---|
| Transaction | `submitCompletion(pactId, dayIndex, evidence)` |
| Expect | `CompletionAccepted`, `completionCount(pactId, A)` = 1, then 2, then 3 |
| After day 3 | `isFinisher(pactId, A) == true`, `finisherCount == 1` |
| Record | calldata bytes, gas estimate, receipt gas, wallet handoff behaviour |

- [ ] Day 1: `completionCount == 1`, `lockScore(A) == 10`.
- [ ] Day 2: `completionCount == 2`.
- [ ] Day 3: `completionCount == 3`, `isFinisher(A)` true, `isFinisher(B)` false.
- [ ] Published calldata carries no raw Strava ID and no route.
- [ ] Completion was never paused across these days.

Safe negative check, once: B tries to check in with A's Strava account. Expect a refusal, not a revert on
chain, and `missionIdentityOwner` unchanged.

## finalize — anyone, at `startsAt + 4 days`

| | |
|---|---|
| Transaction | `finalizePact(pactId)` |
| Expect | `PactFinalized(pactId, remainingPool = 200000, eligibleClaimants = 1, finisherCount = 1, cancelled = false)` |
| Fails if | called before the deadline (`FinalizationTooEarly`) |

- [ ] **`cancelled == false`.** `true` means a completion pause overlapped the Lock and everyone is being
      refunded instead: the canary's payout claim is then unproven, whatever the UI shows.

## claim

| | |
|---|---|
| Wallet A | `claim(pactId)` returns `200000` (`0.2 USDC`): its own stake plus B's |
| Wallet B | `claim(pactId)` reverts. Do not spend gas proving this on chain; `testOnlyFinisherTakesTheWholePot` covers it |

- [ ] A's USDC balance `+0.2`, escrow balance back to `0`.
- [ ] `CANARY_EXPECTED_PACT_IDS=<id> pnpm canary:reconcile` reconciles to zero remaining liability.
- [ ] Close completion on the Safe: `setCompletionPaused(true)`, and set the Vercel flags back to `false`.

## After

- [ ] Every transaction hash, gas cost and UTC time recorded outside Git.
- [ ] Disconnect/reconnect retested after settlement.
- [ ] Video recorded.

No Duolingo work until every box above is ticked.
