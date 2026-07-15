# Lock In V4 security model

Lock In V4 is a small-stake, Monad-native social escrow. Its only active completion signal is an onchain wallet check-in. It does not use Strava, Reclaim, GPS, a social network, or a learning service to settle funds.

## What a check-in proves

The contract proves that the transaction sender is a joined wallet, the pact reached its minimum crew, the submitted day is the current pact day, and that wallet has not already checked in for that day. The wallet can check in once per eligible day until it reaches the published target.

A check-in can be automated. It does not prove identity, presence, exercise, learning, or any other offchain action. This limitation is shown in the transaction review and Rules; it must never be weakened in marketing or support.

## Fund safety properties

- The immutable stake cap is 1,000,000 atomic units of a six-decimal token: 1 USDC per participant per pact.
- Every participant in a pact deposits the same amount. The creator is auto-joined.
- New pacts require 3–30 days, 1–duration required completions, and 2–100 minimum participants.
- Registration closes at the exact start timestamp. Check-ins are accepted only in their strict 24-hour pact window; there is no early or retroactive completion.
- Settlement is permissionless. Eligible wallets claim their own payout; no operator can redirect it.
- Finishers split the entire pool. If there are no finishers, or the pact is underfilled or cancelled, every participant can reclaim the original stake.
- Rounding dust goes to the last eligible claimant. There is no protocol fee, admin withdrawal, or abandoned-funds sweep.
- The creator may cancel only before start. The owner may emergency-cancel an unfinalized pact only into the participant-refund path.
- Creation, joining, and check-ins have independent onchain pauses. Finalization and claims cannot be paused.

The website adds fail-closed flags for new pacts, joining, and check-ins. These flags are UX gates, not contract enforcement; an incident involving direct calls requires the corresponding onchain pause.

## Operational and residual risk

The contract is source-verified with a Sourcify exact match and has automated tests, but it has not received an independent security audit. Smart-contract bugs, compromised wallets, malicious approvals, RPC or chain outages, token behavior, operator mistakes, and undiscovered economic attacks remain possible.

The 1 USDC limit is per pact, not per wallet across all pacts. MON gas is separate and never refunded by the contract. The beta must remain invitation-only until the two-wallet success-path and underfilled/refund mainnet canaries in `docs/tester-runbook.md` are complete.

Before every release, verify from chain state that the configured contract reports V4, the official six-decimal Monad USDC address, the 1 USDC cap, and the expected pause state. Keep the deployer key out of Vercel. Never collect a seed phrase or private key in support.

## Reporting

Report a suspected vulnerability privately to **mookipstore@hotmail.com**. Include the affected contract or pact, transaction hash, UTC time, and impact. Do not include seed phrases, private keys, wallet exports, or private RPC credentials.
