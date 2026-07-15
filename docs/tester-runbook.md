# Lock In V5 private tester runbook

This runbook covers a small, limited adult tester cohort using real Monad USDC. Every stake and gas fee is real. V5 remains closed until every release check passes.

## Before deployment

1. `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`, `forge build`, and `git diff --check` pass.
2. The Strava provider is pinned to `f3ec8292-d8f3-487c-a79d-f53f482f88e2@1.0.3` and all three activity responses expose the same activity ID.
3. The Lock In Duolingo provider is published, pinned, and passes correct-profile, wrong-profile, wrong-bio, stale, replay, baseline and XP-delta tests.
4. Rules and privacy accurately list every processed and public field.
5. The funded deployer key is local only. Vercel contains only the unfunded evidence key, Reclaim app credentials, session secret, provider id, flags and public configuration.

## Paused deployment

1. Deploy V5 with official Monad USDC and the expected evidence signer.
2. Immediately set creation, joining and evidence pauses to `true`.
3. Verify source and constructor arguments publicly.
4. Update the deployment manifest, `NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS`, deployment block and Vercel production configuration.
5. Confirm `/api/health`: chain 143, V5, USDC, 1 USDC cap, signer configuration, pauses and explicit flags.

## Internal canaries

Use two controlled adult wallets and 0.1 USDC only.

1. Strava: create, join, title a real GPS Run with the displayed daily code, verify both wallets, settle and claim.
2. Confirm manual/no-GPS, trainer, flagged, wrong title, wrong wallet, stale proof and replay attempts fail.
3. Duolingo: set each bio to its wallet code, create/join with atomic baselines, earn the target after joining, verify, settle and claim.
4. Confirm another username, wrong bio, same profile for two wallets, unchanged XP, reused XP and reused snapshot fail.
5. Create an underfilled pact and verify full refund. Rehearse owner emergency cancellation into refunds.
6. Reconcile contract token balance against all open-pact liabilities and archive transaction hashes.

## Controlled opening

Open only the action needed for the current cohort, both onchain and in Vercel. Monitor proof failures, signer errors, RPC health, participants, deadlines, escrow balance and claims. Do not open additional cohorts while an incident or unexplained mismatch exists.

## Incident response

- **Creation defect:** disable `NEW_PACTS_ENABLED`, pause creation onchain.
- **Join/funding defect:** disable `JOIN_ENABLED`, pause joining, identify every forming pact.
- **Proof/provider/signer defect:** disable `CHECK_INS_ENABLED`, pause evidence, then cancel every affected unsettled pact into refunds before a deadline can make the outcome unfair.
- **RPC/UI defect only:** keep settlement and claims available; provide direct contract and explorer instructions.
- **Suspected key compromise:** pause all risky actions, rotate evidence signer if affected, move owner authority if needed, cancel exposed pacts into refunds, publish a UTC incident notice.

Never promise reimbursement before chain state and legal responsibility are known. Record decisions, addresses, pact ids, transaction hashes, UTC times and the person approving each action.
