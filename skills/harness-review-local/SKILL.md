---
name: harness-review-local
description: Run a high-signal local code review from a checked-out repository with Codex, Claude Code, or GitHub Copilot CLI, plus a Git-private continuity ledger. Use when reviewing a local branch, commit, uncommitted changes, or PR without a CI bot, including explicit autonomous remediation loops. Codex is the default reviewer; Claude and Copilot are selectable providers.
license: MIT
---

# Harness Review Local

Run a bundled staff-level review prompt through one of three reviewer CLIs. The reviewer is told not
to modify the checkout. The invoking agent remains the driver: it assesses findings, decides what
fits the user's scope, and makes changes only when the user requested remediation.

This skill does not install workflows, set GitHub secrets, or post GitHub comments.

## Requirements

- Git
- Node.js 18+
- An authenticated CLI for the selected provider: `codex`, `claude`, or `copilot`

The runner keeps the Git-private `coding-review-local` storage path unchanged after the skill rename,
so existing findings and dispositions remain available without migration. Codex runs in a fixed
read-only sandbox while keeping the user's Codex config and rules. Claude and Copilot inspect private
scope artifacts through read/search tools only. A mutation guard rejects any run that changes the
target worktree.

## Choose the reviewer explicitly

Codex remains the default when `--provider` is omitted.

| Provider | Flag | Default model | Default effort |
| --- | --- | --- | --- |
| Codex | `--provider codex` | `gpt-6-astra` | `high` |
| Claude Code | `--provider claude` | `fable` | `high` |
| GitHub Copilot | `--provider copilot` | `gpt-5.6-sol` | `high` |

The agent hosting this skill and the reviewer subprocess are separate roles. Running the skill from
Claude Code does not automatically select Claude as the reviewer. Follow the user's provider choice.
If the user did not choose and Codex is unavailable, ask which available provider to use instead of
silently changing reviewer or model.

Do not silently fall back between providers, models, or effort levels after an auth, quota, model, or
CLI error. Report the blocker.

## Workflow

1. Choose the operating mode from the user's request.
2. Make sure the target repository is checked out at the branch or commit to review.
3. Choose one scope:
   - branch: `--base <base-ref>`
   - single commit: check out the target commit as `HEAD`, then use `--commit HEAD`
   - current worktree: `--uncommitted`
4. Run the script from this skill, with the selected provider:

   ```bash
   node scripts/run-local-review.cjs \
     --repo-dir <target-repo> \
     --base <base-ref> \
     --provider <codex|claude|copilot>
   ```

5. Read the Markdown review printed by the script. The same review and structured continuity state
   live under the checkout's Git-private `coding-review-local` path.
6. Assess every finding under Review rules before reporting it or changing code.

## Operating modes

### Review and report

Use this by default when the user asks for findings or an assessment without asking for code changes.

1. Run one review pass.
2. Assess every finding under Review rules.
3. Report each reviewer finding with the driver's disposition and reason.
4. Do not modify code or run another pass unless the user asks.

### Autonomous remediation

Use this only when the user explicitly asks the driver to fix findings, iterate, or continue until the
work is complete.

**Guiding principle:** Watch out for scope creep, and assess every finding yourself. Remember you
are the decision-maker.

Before the first pass:

1. Record the scope anchor: the user's goal, explicit non-goals, and real usage profile. Pass it with
   `--goal` and `--non-goals`; narrow plan or document reviews with `--focus`.
2. State the stop criteria from the convergence protocol below.

For each pass:

1. Run one pass and wait for it to finish.
2. Verify each finding against the actual code and scope anchor. Ask "does the requested change need
   this?", not only "can this failure happen?" Judge the suggested fix separately from the finding.
3. Post one disposition per finding before changing files:
   - `actionable now`
   - `defer or accept risk`
   - `reject`
4. Persist deferred and rejected dispositions as described below.
5. Fix only `actionable now` findings, with a regression test when applicable.
6. Run relevant checks, then rerun review only when another pass can add useful evidence.

A fix that adds a new guarantee, persistent state, database table, scheduler, lifecycle, or
credential-storage change may be `actionable now` only when a failure is demonstrated against real
code or a test and the fix fits the scope anchor. Otherwise defer it as a named follow-up for owner
approval. In plan reviews, where code cannot falsify the claim, new guarantees default to defer.

## Convergence protocol

- Close the loop on the first pass with no newly accepted findings when every finding still open has
  a recorded disposition. Do not rerun an unchanged checkout only to obtain an `OK` verdict.
- The closing pass must see the final state. After fixing accepted findings, run one review on the
  fixed checkout and assess it.
- If a rejected finding appears a second time, keep the documented rejection or close the loop. Do
  not re-litigate it.
- Close the loop when findings drift from concrete defects into speculative guarantees outside the
  scope anchor.
- Carry prior deferred and rejected dispositions forward unless code or evidence materially changes.

The driver decides when work is complete. The final report must include review passes, fixes,
deferred or rejected findings with reasons, validation results, and the reason the loop stopped.

## Record dispositions

Write `rejected` and `deferred` decisions to:

```text
$(git rev-parse --git-path coding-review-local)/dispositions.json
```

Example:

```json
[
  { "id": "RR-001", "disposition": "rejected", "reason": "Conflicts with the product decision to keep sends single-shot." }
]
```

The runner injects these decisions into later passes and removes them from open issues and the
effective verdict. `actionable now` findings need no ledger entry: the fix and regression test are
the record.

Decisions that must outlive the checkout also belong in the project's plan or decision log, with the
finding ID. The private ledger is loop memory, not durable project memory.

## Do not touch the target repository during a run

Until the runner exits, do not:

- edit source files
- run tests, builds, lints, or generators
- run Git operations
- start a dev server or any process that writes into the repo

The mutation guard compares HEAD, refs, tracked changes, untracked files, and the private scope
artifacts before and after the review. Gitignored runtime artifacts are excluded. If parallel work is
needed, review a separate Git worktree.

The built-in timeout is 20 minutes by default. Do not add an external watchdog.

A failed run provides no usable findings. On nonzero exit, timeout, mutation, malformed JSON, or
schema failure, the runner quarantines structured output as `reviewer-output.rejected.json` and does
not update continuity. The quarantined file remains audit evidence but does not block a fresh retry.
A caught promotion failure removes its run state/review snapshot and restores the prior canonical
artifacts, or removes partial canonical artifacts when no prior pass exists. Report the error, fix
its cause, and rerun. Never mine a failed run for findings.

## Keep verbose output out of the driver context

Run the command once and wait. The runner writes CLI stdout and stderr under:

```text
$(git rev-parse --git-path coding-review-local)/runs/<timestamp>/
```

It prints only status lines and the final review. Do not add `tee`, tail live logs, or repeatedly poll
large output into the conversation. On failure, inspect a bounded tail or targeted match.

## Commands

```bash
# Codex - default provider
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main

# Claude Code - production workshop settings are the defaults for this provider
node scripts/run-local-review.cjs --repo-dir <target-repo> --uncommitted --provider claude

# GitHub Copilot - production workshop settings are the defaults for this provider
node scripts/run-local-review.cjs --repo-dir <target-repo> --commit HEAD --provider copilot

# Explicit model and effort override
node scripts/run-local-review.cjs --repo-dir <target-repo> --uncommitted \
  --provider claude --model haiku --effort low

# Scope contract for an autonomous loop
node scripts/run-local-review.cjs --repo-dir <target-repo> --uncommitted \
  --provider copilot \
  --goal "Add a POST /exports endpoint that renders one report as a PDF" \
  --non-goals "No job queue, persistent export registry, or credential changes" \
  --focus docs/exec-plans/active/my-plan.md

# Build prompt, private scope artifacts, and schema without a model call
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --no-reviewer

# Other controls
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --reset
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --force
node scripts/run-local-review.cjs --repo-dir <target-repo> --base origin/main --timeout-min 30
```

Use low-cost models only for smoke tests. For real reviews, keep the explicit provider defaults above
unless the user chooses another model.

## Behavior

- The runner snapshots scope with ordinary Git commands before invoking the reviewer. Claude and
  Copilot inspect those private artifacts plus repository files through read-only tools.
- The ledger must stay inside the checkout's Git metadata. The default is
  `$(git rev-parse --git-path coding-review-local)/`; custom paths outside `.git` are rejected.
- Canonical state and its issue records are validated before they can seed or suppress a pass.
  `state.json` is written last as the success marker after the review and structured output are ready.
- Switching provider, model, or effort reruns the same scope and carries previous findings forward.
  Every prior open finding must remain open, be explicitly resolved, or have an owner disposition.
- Structured issue state determines the effective verdict. The runner corrects contradictory
  reviewer Markdown before saving or printing it.
- Finding IDs must be non-empty and unique, and an ID cannot be both open and resolved in one pass.
- An identical scope, contract, provider, model, effort, and disposition set skips the model call.
- `--force` reruns identical inputs. `--reset` starts a new continuity chain and rotates dispositions
  only after a successful pass.
- Branch and commit reviews require a clean worktree. Commit reviews also require the target commit
  at `HEAD`. Use a temporary worktree to review an older commit.
- `--uncommitted` includes staged, unstaged, and untracked files in the scope fingerprint.

See [references/continuity-contract.md](references/continuity-contract.md) for the ledger contract.

## Review rules

The reviewer does not have the driver's full conversation. Treat its output as evidence.

Classify every finding as:

- `actionable now` - valid, material, in scope, and relevant to the supported operating model
- `defer or accept risk` - valid, but outside scope or not worth added complexity now
- `reject` - incorrect, stale, minor, or based on unsupported assumptions

State each disposition and reason before modifying the reviewed artifact. Make the smallest justified
change for accepted findings. Do not change code for rejected findings.

Also:

- Report findings first, ordered by severity.
- Do not invent issues. No concrete P0/P1 findings is a valid result.
- Preserve stable IDs for open findings and mark fixed prior findings as resolved.
- Do not rerun only to silence a deferred or rejected finding.
- Do not commit generated review artifacts unless the user explicitly asks.
- If the script reports no new scope, report that instead of forcing a pass.
