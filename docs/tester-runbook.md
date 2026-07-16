# Lock In controlled-testing runbook

This runbook governs controlled testing on Monad mainnet before Lock In is released. Lock In is not open to participants. Every stake and gas fee is real, and the public app stays closed outside the short, monitored windows below.

Verification runs under `STRAVA_OAUTH_V1`: the server reads the athlete's activity through Strava's official API over their OAuth grant and signs the result. There is no independent on-chain witness, so the evidence signer is a trusted party. Read `docs/product-model.md` before operating any window.

## Required people, accounts and funds

- Two controlled wallets, wallet A and wallet B. Never place their private keys in this repository or in Vercel.
- Each wallet needs MON for gas and at least `0.2 USDC` of official Monad USDC: `0.1` for the main Lock, `0.1` held back so the refund rehearsals do not wait on a claim to recycle.
- Two distinct Strava accounts, each able to record a real GPS run of at least the Lock's target. One Strava identity cannot back both wallets in one Lock. Use dedicated canary accounts: their pseudonymised athlete, activity and run values, plus distance, times, elevation and activity start time, become permanent public calldata.
- The Strava application must have athlete capacity for both accounts at once. A single-athlete tier silently blocks the second connection.
- Two disposable Lock In handles. Their wallet link, changes, moderation events, scores and reactions stay public even after the handle is cleared.
- One operator watching contract events, production health and the transaction ledger throughout every open window.

Configure only public wallet addresses for the observer:

```bash
export CANARY_WALLET_A=0x...
export CANARY_WALLET_B=0x...
pnpm canary:preflight
```

`canary:preflight` exits nonzero when an input, balance, deployment invariant or paused production control is missing. It never reads a participant private key and never sends a transaction.

## Release checks

Before touching a pause control:

1. `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`, `forge build` and `git diff --check` pass.
2. `pnpm production:check` and the production `/api/health` are green with creation, joining and check-ins disabled. Health must report `tokenStorageReachable: true`; it asks the database rather than trusting its URL, because an unmigrated Neon fails the first check-in, which happens after the athlete has staked.
3. `pnpm canary:preflight` is green for both wallets.
4. The paused escrow has verified source and constructor data, and its address, runtime code hash, contract schema ID, mission policy hash, scheme hash, USDC, cap, evidence signer, access signer, multisig owner and all three pauses match `deployments/monad-mainnet-oauth.json`.
5. The evidence and access keys run on the reviewed production path, separated from each other and from the owner, and no funded key sits in Vercel. This carries more weight than it did under zkTLS: the evidence key alone can now mint completions.
6. Handle, invite, score, high-five and moderation tests pass, including one scoring wallet per mission identity without changing another wallet's payout.
7. Record the current `nextPactId`, escrow USDC balance, UTC time and operator.

## Pause-control safety

`pauses` is read-only by default and never requires an owner key. Arguments are, in order, creation, joining and completion.

```bash
pnpm pauses -- true true true
```

The output lists each zero-value call's exact destination, calldata and hash, and the gate refuses to print anything unless the escrow, chain, token, cap, scheme, mission policy, owner and both signers all verify on chain first. Review those fields independently, submit the ordered bundle through `LOCK_IN_OWNER_ADDRESS`, collect the multisig threshold, wait for every receipt, then verify the result without an owner key:

```bash
pnpm pauses:verify -- true true true
```

The script skips unchanged controls and places every closure before any opening. Local `--execute` is development compatibility only: it refuses a contract owner and must not be used for the release escrow.

Pause setters are separate transactions. Watch every receipt; never assume the three changes are atomic.

Use this ordering across systems:

- **Opening:** change the Vercel production flags, deploy that configuration, confirm the requested actions, then unpause only the necessary contract controls.
- **Closing:** pause the contract controls first, confirm receipts, then disable the Vercel flags and deploy the closed configuration.

Changing a Vercel environment variable does not change the running deployment. A production redeployment and a fresh `/api/health` read are required.

## Strava connection

Before any window, each wallet connects Strava once, through the production app:

1. The athlete signs in on Strava's own consent screen and grants `activity:read_all`. Lock In never sees the password.
2. Confirm `/api/strava/connection` reports the connection for that wallet and no other.
3. Confirm the two wallets resolve to two different athletes. If the second connection fails, check the application's athlete capacity before anything else.

The refresh token rotates on every refresh and is stored encrypted with AES-256-GCM. Nothing about the grant reaches the browser or the chain.

## Create window

Start with contract pauses `true / true / true` and Vercel flags all `false`.

1. Set Vercel production to `NEW_PACTS_ENABLED=true`, `JOIN_ENABLED=false`, `CHECK_INS_ENABLED=false`; deploy production.
2. Generate contract pauses `false / true / true`, inspect and execute the ordered calls through the multisig, then run `pnpm pauses:verify -- false true true`.
3. Wallet A creates one Strava Lock through the production UI at exactly `0.1 USDC` on the three-day template. Review the wallet calldata warning. Record the displayed `LOCK-…` invite code and confirm it resolves deterministically to the created on-chain Lock ID.
4. Record the pact ID and every approval and create transaction hash.
5. Immediately close the contract to `true / true / true`.
6. Set the Vercel flags back to `false`, redeploy, snapshot the pact and reconcile the escrow.

Only creation is open during this window. No unrelated or already-active Lock may exist during the exception. If `nextPactId` advances unexpectedly, close first and investigate every new Lock.

```bash
pnpm canary:status -- --pact 1
CANARY_EXPECTED_PACT_IDS=1 pnpm canary:reconcile
```

Replace the example ID with the recorded ID.

## Join window

Complete this before the published start. `joinPact` reverts once the start time passes.

1. Set Vercel production to `NEW_PACTS_ENABLED=false`, `JOIN_ENABLED=true`, `CHECK_INS_ENABLED=false`; deploy production.
2. Generate contract pauses `true / false / true`, execute through the multisig, then run `pnpm pauses:verify -- true false true`.
3. Wallet B opens the Lock from wallet A's `LOCK-…` invite link and joins through the production UI at exactly `0.1 USDC`. Confirm an altered checksum is rejected, and that a valid code does not bypass admission, capacity, timing or stake requirements.
4. Record the approval and join transaction hashes.
5. Close the contract to `true / true / true` first.
6. Disable the Vercel flags, redeploy, snapshot and reconcile.

Participant counts, event counts, identities and escrow liability must agree before the Lock starts.

## Daily check-in windows

The three-day template cannot finalize early: settlement opens only after the third day and the 24-hour submission grace period both end.

For each open day:

1. Both athletes record a real GPS run of at least the target, outdoors, not manual, not on a treadmill, inside that UTC day of the Lock. Wait for the activity to appear in Strava.
2. Set Vercel production to `NEW_PACTS_ENABLED=false`, `JOIN_ENABLED=false`, `CHECK_INS_ENABLED=true`; deploy production.
3. Generate contract pauses `true / true / false`, execute through the multisig, then run `pnpm pauses:verify -- true true false`.
4. Each wallet presses Check in and waits for the `submitCompletion` receipt. The attestation is short-lived, so do not close the window while a valid participant transaction is pending. Record calldata bytes, gas estimate, receipt gas, wallet type, device and any handoff failure.
5. Close the contract to `true / true / true` first.
6. Set `CHECK_INS_ENABLED=false`, redeploy, snapshot and reconcile.

Never leave check-ins open overnight. A check-in publishes distance, moving and elapsed time, elevation gain, the activity start time, the wallet, the Lock, the day, and the three HMAC-derived values. Never request or publish a GPS route.

## Disconnect and reconnect

After the canary, exercise the exit path with wallet B:

1. Disconnect through the production UI.
2. Confirm at `strava.com/settings/apps` that the grant is gone, not merely forgotten locally.
3. Confirm `/api/strava/connection` reports no connection and a check-in now refuses.
4. Reconnect and confirm the athlete resolves to the same pseudonymised identity, so a disconnect cannot be used to replay a spent run or to re-enter a Lock as a second participant.

## Two-wallet outcome matrix

| Wallet A | Wallet B | Expected settlement |
| --- | --- | --- |
| Three valid GPS runs at or above the target | At least one valid run, then deliberately misses the target | A is the only finisher and receives `0.2 USDC`; B is ineligible |

Wallet B's partial participation proves its separate identity and submission path without making it a finisher. Do not spend gas on an intentionally reverting claim; the ineligible-claim branch is covered by the contract tests.

Safe live negative checks: a run below the target, a run outside the Lock day, and a second wallet attempting to check in from an already-bound Strava identity. Manual, no-GPS, trainer, flagged, implausible-motion and replay cases stay deterministic automated tests in `test/strava-activities.test.ts`. Do not manufacture unsafe external account states for a canary, and do not submit expected failures on chain.

## Settlement and claims

After the Lock's exact `submissionDeadline` (`endsAt + 24 hours`):

1. Anyone calls `finalizePact`; creation, joining and check-ins remain paused.
2. Eligible wallets claim through the production UI.
3. Snapshot the pact after finalization and after every claim.
4. Run `CANARY_EXPECTED_PACT_IDS=<comma-separated IDs> pnpm canary:reconcile`.
5. Confirm the escrow USDC balance equals the sum of every Lock's remaining liability.

Observer snapshots hold public contract state only. Keep the transaction-hash and gas ledger beside them, outside Git, for example under the ignored `proofs/` directory.

## Social-layer rehearsal

Social profile functions are public on-chain actions and are not covered by the pause flags. Use only disposable handles, and record every transaction hash and gas cost.

1. Wallet A claims a valid lowercase handle. Wallet B is refused that active handle, then claims another. Neither operation touches a Strava name.
2. After wallet B has an accepted day, wallet A sends one high-five for that exact Lock and day. The event must identify sender, recipient, Lock and day. A duplicate is rejected, and the reaction changes no score, bitmap, finisher status, liability or payout.
3. Wallet A changes, then clears, its handle. The active mapping empties, the string returns to the pool, surfaces fall back to the wallet address, and earlier `PlayerHandleSet` events stay visible.
4. Through the multisig, hide wallet B's profile: surfaces suppress the handle while keeping its wallet, verified days, rank, score, completion state and claim rights. Restore it. Record both `PlayerProfileVisibilityUpdated` events.
5. Check the weekly boards against the raw events. The displayed week is Monday 00:00 UTC to the next Monday; all-time Lock Score stays cumulative.

Snapshot and reconcile before and after every social write. Balance, liability, finishers and claim amounts must be identical except for changes the plan already expects.

## Refund rehearsals

### Underfilled Lock

Wallet A creates a separate `0.1 USDC` Lock, creation closes immediately, wallet B does not join. At its start, `finalizePact` must take the cancelled refund path. Wallet A claims exactly `0.1 USDC`.

### Owner emergency cancellation

Create a separate Lock, close all three controls, set `PACT_ID`, run `pnpm incident:cancel-pact`. Inspect the snapshot and ordered zero-value calls, submit through the multisig, then run `pnpm incident:cancel-pact:verify`; it must confirm cancellation and finalization before any refund claim. Every joined wallet claims only its original stake. Local `--execute` is EOA-development compatibility only and refuses the release multisig.

Snapshot the Lock and reconcile the whole escrow after each rehearsal.

## Incident response

- **Unexpected Lock or participant:** close all contract controls immediately, then close Vercel, reconcile and inspect every new event.
- **Creation defect:** pause creation on chain before disabling `NEW_PACTS_ENABLED` in Vercel.
- **Join/funding defect:** pause joining on chain before disabling `JOIN_ENABLED`; identify every forming Lock.
- **Check-in, Strava-API or signer defect:** pause completion on chain before disabling `CHECK_INS_ENABLED`; move affected unsettled Locks into refunds if continuing would be unfair.
- **Suspected evidence-key compromise:** this is the highest-severity case, because that key alone can mint completions. Pause completion first, then creation and joining, inventory every unsettled Lock, rotate the key, redeploy only after the new signer is on chain, and publish a UTC notice.
- **Suspected Strava token or encryption-key compromise:** pause check-ins, revoke the affected grants at Strava, rotate the encryption key knowing it also rotates every pseudonymised identity and nullifier, and treat previously published values as spent.
- **Strava revokes or restricts the application:** check-ins stop working. Pause completion, and move unsettled Locks into refunds rather than leaving athletes staked against a verification path that no longer exists.
- **Abusive or impersonating handle:** hide the profile through the multisig, preserve the moderation transaction and reason, notify the wallet if a channel exists. Do not alter score, mission state, settlement or claims; on-chain history cannot be erased.
- **RPC/UI defect only:** keep permissionless settlement and claims available and publish direct contract and explorer instructions.

Record decisions, addresses, Lock IDs, transaction hashes, UTC times and the operator for every step. Never promise reimbursement before chain state and responsibility are known.
