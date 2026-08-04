# Local Review Continuity Contract

The `coding-review-local` runner stores continuity under Git private metadata by default:

```text
$(git rev-parse --git-path coding-review-local)/
  state.json
  review.md
  prompt.md
  reviewer-output.json
  dispositions.json
  runs/<timestamp>/
    scope-summary.txt
    scope.patch
    changed-files.txt
    reviewer.stdout.log
    reviewer.stderr.log
    state.json
    review.md
    prompt.md
    reviewer-output.json
    reviewer-output.rejected.json   (failed runs only)
```

This keeps review state out of the checked-out worktree and avoids accidental commits. The reviewer
logs contain verbose subprocess output. Read them only for diagnostics, and use a targeted search or
bounded tail instead of loading a whole file into an agent context.

## Failed Runs

- The runner writes the reviewer's structured output into the run directory first and promotes it
  to the ledger root only on success. The ledger root never contains output from a failed run.
- When a run fails (nonzero exit, mutation guard, timeout, unparsable output), any structured
  output is renamed to `reviewer-output.rejected.json`. Its findings must not be used, applied,
  or counted; the pass is treated as if it never happened.
- When earlier runs produced review output but `state.json` was never written, continuity is
  broken. The runner refuses to continue until the cause is fixed or `--reset` deliberately starts
  a new chain.

## Mutation Guard

- The guard fingerprints HEAD, staged and unstaged diffs, untracked files, and the private scope
  artifacts before and after the reviewer runs. Any difference fails the run and reports which
  worktree paths changed.
- Gitignored files are excluded: runtime artifacts such as build output, caches, and dev-server
  logs are never part of a review scope, so they must not invalidate a review or break continuity.

## Owner Dispositions

`dispositions.json` records the repo owner's conscious decisions about findings:

```json
[
  { "id": "RR-001", "disposition": "rejected", "reason": "Conflicts with the product decision." },
  { "id": "RR-002", "disposition": "deferred", "reason": "Real risk, separate follow-up approved by the owner." }
]
```

- Valid dispositions are `rejected` and `deferred`. Accepted findings are recorded by their fix
  and the resolved-issue tracking, not here.
- A dispositioned ID names exactly that incarnation of the finding. When materially new evidence
  defeats the recorded reason, the reviewer reports it as a new finding under a fresh ID that
  references the old one; the runner keeps filtering the old ID, while the fresh ID stays in
  state and drives the verdict. Dispositioned IDs are never reused.
- A disposition must name an ID the chain has actually reported. The runner tracks every reported
  ID in `state.known_issue_ids` and rejects unknown disposition IDs before invoking the reviewer,
  so a mistyped entry cannot silently suppress a future unrelated finding. Legacy states without
  `known_issue_ids` are migrated by proving dispositions against the latest successful run's
  snapshot.
- The scope-skip identity includes `review_context_key`, a hash of the semantic review inputs
  (goal, non-goals, focus, dispositions, and reviewer settings): changing any of them re-triggers a
  review even on an unchanged checkout.
- Every prior open finding that has no owner disposition must appear in the next pass as either open
  or explicitly resolved. An unexplained disappearance fails the run before state promotion.
- Finding IDs must be non-empty and unique. One pass cannot report the same ID as both open and
  resolved; malformed identity state fails before continuity reconciliation.
- The runner injects recorded dispositions into the reviewer prompt with the instruction not to
  re-raise them without materially new evidence, and filters them out of `open_issues` and the
  verdict. If the reviewer's human-readable report still counts a dispositioned finding, the
  runner appends an authoritative "Effective verdict after owner dispositions" note to the
  persisted and printed review instead of trusting the reviewer's verdict line.
- `--reset` rotates `dispositions.json` aside (finding IDs are chain-scoped), but only when the
  reset pass succeeds and its new state is promoted; a failed or `--no-reviewer` reset leaves the
  current chain's dispositions untouched.
- The ledger lives with the checkout and dies with it. Decisions that must outlive the loop
  belong additionally in the work's ExecPlan Decision Log or the repository's documented decision
  location.

## State Rules

- `scope_key` identifies the exact reviewed scope. It covers scope kind plus the resolved commit,
  base/merge-base, or uncommitted worktree fingerprint. A runner may skip only when both the head SHA
  and `scope_key` match the previous state.
- Branch and commit scopes must be reviewed from a clean worktree. If staged, unstaged, or untracked
  local changes are intended, the runner must use an uncommitted scope so the worktree fingerprint is
  part of `scope_key`.
- Commit scopes must also be checked out at the target commit. If a user wants to review an older
  commit, create a temporary git worktree or detached checkout at that commit before running the
  local review.
- `open_issues` contains only issues that still apply at the current head.
- Structured `open_issues` determines the effective verdict. If reviewer Markdown disagrees, the
  runner corrects the Markdown verdict before promotion.
- `recently_resolved_issues` contains issues from the previous state that the current head fixed.
- Keep issue `id` values stable across runs when the same issue remains open.
- Do not duplicate a prior open issue. Update its `last_seen_head_sha` instead.
- If an issue is fixed, remove it from `open_issues` and add it to `recently_resolved_issues`.
- If history was rewritten and prior state may not align, use previous issues as hints but rebuild the state from the current code.
- Every P0/P1 issue must include a concrete `failure_scenario`.
- Custom ledger directories must be outside the target worktree or inside its Git metadata
  directory. This keeps runner-owned logs and artifacts out of the review scope and mutation guard.

## Severity Rules

- `P0`: merge blocker for data loss, security exposure, production incident, or similarly severe impact.
- `P1`: must fix before merge because the issue is likely to cause incorrect runtime behavior, major reliability loss, serious security risk, or architecture breakage.
- `P2`: should fix soon. Use sparingly and keep to issues with real risk.

No concrete failure scenario means the issue is not P0/P1. Demote or drop it.
