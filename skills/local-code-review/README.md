# Local Code Review

Run a high-signal, autonomous code-review loop on your own machine: a Codex reviewer finds
problems, your main agent decides what to do about them, and a local ledger makes sure the loop
converges instead of spiraling.

The skill has two layers. The core is a disciplined single review pass: a strict reviewer with a
high bar for findings, structured output, and a continuity ledger that gives the loop memory.
On top of it sits a hardening layer for autonomous use, built against a known failure mode: the
agent stops optimizing for the user's goal and starts optimizing for a clean review - every
plausible finding becomes a requirement, every fix grows the design, and every grown design
produces new findings.

## How it works

```text
main agent (driver)                      reviewer (Codex subprocess)
  |                                        |
  | node scripts/run-local-review.cjs      |
  |--------------------------------------->|  reads the repo, read-only
  |                                        |  returns markdown + structured state
  |<---------------------------------------|
  | assesses every finding                 |
  | fixes / defers / rejects               |
  | records dispositions                   |
  | reruns until the loop converges        |
```

Two roles, strictly separated:

- **The reviewer** is an independent `codex exec` subprocess with a structured output schema. It
  is deliberately aggressive - it hunts races, omissions, and edge cases. It has no memory of
  your conversation and no authority over scope.
- **The driver** (the agent invoking this skill) is the decision maker. Reviewer output is
  evidence, never a work order. The driver judges every finding against the owner's stated scope
  and answers one controlling question: *does the requested change need this?* - not *is this
  failure scenario real?* Findings are often valid against guarantees a plan invented for itself
  and still out of scope.

The driver operates in one of two modes. **Review and report** (the default): one pass, a
disposition for every finding, no code changes. **Autonomous remediation** (only when the user
explicitly asks for it): the driver fixes actionable findings, validates, and reruns until the
loop converges under the protocol described below.

A review pass takes single-digit minutes. State lives in a Git-private ledger
(`$(git rev-parse --git-path codex-review)/`), so nothing pollutes the worktree and nothing gets
accidentally committed.

## What a single pass does

**Scopes.** One review targets exactly one scope:

- `--base <ref>` - the current branch against a base ref (auto-detected from `origin/HEAD`,
  falling back to `origin/main`/`master`);
- `--commit HEAD` - a single commit, which must be checked out so the reviewer reads exactly
  that tree;
- `--uncommitted` - staged, unstaged, and untracked changes.

Committed scopes require a clean worktree - otherwise the reviewer would review code that is not
what you think it is. Each scope gets a content-derived `scope_key` (commit, merge-base, or a
worktree fingerprint), which drives skipping and continuity.

**The reviewer's bar.** The prompt sets a staff-engineer standard and, crucially, a floor for
what counts as a finding:

- run the scope's git commands first and read the touched sources beyond the diff - no reviews
  from assumptions;
- check correctness edge cases, architecture boundaries, security, and performance, then run
  omission detection: *what should have changed but did not* (unhandled enum variants, callers
  left on an old contract, a new field never reset or serialized);
- every P0/P1 must include a concrete failure scenario - no scenario, no P0/P1;
- a few high-signal issues beat many minor ones, an empty review is a valid result, and
  formatting, naming, or missing-docs nits are out of bounds unless they hide a real bug risk.

The verdict is mechanical: `BLOCK` for any P0, `ATTENTION` for any P1, `OK` otherwise.

**Repo rules as acceptance criteria.** The runner loads the target repository's `AGENTS.md` and
`REVIEW_GUIDELINES.md` into the prompt. Violations of the repo's own "MUST"/"NEVER" rules are
P1+ when they can affect correctness, security, reliability, or reviewability - the review
enforces your standards, not generic taste.

**Isolation.** The reviewer runs as `codex exec --ephemeral` with network access disabled and
explicit read-only instructions; it may not run formatters, tests, or generators that write into
the worktree. Its verbose transcript goes to a Git-private `codex-exec.log` - the driver's
context receives only short status lines and the final review, so a chatty reviewer cannot flood
the main agent.

**Structured output.** Besides the human-readable review, the reviewer must return
machine-checkable state (`--output-schema`): open issues with severity, category, file, failure
scenario, and suggested fix. Everything downstream - continuity, dispositions, verdict
reconciliation - operates on that state, not on prose.

## The continuity ledger

The ledger is what makes pass N+1 cheaper and smarter than pass N:

- **Stable finding IDs.** Issues keep their IDs across passes. A finding that is still open
  stays one finding; a finding the new code fixes moves to `recently_resolved_issues` and shows
  up under "Resolved Since Last Review" instead of being rediscovered.
- **No duplicate hunting.** The previous state and previous review are injected into the next
  prompt with a hard rule: do not re-report an issue already in `open_issues` without materially
  new evidence.
- **No wasted model runs.** If the scope and review inputs are unchanged since the last pass,
  the runner exits without spending a model call. `--force` re-reviews the same scope;
  `--reset` deliberately starts a fresh chain.
- **Auditability.** Every run archives its prompt, output, review, and state under
  `runs/<timestamp>/`, so you can reconstruct what any pass saw and said.

## Quick start

```bash
# review a branch against main
node scripts/run-local-review.cjs --repo-dir ../my-repo --base origin/main

# review uncommitted work, with the owner's scope contract
node scripts/run-local-review.cjs --repo-dir ../my-repo --uncommitted \
  --goal "Add a POST /exports endpoint that renders one report as a PDF" \
  --non-goals "No job queue, no persistent export registry, no credential changes" \
  --focus docs/exec-plans/active/my-plan.md
```

Requirements: Git, Node.js 18+, an authenticated `codex` CLI. The reviewer runs with network
disabled and must not modify the repository - a mutation guard enforces this.

## What keeps the loop from drifting

The machinery above makes a single pass good. The layer below makes an *autonomous loop* of
passes safe - it exists because a review loop without external structure tends to spiral:
findings beget fixes, fixes beget surface, surface begets findings.

Each mechanism is enforced in code, not requested in prose. That is a deliberate design rule:
instructions like "please assess findings" hold only for drivers that already have good
judgment; mechanical gates hold for everyone.

### The review contract (`--goal`, `--non-goals`, `--focus`)

The reviewer receives the owner's scope up front and is instructed to judge findings against it,
treat out-of-focus changes as context, and report scope growth *as a finding* - never to propose
machinery to support it. Suggested fixes must stay proportional to the change under review.

Why: without an anchor, a reviewer validates findings against the artifact's own ambitions. A
plan that invented strong guarantees for itself will produce endless "valid" findings about the
gaps in those guarantees.

### Visible dispositions and the scope-impact rule

Before any file changes, the driver posts a disposition for every finding: `actionable now`,
`defer or accept risk`, or `reject`, with a reason. A finding whose fix would add a new
guarantee, persistent state, a scheduler, or a lifecycle may be actionable only when the failure
is demonstrated against real code or a test AND the fix fits the scope anchor. Otherwise it
becomes a named follow-up for the owner - never silently folded in.

Why: "valid finding" and "must fix now" are different judgments. Collapsing them is how review
loops turn a one-request feature into a distributed-systems project.

### The convergence protocol

The loop stops on falling yield, not on a clean verdict:

- two consecutive passes with nothing new close the loop;
- a rejected finding re-raised a second time closes the loop;
- findings drifting from concrete defects into speculation beyond the anchor close the loop.

There is no fixed pass cap, and a reviewer `OK` is not required. A single pass is a sample, not
an exhaustive audit - reviewers surface a few high-signal issues per pass and go deeper as the
obvious ones clear. Healthy loops routinely run 10-20+ passes and stay cheap; unhealthy loops
are the ones chasing a clean verdict.

### Owner dispositions (`dispositions.json`)

Rejected and deferred findings are recorded in the ledger:

```json
[
  { "id": "RR-001", "disposition": "rejected", "reason": "Conflicts with the product decision to keep sends single-shot." }
]
```

The runner then closes the loop around them:

- Recorded dispositions are injected into the next reviewer prompt with a do-not-re-raise
  instruction, and filtered out of open issues and the verdict. Settled findings stop coming
  back pass after pass.
- If the reviewer re-emits one anyway, the runner appends an authoritative *"Effective verdict
  after owner dispositions"* note to the review, computed from the filtered state. The loop
  never acts on a verdict that counts settled findings.
- A dispositioned ID names exactly that incarnation of the finding. Materially new evidence
  must arrive under a fresh ID (referencing the old one), which survives filtering and drives
  the verdict - an old disposition can never hide a real regression.
- Disposition IDs are validated against the chain's cumulative `known_issue_ids`. An ID no pass
  has ever reported fails early with a clear message, so a typo cannot silently suppress a
  future unrelated finding. Fail loudly beats suppress silently, everywhere in this design.
- Accepted findings need no entry: the fix plus its regression test is the record.

Dispositions are the loop's memory. Undocumented rejections are why reviewers re-litigate the
same findings - the decision existed only in a conversation that context compaction erased.

### Failed runs are not evidence

- Reviewer output reaches the ledger root only on success. A failed run (nonzero exit, mutation
  guard, timeout) quarantines its output as `codex-review-output.rejected.json` - there is no
  usable-looking findings file to mine.
- If earlier runs produced output that never persisted into `state.json`, the runner refuses to
  start and reports broken continuity instead of silently degrading into fresh full reviews.
  `--reset` is the explicit way to start a new chain.
- Canonical artifacts are promoted in a safe order: continuity state first, reset-disposition
  rotation last, so an interrupted promotion cannot rotate dispositions for a chain that was
  never promoted.

Why: a broken ledger is invisible in the review text. Each pass looks fine while the loop
quietly loses its memory - every pass becomes a first pass, and every first pass re-finds
everything.

### A scope-aware mutation guard

The runner fingerprints the worktree before and after the reviewer runs. Any change to tracked
or untracked files fails the run and reports which paths changed. Gitignored runtime artifacts
(build output, caches, dev-server logs) are excluded: they are never part of a review scope, so
they must not invalidate a review - in practice they are the main thing that breaks ledgers when
a dev server runs next to a review.

### A built-in timeout

`--timeout-min` (default 20) kills a hung reviewer. Healthy passes finish in single-digit
minutes, so exceeding the limit is almost certainly a hang, not deep thinking. The timeout lives
in the runner because external watchdogs proved fragile - a stale one once killed a healthy pass.

### Context-aware skipping

The "already reviewed" check hashes the semantic review inputs - goal, non-goals, focus,
dispositions - alongside the repository scope. Changing any of them re-triggers a review on an
unchanged checkout; identical inputs skip and save a model run.

## Where decisions live

Two different lifetimes, two different homes:

- **The ledger is loop memory.** It lives with the checkout and dies with it (pruned worktrees
  take their ledgers along). Right for continuity, dispositions, and run artifacts.
- **Committed artifacts are project memory.** Decisions that must outlive the loop - product
  rejections, consciously accepted risk - additionally go into the project's plan or decision
  log with the finding ID. The ExecPlan template in this skill's source repository
  (https://github.com/kjendrzyca/repo-harness) bakes this in.

## Testing the driver, not just the reviewer

The skill's source repository ships a driver eval (`evals/local-code-review-driver/`, not part
of the installed skill) that evaluates the other half of the system: whether a driver model
following this skill actually produces visible dispositions and refuses scope growth. The fixture mixes real in-scope bugs with tempting scope-expanders
(persistent claim registries, credential generations, exactly-once outboxes); the grader accepts
only explicit disposition labels near each finding ID - negations, buried prose, and borrowed
verdicts never count.

This matters because the failure mode this skill defends against lives in the driver. A reviewer
can be aggressive by design as long as the driver filters it; the eval checks that the filtering
actually happens.

## Battle-tested on itself

The hardening described above was reviewed by its own loop: eight autonomous passes of this
runner over this skill's uncommitted changes. The loop found real problems in the new code
(including a privacy leak in generated eval artifacts and a validation regression its own
fail-early check caught before the reviewer even started), the driver fixed nine findings with
regression tests, deferred three with recorded reasons, and the loop converged to a clean
verdict by falling yield - not by verdict chasing. The continuity ledger kept stable finding IDs
across all passes with zero duplicates.

## File map

```text
SKILL.md                          driver workflow: modes, dispositions, convergence protocol
scripts/run-local-review.cjs      the runner: reviewer subprocess, ledger, guards
references/review-prompt.md       the reviewer's prompt template
references/continuity-contract.md ledger layout and state rules
assets/local-output-schema.json   structured output schema for the reviewer
```

Ledger layout (Git-private, per checkout):

```text
$(git rev-parse --git-path codex-review)/
  state.json          continuity: open issues, resolved issues, known IDs, scope + context keys
  review.md           latest review (with effective-verdict note when applicable)
  dispositions.json   owner decisions: rejected/deferred findings with reasons
  runs/<timestamp>/   per-run artifacts, including quarantined output of failed runs
```
