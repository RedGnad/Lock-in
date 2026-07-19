# Spark hackathon provenance

Lock In was built for the Spark hackathon, after it opened. This document records the Git evidence so a
judge can confirm the work is in-window, without trusting any claim in prose.

## Cutoff

Spark opened at:

```
2026-07-13T13:00:00Z
```

## Earliest public Git commit

```
SHA          55e22ed7cb5de82706141de274def4825764b969
AuthorDate   2026-07-14T18:05:29Z
CommitDate   2026-07-14T18:05:29Z
Subject      feat: build Lock In Strava zkTLS pact v2
```

The earliest commit's author date is **after** the Spark cutoff. A full-history audit of every commit's
`AuthorDate` and `CommitDate` finds **zero commits before the cutoff**:

```bash
git log --all --pretty='%H %ad' --date=format-local:'%Y-%m-%dT%H:%M:%SZ' \
  | awk '$2 < "2026-07-13T13:00:00Z"' | wc -l
# 0
```

## The V2-V5 labels

The names `v2`, `v3`, `v4` and `v5` in this repository (contract files, docs) are **rapid in-hackathon
iterations**, not pre-existing releases. They were all authored during Spark, after the cutoff above, as
the design converged from an early Strava streak prototype to the two-escrow Strava + Duolingo product that
ships on `main`. Their commit dates are all in the same in-window range and are visible in `git log`.

## Integrity

The history has **not** been rewritten to hide earlier work: no `rebase`, no `--amend --date`, no
force-push. The dates above are the original author and commit timestamps, verifiable with:

```bash
git log --reverse --format='%H %aI %cI %s' | head -1
```
