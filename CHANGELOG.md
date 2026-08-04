# Changelog

All notable changes to this project will be documented in this file.

Entries are grouped by ISO 8601 dates (`YYYY-MM-DD`). This repository does not maintain separate version numbers unless it later becomes a packaged or released artifact.

Within each date, every change should get its own `### <Change title>` section. Add new sections above older sections for the same day. This keeps diffs clean and avoids growing one large mixed list.

## 2026-08-04

### Add a Provider-Selectable Local Review Skill

- Add `coding-review-local` as a separate skill so the existing Codex-only `local-code-review`
  contract stays unchanged.
- Keep Codex as the default reviewer and add explicit Claude Code and GitHub Copilot providers,
  with Fable/high and GPT-5.6 Sol/high as their production defaults.
- Collect exact scope artifacts in Git-private metadata, restrict Claude and Copilot to read/search
  tools, parse each CLI's structured output format, and preserve one continuity ledger across
  provider or model switches.
- Validate provider output before normalization and reject missing, blank, duplicate, or conflicting
  finding IDs.
- Require prior open findings to remain open, resolve, or have an owner disposition when providers
  switch.
- Add provider command tests, fail-closed output tests, mutation-guard coverage, and real low-cost
  smoke tests for Claude Code and GitHub Copilot.

## 2026-07-26

### Close the Review Loop on the First Clean Pass

- Replace the two-consecutive-clean-passes stop rule: the loop closes on the first pass that
  yields no newly accepted findings, with every still-open finding carrying a recorded
  disposition. No confirmation pass on an unchanged checkout; later stages (implementation,
  tooling, the next review) cover the residual risk of a single clean sample.
- The stop condition is phrased in driver-side facts checkable when the pass returns; the
  effective `OK` verdict is a consequence, not a state to chase with another pass.
- The closing pass must have seen the final state: fixes always get one more pass; never end the
  loop with fixes no pass has reviewed.

### Add a Bird's Eye View Section to the ExecPlan Template

- Add a mandatory-for-architecture-changes "Bird's Eye View" section to the ExecPlan skeleton:
  before/after ASCII diagrams, a REMOVED/ADDED/UNCHANGED key-changes table, and a data flow
  trace, scannable in under 60 seconds.
- Add a matching "start with a visual map" guideline.

### Bound Reviewer Search Output

- Add a search-hygiene rule to both review prompts: always use `rg --max-columns=240`, scope
  searches with `--glob`, and skip generated data files unless the change touches them. A broad
  `rg` over source trees was collaterally matching single-line generated files (eval datasets),
  flooding a single command output with hundreds of kilobytes of noise that `head` cannot cap.

### Silence the Undispositioned-Findings Warning When the Checkout Changed

- Warn about open findings without a recorded disposition only when the checkout is unchanged
  since the previous pass (and not on `--reset`). Fix-then-rerun loops no longer see the warning
  on every pass, so it fires only when the loop is neither fixing nor dispositioning findings.

## 2026-07-24

### Make local-code-review Self-Contained

- Remove repo-harness references from the skill description, prompts, runner help, and README:
  the skill can be installed standalone in projects that have no bundle context.
- Point to the source repository by URL where context helps (CI bot skill, ExecPlan template,
  driver eval).
- Add a repository convention: skill content must not assume the bundle context.

### Harden the Autonomous Review Loop Against Scope Growth

- Require a scope anchor (goal, non-goals, usage profile) and visible per-finding dispositions
  before any edit.
- Scope-impact rule: fixes that add guarantees, persistent state, schedulers, or lifecycles
  default to defer and need owner approval.
- Convergence protocol instead of open-ended looping: stop after two passes with nothing new, on
  a second re-raise of a rejected finding, or when findings drift beyond the anchor.
- Dispositions must be persisted outside the conversation; design-level rejections also go into
  the ExecPlan Decision Log with the finding ID (template updated).

### Record Owner Dispositions in the Continuity Ledger

- Add `dispositions.json`: rejected/deferred findings are injected into the reviewer prompt with
  a do-not-re-raise instruction and filtered out of open issues and the verdict.
- Append an "Effective verdict after owner dispositions" note when the reviewer still mentions or
  re-emits a dispositioned finding.
- Materially new evidence requires a fresh finding ID; the old ID stays filtered.
- Validate disposition IDs against the chain's cumulative `known_issue_ids`; unknown IDs fail
  early. Legacy states migrate from the latest successful run's snapshot.
- The "already reviewed" skip also hashes goal, non-goals, focus, and dispositions, so changed
  review inputs trigger a fresh pass on an unchanged checkout.
- `--reset` rotates `dispositions.json` aside, but only after the reset pass succeeds.
- Warn when open findings from the previous pass have no recorded disposition.

### Make Failed Review Runs Unusable as Evidence

- Reviewer output reaches the ledger root only on success; failed runs (nonzero exit, mutation
  guard, timeout) quarantine it as `codex-review-output.rejected.json`.
- Stop with a broken-continuity error when earlier runs never persisted `state.json`; `--reset`
  starts over explicitly.
- Promote artifacts in a safe order: continuity state first, reset-disposition rotation last.

### Scope-Aware Mutation Guard and Built-In Timeout

- Exclude gitignored runtime artifacts from the mutation guard fingerprint.
- Report which paths changed when the guard fails; content changes in already-dirty files are
  reported as candidate lists.
- Kill hung reviewer runs after `--timeout-min` (default 20 minutes).

### Pass a Review Contract to the Reviewer

- Add `--goal`, `--non-goals`, and `--focus`; the reviewer judges findings against the owner's
  scope and reports scope growth as a finding instead of proposing machinery for it.

### Add a Driver Disposition Eval

- Add `evals/local-code-review-driver/`: fixture findings (real in-scope bugs plus
  scope-expanders) and a runner that grades any driver command on visible dispositions and
  refusal of scope growth.
- The grader accepts only explicit labels near the finding's own ID; negations, buried prose, and
  cross-finding borrowing never count. Covered by unit tests.
- Ignore `evals/local-code-review-driver/workspaces/` (generated transcripts may contain
  machine-local paths).

## 2026-07-23

### Keep Reviewer Transcripts Out of Driver Context

- Capture verbose `codex exec` stdout and stderr in a Git-private log for each local review run.
- Print only short runner status lines and the final Markdown review to the invoking agent.
- Add regression coverage that prevents verbose reviewer output from leaking through successful or
  failed runs.

### Add Local Review Operating Modes

- Add a default review-and-report mode and an explicit autonomous remediation mode to
  `local-code-review`.
- Require the main agent to assess every reviewer finding against the full task context, fix only
  actionable findings, and record reasons for deferred or rejected findings.
- Define completion by the main agent's assessment and relevant validation instead of requiring the
  reviewer to return an `OK` verdict.

## 2026-07-13

### Update the Bundled Review Bot Model and Codex CLI

- Change the bundled GitHub Action review bot default to `gpt-5.6-sol` with `high` reasoning.
- Pin `@openai/codex@0.144.3`, from the first stable release line that bundles
  `gpt-5.6-sol` model metadata.

### Lower the Default Local Review Reasoning Effort

- Change the `local-code-review` runner, legacy comparison runner, and eval harness default reasoning
  effort from `xhigh` to `high`. The default model remains `gpt-5.6-sol`.

## 2026-07-12

### Update the Default Local Review Model

- Change the `local-code-review` runner, legacy comparison runner, and eval harness default from
  `gpt-5.5` to `gpt-5.6-sol`, keeping `xhigh` reasoning as the default.

## 2026-07-10

### Warn Against Modifying the Repository During a Local Review Run

- Add a "Do not touch the target repository during a run" rule to the `local-code-review` skill:
  while `run-local-review.cjs` is running, invoking agents must not edit sources, run
  tests/builds/lints that write artifacts, perform git operations, or start dev servers writing into
  the repo, because the mutation guard diffs the worktree before/after and treats any change as a
  failed integrity check. Parallel work belongs in a separate `git worktree`.
- Print a one-line stderr notice when the review starts ("Review in progress - do not modify the
  repository until this process exits").
- Motivation: concurrent worktree mutations were tripping the mutation guard and invalidating
  otherwise good reviews.

## 2026-07-04

### Harden Local Code Review Eval Safety

- Validate `local-code-review` eval run IDs before creating or recursively replacing a workspace, so
  `--run-id` cannot escape `evals/local-code-review/workspaces/`.
- Update the legacy bot-parity runner's mutation guard to compare raw Git diffs instead of only
  filename/status output.

### Rename Local Code Review Skill

- Rename the local review skill from `code-review` to `local-code-review` so it is clearly distinct
  from the `install-code-review-bot` GitHub Action installer.
- Update the README install command, local eval harness path, and skill metadata for the new public
  install target: `npx skills add github.com/kjendrzyca/repo-harness --skill local-code-review`.

## 2026-07-03

### Add Eval-Driven Local Code Review Runner

- Add a lighter local `local-code-review` runner that keeps the repo-harness review prompt and structured
  continuity state while avoiding `.codex-ci/` diff artifacts in the reviewed repository.
- Store scope-keyed local review continuity under Git's private `codex-review` path by default, and
  fail if the review run changes the checkout/worktree or if the mutation guard cannot collect a
  complete Git inventory within its output limits.
- Require a clean worktree for branch and commit reviews, and require commit reviews to run from a
  checkout whose `HEAD` is the reviewed commit. Use the uncommitted scope when local changes are
  intended.
- Add a local-code-review eval harness that compares the legacy bot-parity runner with the local runner on
  an omission-detection and resolved-issue continuity fixture.

## 2026-07-01

### Split Local Code Review From Bot Installation

- Rename the GitHub Action installer skill from `codex-review` to `install-code-review-bot`.
- Add `code-review`, a local Codex review skill that reuses the bot's prompt and output schema,
  builds `.codex-ci/` artifacts, keeps local continuity state under `.git/codex-review/`, and prints
  the Markdown review instead of posting GitHub comments.

## 2026-06-12

### Add Hard Constraint: Doc Updates Belong in the Same Commit

- Add a hard constraint to `SKILL.md`: when generating or updating `AGENTS.md`, always include a local rule naming the canonical docs and what triggers an update - if a change touches user-facing behavior, a public interface, or anything already documented, the doc update goes in the same commit.

## 2026-06-05

### Mark Codex Review as Private-Repo-Only

- Mark `codex-review` as intended for private repositories only.

## 2026-05-30

### Add codex-review Skill; Consolidate the Bot Into It

- Add `skills/codex-review/`, a skill that installs, authenticates, and rotates the Codex PR-review
  bot on a repo: installs the bundle, provisions a dedicated isolated Codex login (its own
  `CODEX_HOME`/`auth.json`, separate from `~/.codex`), and sets the `CODEX_AUTH_JSON_B64` secret.
- Move the bot bundle from `tools/codex-review/` into the skill at
  `skills/codex-review/assets/bundle/` and remove the standalone `tools/codex-review/` directory.
  The installed layout in target repos is unchanged (`.github/workflows/codex-review.yml` +
  `.github/scripts/codex-review/`), so the workflow needs no path changes.

### Fix Codex Review Sandbox Probe and Pin Codex CLI

- Pin `@openai/codex@0.135.0` in the review bot's "Install Codex CLI" step. The unpinned `latest` shipped a `codex sandbox` CLI change that silently broke the sandbox probe.
- Update the probe from `codex sandbox linux /bin/true` to `codex sandbox -- /bin/true` to match the current CLI, which removed the `linux` positional (the old form tried to `execvp` a binary named `linux` and failed).

## 2026-05-28

### Clean Up SKILL.md Frontmatter

- Remove redundant `compatibility` field (per Agent Skills spec: most skills do not need it; ours was effectively tautological).
- Add `license: MIT` field to match the new `LICENSE` file.

### Standardize Installation and Authoring Rules

- Rewrite README installation to use `npx skills add github.com/kjendrzyca/repo-harness --skill repo-harness`. Remove manual copy paths that referenced an incorrect `.opencode/skills/` location and a misleading `.claude/skills -> .agents/skills` symlink chain.
- Add Spec compliance, Privacy (public repo), and Conventions sections to AGENTS.md, aligned with `kjendrzyca/public-skills`.
- Add MIT LICENSE.

## 2026-05-26

### Add Diagnostic Signals to Principles

- Add explicit `AGENTS.md` growth signal to section 2.3: when you keep wanting to add another detail, that itself is the trigger to move detail into `docs/`.
- Add explicit exec-plan readiness signal to section 2.8: when a meaningful change no longer fits in one clean prompt, the repo has earned execution plans.

## 2026-04-30

### Add Codex Review Bot Tool

- Add `tools/codex-review/`, a copyable GitHub Actions PR review bot powered by the Codex CLI.
- Add installation notes for the Codex review bot, including auth setup, trigger options, and security considerations.
- Document the cost tradeoff of running the review bot with `gpt-5.5` and `xhigh` reasoning.

### Publish Initial Repo Harness

- Publish the initial `repo-harness` skill bundle.
- Add repository harness principles for progressive, agent-friendly repo documentation.
- Add core-beliefs references and templates.
- Add ExecPlan references and a copyable ExecPlan template.
- Document that the bundled ExecPlan template is based on OpenAI's execution plans guidance.
