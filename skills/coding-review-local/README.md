# Coding Review Local

Run the same local code-review workflow with one of three reviewer CLIs:

- Codex, the default: `gpt-5.6-sol` with high reasoning
- Claude Code: `fable` with high effort
- GitHub Copilot: `gpt-5.6-sol` with high effort

The invoking agent drives the review. A separate reviewer subprocess inspects a branch, commit, or
uncommitted worktree and returns structured findings. A Git-private ledger preserves finding IDs,
resolved issues, and owner dispositions across passes and provider switches.

## Install

For Claude Code and GitHub Copilot:

```bash
npx skills add github.com/kjendrzyca/repo-harness \
  --skill coding-review-local \
  --agent claude-code github-copilot \
  --global \
  --yes
```

For all detected agents:

```bash
npx skills add github.com/kjendrzyca/repo-harness \
  --skill coding-review-local \
  --agent '*' \
  --global \
  --yes
```

Requirements: Git, Node.js 18+, and an authenticated CLI for the selected reviewer.

## Run

Ask your agent to use the skill and name the reviewer:

```text
Use coding-review-local to review my uncommitted changes with Claude.
Use coding-review-local to review this branch against origin/main with GitHub Copilot.
Use coding-review-local to review HEAD with the default Codex provider.
```

Direct runner examples:

```bash
# Codex - default
node scripts/run-local-review.cjs --repo-dir ../my-repo --base origin/main

# Claude Code - defaults to fable/high
node scripts/run-local-review.cjs --repo-dir ../my-repo --uncommitted --provider claude

# GitHub Copilot - defaults to gpt-5.6-sol/high
node scripts/run-local-review.cjs --repo-dir ../my-repo --commit HEAD --provider copilot
```

Override model and effort only when you mean to change review quality or run a cheap smoke test:

```bash
node scripts/run-local-review.cjs --repo-dir ../my-repo --uncommitted \
  --provider claude --model haiku --effort low
```

## Safety and continuity

- The runner collects the exact Git scope into private artifacts before starting the reviewer.
- Codex keeps the existing `local-code-review` invocation and sandbox defaults.
- Claude and Copilot receive only file read, search, and listing tools.
- Reviewer skills, custom instructions, hooks, and MCP servers are disabled where the CLI supports it.
- The mutation guard rejects a pass if the target worktree, refs, or private scope artifacts change while it runs.
- Verbose CLI output and continuity state stay under
  `$(git rev-parse --git-path coding-review-local)/`.
- Switching provider, model, or effort triggers a new pass and carries prior
  findings forward; an unexplained missing finding fails the pass.
- Finding IDs must be non-empty and unique.
- Failed runs quarantine any structured output so their findings cannot enter continuity state.

See [`SKILL.md`](SKILL.md) for review-and-report mode, autonomous remediation, dispositions, and
convergence rules.
