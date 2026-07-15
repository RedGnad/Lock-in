# Lock In V5

**Your word. Locked in.** Challenge friends to run or learn, stake up to 1 USDC each, and let finishers split the pool funded by those who quit.

Lock In V5 is a limited-cohort, adult-only hackathon beta on Monad mainnet. It supports two independent proof policies:

- **Strava run:** a challenge-named GPS Run must reach the distance target. Manual, trainer, Strava-flagged, missing-GPS, and implausible motion records are rejected.
- **Duolingo XP:** the user places a wallet-derived code in the public profile bio. A fresh cumulative-XP baseline is accepted atomically with the stake; only later XP above both the pact baseline and globally consumed XP can count.

Reclaim zkTLS proves what each service returned over HTTPS. It does not prove physical movement, human learning, or the absence of GPS spoofing, account sharing, bots, modified devices, or upstream errors. The policies close username impersonation, replay, identity switching, old-progress reuse, obvious manual Strava entries, and several implausible-motion cases; they do not make fraud impossible.

## Product and settlement

The app offers 3, 7, 14, and 30-day pacts with fixed completion targets. Registration closes at the published start. Every participant stakes the same amount, from 0.1 to 1 USDC. The cap is per participant per pact; Monad gas is separate.

- if anyone finishes, finishers recover their stakes and split non-finishers&apos; stakes;
- if everyone or nobody finishes, each participant recovers their own stake;
- underfilled and cancelled pacts refund every participant;
- settlement and claims remain permissionless even while creation, joining, or evidence is paused;
- there is no protocol fee or operator withdrawal path.

[`contracts/LockInEscrowV5.sol`](contracts/LockInEscrowV5.sol) verifies short-lived EIP-712 evidence attestations, binds one external identity per wallet inside each pact, enforces global event nullifiers, and prevents a consumed Duolingo XP range from settling another completion. Raw provider responses and GPS routes are never stored onchain.

V5 is unaudited. Keep all production controls paused until the provider canaries, contract review, and two-wallet real-flow rehearsal pass.

## Production deployment — paused

- App: https://lock-in-liart-theta.vercel.app
- V5 escrow: `0xA75375E11A8564b9DFe5fe2084Ff277Bb41c6a6a`
- Monad deployment transaction: `0x1d67657eedb350206e49a44256bdb8c42625b987ed83884713e463a392cec3ba`
- Source verification: Sourcify exact match, job `0ccebcfd-5536-46c8-8f62-4eb51cb4f2ac`
- Strava provider: `f3ec8292-d8f3-487c-a79d-f53f482f88e2@1.0.3`
- Duolingo provider: `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.0`

Creation, joining, and evidence submission are paused in both the website configuration and the contract. Settlement, refunds, and claims remain available. The deployment is a canary target, not an open real-funds launch.

## Duolingo impersonation decision

The inspected public Reclaim provider `7c57a498-6b0e-4b3a-8235-de7ba938e823` is not used. It accepts a user-selected profile identifier and extracts only `totalXp`, so it can target somebody else&apos;s account.

The Lock In provider in [`providers/duolingo-owned-xp.json`](providers/duolingo-owned-xp.json) extracts stable profile id, username, bio, and `totalXp` from one response. The backend accepts it only when the bio exactly matches the code derived from the proof-bound wallet. Contract creation/join and baseline acceptance are atomic: a failed ownership proof cannot leave the user&apos;s stake locked.

## Privacy

The website has no product account database. During verification, Reclaim and the server function process the minimum signed provider fields and return a short-lived attestation. They are not intentionally retained by Lock In.

Monad permanently exposes wallet, pact, stake, mission, day, completion metric, hashed identity, nullifier, timestamps, and settlement. The Strava metric is distance. The Duolingo metric is cumulative XP; username, raw profile id, bio, and GPS route are not published onchain. See [`app/privacy/page.tsx`](app/privacy/page.tsx) and [`PRIVACY.md`](PRIVACY.md).

## Local development

Requirements: Node.js 22+, pnpm 10+, Foundry, and a Monad RPC.

```bash
cp .env.example .env
pnpm install
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Required server-only proof configuration:

```dotenv
ID=
SECRET=
EVIDENCE_SIGNER_PRIVATE_KEY=0x...
SESSION_SIGNING_SECRET=
DUOLINGO_PROVIDER_ID=
```

Never expose these through `NEXT_PUBLIC_*` and never upload the funded deployer key to Vercel.

Every release starts closed:

```dotenv
NEW_PACTS_ENABLED=false
JOIN_ENABLED=false
CHECK_INS_ENABLED=false
```

`/api/health` verifies chain 143, V5, native Monad USDC, the immutable 1 USDC cap, onchain pause state, explicit product flags, and privacy contact. Website flags do not stop direct contract calls; use the matching onchain pause during an incident.

## Release gate

1. Publish and pin the Lock In Duolingo provider; pass wrong-profile, wrong-bio, stale, replay, and live baseline/delta proofs.
2. Pass all TypeScript, policy, Solidity, production-build, and static security checks.
3. Deploy V5 paused, verify source and constructor arguments publicly, and confirm the evidence signer address.
4. Rehearse Strava and Duolingo create, join, completion, settlement, payout, underfilled refund, and emergency refund with two internal wallets at 0.1 USDC.
5. Confirm rules, privacy, addresses, support contact, monitoring, and at-risk-pact ledger from the production deployment.
6. Obtain independent contract/security review before opening beyond the controlled hackathon cohort.

## Repository map

- `contracts/LockInEscrowV5.sol` — multi-mission fixed-stake escrow.
- `src/strava-proof-policy.ts` — Strava anti-cheat and challenge binding.
- `src/duolingo-proof-policy.ts` — wallet ownership code and XP snapshot policy.
- `app/api/reclaim/*` — session, polling, zkTLS verification, and EIP-712 attestation.
- `providers/*` — pinned private Strava and Duolingo provider configurations.
- `test/LockInEscrowV5.t.sol` — settlement, replay, baseline, identity, cap, and refund tests.
- `docs/tester-runbook.md` — controlled beta operations.

The production privacy/support contact is **mookipstore@hotmail.com**.
