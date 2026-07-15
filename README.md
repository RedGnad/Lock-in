# Lock In V4

**Your word. Locked in.** Create a small-stake pact with friends, check in on Monad, and let the contract settle the pool.

Lock In V4 is an invitation-only hackathon beta using real USDC on Monad mainnet. The contract caps each participant at **1 USDC per pact**. This is not a cumulative wallet cap: the same wallet can enter several pacts and expose more than 1 USDC in total. Network gas is separate and is never refunded by the pact.

## The proof, stated honestly

The only active V4 mission is a **Monad-native wallet check-in**.

For each eligible pact day, the joined wallet calls `checkIn(pactId, dayIndex)`. The contract proves only that:

- the caller is a joined wallet;
- the pact reached its required participant count;
- the transaction concerns the current pact day;
- that wallet has not already checked in for that pact and day.

The transaction can be sent manually or automated by software. It does **not** prove who controlled the wallet, exercise, learning, attendance, location, a social post, or any other physical or mental activity. Product copy and support must never imply otherwise.

Strava and Reclaim experiments remain in the repository as V3 development history, but they are not an active V4 mission and do not decide V4 completion. No Twitter/X, Duolingo, step-count, or other external-provider challenge is active.

## Product model

The consumer interface offers fixed 3, 7, 14, and 30-day templates. Every pact publishes its duration, required number of check-ins, minimum participant count, start time, equal stake, mission type, and configuration hash before joining closes.

During each fixed 24-hour pact day, a participant can record at most one native check-in. Early, late, duplicate, outsider, and underfilled-pact submissions revert. The check-in event contains the wallet, pact, day, a deterministic event identifier, and the block timestamp.

Settlement is permissionless after the pact ends:

- with one or more finishers, finishers recover their stakes and split the non-finishers' stakes equally through the final pool calculation;
- if everyone finishes, everyone receives their stake back;
- if nobody finishes, every participant can recover their stake;
- underfilled and cancelled pacts refund every participant;
- each eligible wallet must claim its own payout and pay the associated gas.

See [`docs/product-model-v4.md`](docs/product-model-v4.md) for the exact semantics, examples, threat model, and admission rules for future missions.

## Contract and operational controls

[`contracts/LockInEscrowV4.sol`](contracts/LockInEscrowV4.sol) is a fixed-token social escrow for Monad-native check-ins. Its main invariants are:

- native Monad USDC with six decimals;
- immutable 1,000,000 atomic-unit maximum stake;
- durations from 3 to 30 days;
- 2 to 100 required participants;
- one completion per wallet, pact, and day;
- no protocol fee or operator withdrawal path;
- permissionless finalization and self-service claims;
- creator cancellation only before the start;
- owner emergency cancellation only into the participant-refund path.

The active V4 deployment is `0xF41AD662Af2240b387eCC96eC1Faafe6c3Ae9DF4` on Monad mainnet (deployment block `87810767`). Its source, compiler configuration, dependencies, bytecode, and constructor argument have a Sourcify `exact_match`. The official Circle USDC token is `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`.

The owner can pause contract creation, joining, and check-ins separately. Server-side `NEW_PACTS_ENABLED`, `JOIN_ENABLED`, and `CHECK_INS_ENABLED` flags add a fail-closed product gate. A website flag does not stop direct contract calls, so incidents may require the matching onchain pause. Settlement and claims deliberately have no product shutdown flag.

The V4 contract has **not received an independent security audit**. Tests reduce known implementation risk but cannot eliminate smart-contract, wallet, token, RPC, or chain failure. The private beta, adult-only rule, low cap, and absence of a protocol fee do not guarantee legality, regulatory approval, reimbursement, or an exemption in any jurisdiction. Nothing in this repository is legal advice.

## Privacy model

V4 has no product user account, activity profile, or external-service credential flow. It does not request health, fitness, GPS, learning, social-media, or biometric data.

Monad still makes the financial and participation graph public. Wallet addresses, pact configuration and membership, stake and transfer amounts, day indexes, event identifiers, timestamps, cancellations, settlement, claims, transaction hashes, and block metadata are public and effectively permanent. The contract stores a configuration hash rather than raw mission/profile content.

The web app does not maintain a product user database. Hosting, RPC, wallet, explorer, email, and any later-disclosed analytics provider may retain ordinary technical logs under their own policies. Read [`PRIVACY.md`](PRIVACY.md) and the in-product `/privacy` notice before inviting testers.

## Local development

Requirements: Node.js 22+, pnpm 10+, Foundry, and a Monad mainnet RPC for chain checks.

```bash
cp .env.example .env
pnpm install
pnpm exec tsc --noEmit --incremental false
pnpm test
pnpm build
```

The V4 environment starts closed:

```dotenv
NEW_PACTS_ENABLED=false
JOIN_ENABLED=false
CHECK_INS_ENABLED=false
```

Configure `NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS` only with the verified V4 deployment. Never reuse the V3 escrow address. Keep deployer keys out of Vercel and never expose secrets through a `NEXT_PUBLIC_` variable.

`/api/health` is the release gate for the web app. It checks chain ID 143, V4 bytecode and version, native Monad USDC, the immutable 1 USDC cap, contract pause state, explicit product-flag configuration, and privacy contact. It returns effective actions without returning environment values, private RPC URLs, or secrets.

## Private-beta release gate

Do not accept a real-funds tester until all items below are complete:

1. Typecheck, policy tests, Solidity tests, and the production build pass from the release commit.
2. V4 source and constructor arguments are verified on a public explorer.
3. Two internal wallets complete create, join, every required check-in, finalization, and claims with 0.1 USDC.
4. A separate rehearsal verifies underfilled cancellation and full participant refunds.
5. Rules, privacy, support email, contract/token addresses, and explorer links match production.
6. `/api/health` monitoring and an at-risk-pact ledger are active.
7. The owner wallet can execute a narrowly scoped emergency cancellation and the team has rehearsed the incident procedure.
8. Every invited adult understands that the check-in is automatable, proves no offchain activity, uses real funds, and incurs non-refundable gas.

Use [`docs/tester-runbook.md`](docs/tester-runbook.md) for controlled opening, pause decisions, monitoring, incident response, settlement, refunds, and cohort closure. Rules are in [`app/rules/page.tsx`](app/rules/page.tsx); the support/privacy contact is **mookipstore@hotmail.com**.

## Repository map

- `contracts/LockInEscrowV4.sol` — active V4 escrow semantics.
- `src/lock-in-abi.ts` — consumer ABI and Monad configuration.
- `src/missions.ts` — fixed V4 pact templates.
- `src/product-flags.ts` — fail-closed web action gates.
- `app/api/health/route.ts` — non-secret production readiness signal.
- `docs/product-model-v4.md` — product guarantees and non-guarantees.
- `docs/tester-runbook.md` — real-funds private-beta operations.
- `scripts/cancel-v4-pact.ts` — simulated, explicit-confirmation incident refund procedure.
- `PRIVACY.md` — complete privacy notice.

Legacy V3 contracts, provider recipes, scripts, API routes, fixtures, and tests are retained only for audit history and regression work. Their presence in the repository is not a claim that their missions are available in V4.
