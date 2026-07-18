# Lock In

**Stake on your goals. Finishers split the pool.** Friends stake USDC on a measurable goal, prove their
progress, and whoever finishes recovers their stake and splits the stakes of whoever quit. Settlement is on
Monad mainnet, permissionless and impartial.

Lock In runs two missions from one app:

- **Strava run** — daily GPS runs, verified through Strava's official API over your OAuth grant. Scheme
  `STRAVA_OAUTH_V1`. This is the primary, lowest-friction experience.
- **Duolingo XP** — a cumulative XP delta between a baseline proof and a final proof, verified with Reclaim
  **zkTLS** because Duolingo has no suitable public API. Scheme `DUOLINGO_ZKTLS_DELTA_V1`. Labelled `BETA`
  because the Reclaim proof window is more frictional; the stakes and economics are identical to Strava.

Small-cohort, adult-only. **Unaudited.** The trust model below is not marketing copy: read it before staking.

## How it works

**Strava.** Connect Strava once through its consent screen. Create or join a Lock (distance, days, crew,
stake). Run, then check in with one tap; Lock In reads the run and publishes the day on Monad.

**Duolingo.** Enter your Duolingo username. Prove your starting XP in a Reclaim window (baseline), stake, and
create or join a Lock. Earn the target XP before the deadline, prove your final XP, and the delta settles the
Lock. A cumulative total before a deadline, never a daily streak.

Both share the same create / join / invite / pool / settle / claim flow and the same stakes: **0.1 / 0.5 /
1 USDC** per participant.

## Verification, and what you are trusting

A Strava day counts when the run is a GPS **Run**, started inside that day of the Lock, reaching the distance
target, not manual, not on a treadmill, not flagged, with plausible motion; one run counts once, ever, and
one Strava account backs one participant per Lock. A Duolingo Lock finishes when the backend attests the XP
earned between the immutable baseline and the final proof clears the target; one Duolingo account backs one
participant per Lock, and each proof is single-use.

Both schemes converge on **one EIP-712 attestation** signed by a per-mission **evidence signer**, which the
escrow accepts as sufficient.

> **The evidence signer is a trusted party.** A stolen signing key can mint completions that never happened.
> The Strava (`STRAVA_OAUTH_V1`) and Duolingo (`DUOLINGO_ZKTLS_DELTA_V1`) signers are distinct keys, distinct
> from each other and from the Safe owner. For Duolingo, the contract verifies only the ECDSA recovery to the
> signer; there is no independent on-chain re-verification of the Reclaim proof. This is documented in
> [`docs/duolingo-escrow-security-review.md`](docs/duolingo-escrow-security-review.md).

Verification proves what an external service returned, not the underlying human activity. GPS spoofing,
account sharing, bots, imported progress, modified clients and upstream errors remain possible. No consumer
data source makes cheating impossible; Lock In never claims otherwise.

## Settlement

Fixed target, fixed crew, fixed stake (0.1–1 USDC). Registration closes at the published start. Monad gas is
separate.

- if some finish, finishers recover their stakes and split the stakes of those who did not;
- if everyone or nobody finishes, each participant recovers their own stake;
- underfilled and cancelled Locks refund everyone;
- a completion pause overlapping a live Lock cancels it and refunds;
- settlement and claims stay permissionless even while admission or completion are paused;
- no protocol fee, no operator withdrawal path.

The pool splits with no dust: `remainingPool / claimsRemaining` decremented per claim, the last claimant
taking the remainder (`test/LockInDuolingoEscrow.t.sol:testMultipleFinishersSplitPoolWithoutDust`).

## Contracts and addresses (Monad mainnet, chain 143)

Two independent escrows. They share no storage and never call each other; a shared stake token and Safe owner
are the only common ground.

| | Strava escrow (A) | Duolingo escrow (B) |
|---|---|---|
| Contract | `contracts/LockInEscrow.sol` | `contracts/LockInDuolingoEscrow.sol` |
| Address | `0xD37121112F240fE03a18D754B2fdB9dC750034d4` | `0x385aee4ccE319077AeE2B3369A73Ea7f27EE2386` |
| Scheme | `STRAVA_OAUTH_V1` | `DUOLINGO_ZKTLS_DELTA_V1` |
| Runtime code hash | `0x50c65525ac451c96b0dd9128e105d9e55080f1fbc8b73d9601dfc07100b8adf8` | `0x00a132f1b9abc8b3ff32e73b9cc2675ad9271304718d8bf9e51a035c81d0db8b` |
| Deployment tx | `0xa3e978e1456a8fe15e06249d4f689b38a5afc454681628feb759ee05900a0a31` | `0xa814b5b32117b827c33faad8c9b60a0cb6b2be83b461cf81a2120cbffcb217a0` |
| Ownership transfer tx | `0xd15d376cf818fd93a7661fe8e1792593e05ba013eb731b8abb2aba2bd67cd8eb` | `0xc4dcdba32085eba87f5ac6b6ce5a28f6bf425d8c00599c06677a258227096b2f` |
| Evidence signer | `0x4a06010d269b335c3471dA9AABfc41a56b4ea1f6` | `0x57E81089f6DC6c68291b78F90b626c1AA546eAC7` |
| Access signer | `0x8a63E4828F3B35C12FC23d644C80DA67aF1EA304` | — (n/a) |

- **Owner:** `0xf1be884698B9Ba4438f529699eC92320427b4dA1` — Safe 2/2 (owners `0x3444…897E6`, `0x79C5…1e45`),
  owner of both escrows.
- **Stake token:** `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` — canonical USDC on Monad (6 decimals).
- **App:** https://lock-in-liart-theta.vercel.app
- Escrow B pins its evidence signer in source (`PINNED_DUOLINGO_EVIDENCE_SIGNER`); the release gate
  (`pnpm gate:duolingo`) asserts the deployed signer, code hash, USDC, stake bounds, EIP-712 parity, owner and
  pauses on chain. Read back in full: [`deployments/monad-mainnet-oauth.json`](deployments/monad-mainnet-oauth.json).

## Real proofs

Every hash is verifiable on Monad. Rows marked *canary* are the two-wallet, minimum-stake rehearsal
(0.1 USDC each, 50 XP, 90 min); they are filled as the canary lands.

| Mission | Event | Tx | Notes |
|---|---|---|---|
| Strava | Escrow A deploy | `0xa3e978e1456a8fe15e06249d4f689b38a5afc454681628feb759ee05900a0a31` | block 88203155 |
| Strava | Lock #1 day 1 check-in | `0x1005fbbec2c21d87097e76e40cc7860fadc613f3b544b78a5eead2c21009fbe7` | first verified day, atomic OAuth refresh |
| Duolingo | Escrow B deploy (paused) | `0xa814b5b32117b827c33faad8c9b60a0cb6b2be83b461cf81a2120cbffcb217a0` | block 88449401 |
| Duolingo | Ownership → Safe | `0xc4dcdba32085eba87f5ac6b6ce5a28f6bf425d8c00599c06677a258227096b2f` | 3 pauses opened later by Safe |
| Duolingo | Create (canary) | _pending_ | createPact + baseline |
| Duolingo | Join (canary) | _pending_ | joinPact + baseline |
| Duolingo | Final (canary) | _pending_ | submitFinal, target reached |
| Duolingo | Settle (canary) | _pending_ | finalizePact |
| Duolingo | Claim (canary) | _pending_ | payout to the finisher |

## Test the product (short)

1. Open the app, connect a wallet on Monad mainnet, and connect Strava once (single consent). Both flows
   require a wallet-auth signature, folded into the first action.
2. **Strava:** create a Lock (distance, days, stake), share the invite, have a second wallet join, then check
   in a qualifying run. Settle after the deadline and claim.
3. **Duolingo:** pick Duolingo XP in the mission selector, set target/duration/crew/stake, prove your starting
   XP in the Reclaim window, stake and create. A second wallet joins via the invite. Earn the XP, verify the
   final, then settle and claim after the deadline.
4. Health: `GET /api/health` (Strava) and `GET /api/duolingo/health` (financial escrow) report the active mode
   and configuration.

Access is gated by wallet allowlists per mission; a slow Reclaim login never trips the rate limiter (the poll
answers `202` until the proof is ready and uses a polling budget, not the verification budget).

## Local development

Node.js 22+, pnpm 10+, Foundry, a Monad RPC, a Strava API application, and a Postgres database.

```bash
cp .env.example .env
pnpm install
pnpm db:migrate           # Strava connection tables
pnpm db:migrate:escrow    # Duolingo financial tables (dedicated Neon; never the Strava DB)
pnpm exec tsc --noEmit
pnpm test                 # TypeScript policy + Solidity (184 TS, 80 Solidity)
pnpm build
```

Server-only configuration includes, per mission: `STRAVA_CLIENT_ID/SECRET`, `STRAVA_TOKEN_ENCRYPTION_KEY`,
`EVIDENCE_SIGNER_PRIVATE_KEY`, `ACCESS_SIGNER_PRIVATE_KEY` for Strava; `DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY`,
`DUOLINGO_IDENTITY_HMAC_KEY`, `DUOLINGO_ESCROW_DATABASE_URL`, `DUOLINGO_ESCROW_ALLOWED_WALLETS`,
`NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS` for Duolingo; plus `DATABASE_URL`, `SESSION_SIGNING_SECRET`, `ID`,
`SECRET` (Reclaim). Secrets never reach the browser; only the public escrow addresses and signer address do.

Operational scripts (dry-run by default, `--execute` plus a confirmation string to write):
`pnpm deploy:escrow`, `pnpm deploy:duolingo`, `pnpm gate:duolingo`, `pnpm safe:duolingo` (Safe pause-open
batch), `pnpm production:check`. Owner actions are multisig operations over printed, reviewable calldata.

## Repository map

- `contracts/LockInEscrow.sol` — Strava escrow: stakes, settlement, claims, nullifiers, pauses.
- `contracts/LockInDuolingoEscrow.sol` — Duolingo escrow: baseline at create/join, one final, XP-delta finish.
- `src/duolingo-attestation.ts` — EIP-712 baseline/final attestations, config hash, HMAC identity (pinned to Solidity).
- `src/duolingo-escrow-{attestation,chain,store,client,config,access}.ts` — the financial evidence signer, on-chain reads, Neon store, client helpers.
- `app/api/duolingo/escrow/{session,verify}` — open a Reclaim session and mint the attestation for create/join/final.
- `src/strava-{oauth,token-store,activities}.ts`, `src/completion-attestation.ts`, `app/api/strava/*` — the Strava mission.
- `docs/duolingo-escrow-security-review.md` — the escrow B trust model and scenario-to-test map.
- `docs/product-model.md`, `docs/tester-runbook.md` — product and testing operations.

Privacy, incident and security contact: **mookipstore@hotmail.com**.
