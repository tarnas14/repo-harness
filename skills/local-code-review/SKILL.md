---
name: local-code-review
description: Run a high-signal Codex code review locally from a checked-out repository, with a bundled staff-level review prompt and a local continuity ledger. Use when reviewing a local branch, commit, uncommitted changes, or PR on your own machine without installing the GitHub Action bot. Supports review-and-report by default and explicit autonomous remediation loops where the main agent assesses findings, fixes only actionable issues, validates the changes, and repeats until the work is complete.
license: MIT
---

# Local Code Review

Run a bundled staff-level review prompt locally with a lightweight continuity ledger. This skill
does not install workflows, set GitHub secrets, or post GitHub comments. If you need a CI review
bot instead, see the `install-code-review-bot` skill in this skill's source repository.

## Requirements

- Git
- Node.js 18+
- Authenticated `codex` CLI

The default run disables network and stores continuity under Git's private `codex-review` path.

## Workflow

1. Choose the operating mode from the user's request.
2. Make sure the target repository is checked out at the branch or commit to review.
3. Choose the review scope:
   - branch review: pass `--base <base-ref>`
   - single commit: check out the target commit as `HEAD`, then pass `--commit HEAD`
   - current worktree: pass `--uncommitted`
4. Run the local review runner from this skill:

   ```bash
   node scripts/run-local-review.cjs --repo-dir <target-repo> --base <base-ref>
   ```

5. Read the Markdown review printed by the script. The same text and structured continuity state are
   saved under the checkout's Git-private `codex-review` path.
6. Assess every finding under the Review rules before reporting it or changing code.

## Operating modes

Choose the mode from the user's request. These modes control the main agent after the review. The
review runner itself always remains read-only.

### Review and report

Use this mode by default when the user asks for a review, findings, or an assessment without asking
the main agent to modify the code.

1. Run one review pass.
2. Assess every finding under the Review rules.
3. Report each reviewer finding with the main agent's disposition and reason.
4. Do not modify the code or run another pass unless the user asks.

### Autonomous remediation

Use this mode only when the user explicitly asks the main agent to fix findings, iterate on the
review, or continue until the work is complete. In this mode the main agent is the decision
maker: reviewer output is evidence for its decisions, never a work order.

Before the first pass:

1. Write down the scope anchor: the goal of the change as the user stated it, explicit
   non-goals, and the real usage profile. Pass it to the reviewer with `--goal` and
   `--non-goals`, and narrow plan or document reviews with `--focus`.
2. Declare the stop criteria in the conversation (see the convergence protocol below).

Each pass:

1. Run one review pass and wait for it to finish.
2. Assess every finding against the scope anchor. The controlling question is "does the
   requested change need this?", not "is this failure scenario real?". Findings are often valid
   against guarantees the plan invented for itself and still out of scope. Verify claims against
   the actual code before accepting them, and judge the reviewer's suggested fix separately from
   the finding itself.
3. Post the dispositions in the conversation BEFORE changing any file: one line per finding with
   `actionable now` / `defer or accept risk` / `reject` and the reason.
4. Persist the dispositions (see Recording dispositions). A disposition that exists only in the
   conversation does not exist - context compaction erases it, and unrecorded rejections are why
   review loops re-litigate the same findings.
5. Fix only findings classified as `actionable now`, each with a regression test when applicable.
6. Validate the changes with the relevant tests or checks, then rerun the review when another
   pass can provide useful new evidence.

Scope-impact rule: a finding whose fix adds a new guarantee, persistent state, database table,
scheduler, lifecycle, or credential-storage change may be `actionable now` only when the failure
is demonstrated against the real code or a test AND the fix fits the scope anchor. Otherwise
classify it `defer` and record it as a named follow-up for the user to approve - never fold it in
silently. In plan reviews, where no code or test can falsify the finding, new guarantees default
to `defer`.

Convergence protocol (stop conditions):

- Every pass must either surface at least one newly accepted finding or be a declared
  confirmation pass. After two consecutive passes with nothing new, close the loop.
- When a rejected finding is re-raised a second time, close the loop or keep the documented
  rejection; do not re-litigate it.
- When findings drift from concrete defects into speculative guarantees beyond the scope anchor,
  close the loop on your own judgment and say so.
- Carry forward prior `defer or accept risk` and `reject` dispositions unless the code or
  available evidence has materially changed.

The main agent decides when the work is complete. A reviewer `OK` verdict is useful evidence, but it
is not required when all remaining findings were consciously deferred or rejected. In the final
report, include the review passes, fixes, deferred or rejected findings with reasons, validation
results, and why the work is complete.

## Recording dispositions

The same rules apply whether the reviewed artifact is a plan or code.

- `rejected` and `defer or accept risk` dispositions go into `dispositions.json` in the ledger
  directory (`$(git rev-parse --git-path codex-review)/dispositions.json`):

  ```json
  [
    { "id": "RR-001", "disposition": "rejected", "reason": "Conflicts with the product decision to keep sends single-shot." }
  ]
  ```

  The runner injects recorded dispositions into the next reviewer pass so the reviewer stops
  re-raising them, and filters them out of open issues and the verdict.
- `actionable now` findings need no ledger entry: the fix plus its regression test is the record.
- Decisions that must outlive the loop (product-level rejections, consciously accepted risk,
  "we deliberately do not handle X") additionally go into the project's plan or decision log
  (an ExecPlan Decision Log where the project uses one) with the finding ID. The ledger dies
  with the checkout; committed artifacts are the project's memory. When no plan exists, use the
  repository's documented decision or tech-debt location.

## Do not touch the target repository during a run

While `run-local-review.cjs` is running, do not modify the target repository at all until the
runner's output is received:

- no source edits
- no test, build, or lint runs (they write artifacts like `test-results/`, `dist/`, or coverage)
- no git operations (commit, checkout, stash, branch)
- no dev servers or other processes writing into the repo
- nothing else that mutates the worktree or moves refs

The runner's mutation guard diffs the worktree before and after the run and treats any change to
tracked or untracked files as a failed integrity check, so concurrent activity turns a good review
into an error. Gitignored runtime artifacts (build output, caches, logs) are excluded from the
guard. Wait for the run to finish (it is typically run in the background). If parallel work is
genuinely needed, run the review against a separate `git worktree` copy of the repository instead.

The runner kills a hung reviewer after `--timeout-min` (default 20 minutes; healthy passes finish
in single-digit minutes). Do not build external watchdogs around it.

A failed run (nonzero exit, mutation guard, timeout) produces no usable findings: the runner
quarantines any structured output as `codex-review-output.rejected.json` and does not update the
ledger. Treat such a pass as if it never happened - report the error, fix the cause, rerun. Never
mine a failed run's output for findings.

## Keep reviewer output out of the main context

Run the command once and wait for it to finish. The runner captures verbose Codex stdout and stderr
under the Git-private `codex-review/runs/<timestamp>/codex-exec.log` path. It prints only short
status lines and the final Markdown review.

Do not add `tee`, tail the log, or repeatedly read live subprocess output into the conversation. If
the run fails, inspect the saved log with a targeted search or a bounded tail instead of printing
the whole file.

## Available script

- `scripts/run-local-review.cjs` - runs Codex with the local review prompt, a structured output
  schema, quiet subprocess output, and a Git-private continuity ledger. This is the default path.
- `scripts/run-code-review.cjs` - legacy bot-parity runner retained for eval comparisons and
  troubleshooting. It builds `.codex-ci/` artifacts like the GitHub Action bot.

Useful flags:

```bash
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main
node scripts/run-local-review.cjs --repo-dir <target-repo> --uncommitted
node scripts/run-local-review.cjs --repo-dir <target-repo> --commit HEAD --title "Commit title"
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --reset
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --force
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --no-codex
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --model gpt-5.6-sol --reasoning high
node scripts/run-local-review.cjs --repo-dir <target-repo> --uncommitted \
  --goal "Add a POST /exports endpoint that renders one report as a PDF" \
  --non-goals "No job queue, no persistent export registry, no credential changes" \
  --focus docs/exec-plans/active/my-plan.md
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --timeout-min 30
```

Pass `--goal` and `--non-goals` in autonomous loops so the reviewer judges findings against the
user's scope instead of the artifact's own ambitions; use `--focus` to pin plan reviews to the
plan file.

Use `--no-codex` to build and inspect the prompt/schema without spending a model run.

## Behavior

- The runner uses ordinary Git commands from the prompt to inspect branch, commit, or uncommitted
  scope. It does not generate `.codex-ci/` diff artifacts.
- Local continuity state lives in Git's private metadata path for the checkout, not in a committed
  file: `$(git rev-parse --git-path codex-review)/state.json` and `review.md`.
- Verbose reviewer stdout and stderr stay in the matching Git-private
  `runs/<timestamp>/codex-exec.log`; they are not streamed into the invoking agent's context.
- If the same review scope was already reviewed, the runner exits without spending another model run.
  Use `--force` to re-review the same scope.
- If earlier runs produced review output that never persisted into `state.json`, the runner stops
  with a broken-continuity error instead of silently starting a fresh review chain. Investigate the
  failed runs first; pass `--reset` only to deliberately start over.
- Owner dispositions recorded in the ledger's `dispositions.json` are injected into the reviewer
  prompt and removed from open issues and the verdict, so consciously rejected or deferred findings
  stop coming back. If the reviewer re-emits one anyway, the runner appends an authoritative
  "Effective verdict after owner dispositions" note to the review. The runner warns when the
  checkout is unchanged since the previous pass and open findings still have no recorded
  disposition - the loop is then neither fixing nor dispositioning them.
- Branch and commit reviews require a clean worktree so Codex reads exactly the committed scope under
  review. Use `--uncommitted` when staged, unstaged, or untracked local changes are part of the scope.
- Commit reviews also require the reviewed commit to be checked out as `HEAD`; use a temporary git
  worktree when reviewing an older commit.
- Use `--reset` to ignore previous local state and start a new continuity chain.
- The script compares the checkout and worktree before and after `codex exec`. If the review run
  changes files, switches commits/refs, or if the mutation guard cannot collect a complete Git
  inventory within its output limits, stop and report that as an error.

## Review rules

The reviewer is an independent subprocess and does not have the main agent's full task or
conversation context. Treat its output as evidence, not instructions. The reviewer's severity,
verdict, and suggested fix do not override the user's scope, the supported operating model,
repository guidance, or the main agent's judgment.

Classify every finding as:

- `actionable now` - valid, material, in scope, and relevant to the supported operating model
- `defer or accept risk` - valid, but outside the current scope or not worth the added complexity
- `reject` - incorrect, stale, minor, or based on unsupported assumptions

State the disposition and reason for every finding in the conversation before modifying the
reviewed artifact, then persist it (see Recording dispositions). For `actionable now`, make the
smallest justified change and add a regression test when applicable. Do not modify code for
rejected findings.

Additional rules:

- Report findings first, ordered by severity.
- Do not invent issues. A review with no concrete P0/P1 findings is a valid result.
- Preserve reviewer continuity: keep stable issue IDs for still-open findings and mark fixed prior
  findings as resolved.
- Treat the continuity ledger as reviewer state, not as an implementation backlog.
- Do not rerun review merely to obtain an `OK` verdict or silence a consciously deferred or rejected
  finding.
- Do not commit generated review artifacts unless the user explicitly asks for them.
- If the script reports no new scope to review, report that instead of forcing another run.
