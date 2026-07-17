# Canary log — Lock #1

The real two-wallet canary on escrow A (`0xD37121112F240fE03a18D754B2fdB9dC750034d4`, Monad chain 143).
No raw Strava identifier, activity id or GPS route is recorded here: those are private, and the point of
the pseudonymisation is defeated if they are written down beside the wallet.

## D1 — check-in, 17 July 2026

First real check-in of the canary, and the first time the OAuth refresh path ran against a genuinely
expired access token. Both matter: the refresh was the one part of the loop never exercised before.

**Transaction**
- hash: `0x1005fbbec2c21d87097e76e40cc7860fadc613f3b544b78a5eead2c21009fbe7`
- explorer: https://monadscan.com/tx/0x1005fbbec2c21d87097e76e40cc7860fadc613f3b544b78a5eead2c21009fbe7
- receipt: success · block 88374137 · gas used 499453
- `submitCompletion` · pactId 1 · dayIndex 0 (day 1) · wallet A
- metric accepted: 1050 m (target 1000 m) · moving time 859 s
- activity start: 17 Jul 2026 17:11 Paris, inside the D1 window

**On-chain progression**
- `completionCount(1, A)`: 0 → 1 (1/3)
- `completionBitmap`: day-1 bit set
- `lockScore(A)`: 0 → 10
- `finisherCount`: 0 (expected until 3/3)
- the activity nullifier is global and the day bit is set, so this run cannot settle another day or Lock

**OAuth refresh (wallet A, `strava_connections`)** — the loop
`wallet session → existing grant → automatic refresh → Strava read → attestation → submitCompletion`
- `updated_at`: 00:31:01 → 17:40:00 (row rotated)
- access token expiry: 06:31:01 (expired) → 23:40:00 (future)
- refresh token: present, encrypted `v1`, before and after
- access token: present, encrypted `v1`, before and after
- revoked: no · same athlete · no new OAuth row · no Strava re-authorisation

## D2 — pending
Window: Sat 18 Jul 05:00 → Sun 19 Jul 05:00 Paris.

## D3 — pending
Window: Sun 19 Jul 05:00 → Mon 20 Jul 05:00 Paris.

## Settlement — pending
Lock ends Mon 20 Jul 05:00. Submission deadline and first `finalizePact` at Tue 21 Jul 05:00.
Expected: A reaches 3/3 and is the sole finisher, claims 0.2 USDC; B claims nothing.

## Duolingo Live Proof Beta — first public E2E, 17 July 2026

Run by wallet A on https://lock-in-duolingo-preview.vercel.app/duolingo with a real Duolingo account. No
raw profile id or proof object recorded here; those stay server-side.

- baseline: 8219 XP · target: +50 XP
- first final, no XP earned yet: rejected, "Earned 0 XP of the 50 this Lock requires"
- second final, after real XP: 8271 XP · delta +52 · **Challenge complete ✓**

Neon (preview DB) confirmed: baseline 8219, final 8271, earned 52, passed true. The rejected 0-XP final
did NOT consume its session (validation refused it before the atomic consume+save), the successful final
did, and the result survives a page reload. It proves, on real infrastructure: wallet auth, allowlist,
Reclaim portal, real TEE baseline, server-side baseline, refusal of an unmet target, a retry after that
refusal, identity continuity, exact delta, and success at the target. No mock, no hand-entered XP.
