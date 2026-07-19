# Mainnet evidence

Every hash below is a confirmed, verifiable Monad mainnet (chain 143) transaction. Contract addresses are
in the [README](../README.md#contracts-and-addresses-monad-mainnet-chain-143). Nothing here is simulated or
pending: rows are only added once the transaction is mined and its receipt read back on chain.

## Contracts

| | Address | Deploy tx | Block |
|---|---|---|---|
| Strava escrow (A) | `0xD37121112F240fE03a18D754B2fdB9dC750034d4` | `0xa3e978e1456a8fe15e06249d4f689b38a5afc454681628feb759ee05900a0a31` | 88203155 |
| Duolingo escrow (B) | `0x385aee4ccE319077AeE2B3369A73Ea7f27EE2386` | `0xa814b5b32117b827c33faad8c9b60a0cb6b2be83b461cf81a2120cbffcb217a0` | 88449401 |

Ownership of escrow B was transferred to the Safe 2/2 (`0xf1be884698B9Ba4438f529699eC92320427b4dA1`) in
`0xc4dcdba32085eba87f5ac6b6ce5a28f6bf425d8c00599c06677a258227096b2f`; the Safe later opened the three pauses.

## Strava canary, Lock #1

A real two-wallet canary on escrow A. One participant (`0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45`) ran on
three separate days and reached the target on chain. The Lock's on-chain configuration is
`requiredCompletions = 3`, `durationDays = 3`, `missionType = 1` (Strava run): three runs across three days.

| Day | Tx | dayIndex | Block | completionCount | Result |
|---|---|---|---|---|---|
| D1 | `0x1005fbbec2c21d87097e76e40cc7860fadc613f3b544b78a5eead2c21009fbe7` | 0 | 88374137 | 0 -> 1 | verified, atomic OAuth refresh |
| D2 | `0x57135b6e3531a02f5424d7fc5ae81acfbfc6ac2f8f426001fd762793345d9f0f` | 1 | 88663733 | 1 -> 2 | verified, fresh activity nullifier |
| D3 | `0x1625cb65a13fbef7dda359937a0357f1fef416ca428939a4cc2281d82270a383` | 2 | 88772488 | 2 -> 3 | 3 of 3 required runs, TARGET MET |

All three completions are the same wallet, `0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45`. After D3 the wallet's
final on-chain state on Lock #1 is:

- `completionCount = 3`
- `completionBitmap = 7` (binary `111`: days 0, 1 and 2 all set)
- `finisherCount = 1` (the wallet became a finisher exactly at `completionCount == requiredCompletions`)

The contract accepts no further completion from that wallet: `LockInEscrow.sol` reverts `TargetAlreadyMet`
once `completionCount >= requiredCompletions`. So D1, D2 and D3 are correct and expected for a Lock that
requires three runs; there is no divergence between the deployed contract and the model.

## Duolingo Beta, Lock #1

Escrow B is live and a real Lock was created on mainnet with a real zkTLS baseline proof.

| Event | Tx | Block | Notes |
|---|---|---|---|
| Lock #1 create + baseline | `0xa87bbeb8e612aa4c1b29e538c9ef0f1f9fcdfd1df6bf6c1021a0c47f2daebcee` | 88538934 | createPact, real zkTLS baseline for `0x79C5...1e45` |

**Beta status, stated honestly.** The full two-wallet lifecycle (a second participant joining, a final proof
clearing the target, settlement and payout) has **not** been exercised end to end on mainnet yet, so Duolingo
ships as `BETA`. Duolingo Lock #1 stayed at one participant (underfilled), which by the escrow's rules means
every participant can reclaim their full stake; that refund path is available to its wallet at any time. This
is a Beta limitation, not a pending or promised proof.
