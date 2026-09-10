#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const SCRIPT_DIR = __dirname
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..')
const PROMPT_TEMPLATE = path.join(SKILL_ROOT, 'references', 'review-prompt.md')
const OUTPUT_SCHEMA = path.join(SKILL_ROOT, 'assets', 'local-output-schema.json')
const LEDGER_NAME = 'coding-review-local'
const SUPPORTED_PROVIDERS = new Set(['codex', 'claude', 'copilot'])
const MAX_GIT_OUTPUT_BUFFER_BYTES = envPositiveInteger(
  'CODE_REVIEW_MAX_GIT_OUTPUT_BUFFER_BYTES',
  envPositiveInteger('CODEX_REVIEW_MAX_GIT_OUTPUT_BUFFER_BYTES', 64 * 1024 * 1024),
)
const DEFAULT_TIMEOUT_MINUTES = envPositiveInteger(
  'CODE_REVIEW_TIMEOUT_MIN',
  envPositiveInteger('CODEX_REVIEW_TIMEOUT_MIN', 20),
)
const MAX_REPORTED_MUTATED_PATHS = 20

function envPositiveInteger(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function usage() {
  return `Usage: run-local-review.cjs [options]

Run a local code review with Codex, Claude Code, or GitHub Copilot plus a continuity ledger.

Options:
  --repo-dir DIR        Repository to review (default: current working directory)
  --base REV            Review current branch against base ref (default: origin/HEAD, origin/main, origin/master)
  --commit SHA          Review a single checked-out commit instead of a branch diff; SHA must match HEAD
  --uncommitted         Review staged, unstaged, and untracked changes
  --provider NAME       Reviewer CLI: codex, claude, or copilot (default: codex)
  --model MODEL         Reviewer model (defaults: Codex gpt-6-astra, Claude fable, Copilot gpt-5.6-sol)
  --effort LEVEL        Reviewer reasoning effort (default: high; --reasoning is an alias)
  --reset               Ignore previous local review state
  --force               Review even if the same scope and reviewer settings were already reviewed
  --title TEXT          Review title shown in the prompt
  --pr-body-file FILE   Markdown/text file used as extra review context
  --ledger-dir DIR      Store state inside Git metadata (default: Git-private coding-review-local path)
  --sandbox MODE        Codex-only compatibility flag; only read-only is accepted
  --web-search MODE     Codex-only web_search config (default: CODEX_WEB_SEARCH_MODE or disabled)
  --goal TEXT           Review contract: what the change under review is supposed to deliver
  --non-goals TEXT      Review contract: what is explicitly out of scope for this change
  --focus PATH          Focus the review on this file (repeatable); other changes are context only
  --timeout-min N       Kill the reviewer after N minutes (default: CODE_REVIEW_TIMEOUT_MIN or 20; 0 disables)
  --no-reviewer         Build prompt, scope artifacts, and schema without running a reviewer
  -h, --help            Show this help

Examples:
  node scripts/run-local-review.cjs --repo-dir ../my-repo --base origin/main
  node scripts/run-local-review.cjs --repo-dir ../my-repo --uncommitted --provider claude
  node scripts/run-local-review.cjs --repo-dir ../my-repo --commit HEAD --provider copilot
  node scripts/run-local-review.cjs --repo-dir ../my-repo --base origin/main --no-reviewer
`
}

function providerDefaults(provider) {
  if (provider === 'claude') {
    return {
      model: process.env.CLAUDE_MODEL || 'fable',
      effort: process.env.CLAUDE_EFFORT || 'high',
    }
  }
  if (provider === 'copilot') {
    return {
      model: process.env.COPILOT_MODEL || 'gpt-5.6-sol',
      effort: process.env.COPILOT_EFFORT || 'high',
    }
  }
  return {
    model: process.env.CODEX_MODEL || 'gpt-6-astra',
    effort: process.env.CODEX_REASONING || 'high',
  }
}

function fail(message, code = 1) {
  console.error(`[coding-review-local] ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const opts = {
    repoDir: process.cwd(),
    base: '',
    commit: '',
    uncommitted: false,
    provider: process.env.CODE_REVIEW_PROVIDER || 'codex',
    reset: false,
    force: false,
    title: '',
    prBodyFile: '',
    ledgerDir: '',
    model: process.env.CODE_REVIEW_MODEL || '',
    reasoning: process.env.CODE_REVIEW_EFFORT || '',
    sandbox: 'read-only',
    webSearch: process.env.CODEX_WEB_SEARCH_MODE || 'disabled',
    goal: '',
    nonGoals: '',
    focus: [],
    timeoutMin: DEFAULT_TIMEOUT_MINUTES,
    noReviewer: false,
  }

  const takesValue = new Set([
    '--repo-dir',
    '--base',
    '--commit',
    '--provider',
    '--title',
    '--pr-body-file',
    '--ledger-dir',
    '--model',
    '--effort',
    '--reasoning',
    '--sandbox',
    '--web-search',
    '--goal',
    '--non-goals',
    '--focus',
    '--timeout-min',
  ])

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    let value = null

    if (arg === '-h' || arg === '--help') {
      console.log(usage())
      process.exit(0)
    }

    const eq = arg.indexOf('=')
    if (eq !== -1 && arg.startsWith('--')) {
      value = arg.slice(eq + 1)
      arg = arg.slice(0, eq)
    }

    if (takesValue.has(arg)) {
      if (value == null) value = argv[++i]
      if (value == null || value === '') fail(`${arg} requires a value`)

      if (arg === '--repo-dir') opts.repoDir = value
      else if (arg === '--base') opts.base = value
      else if (arg === '--commit') opts.commit = value
      else if (arg === '--provider') opts.provider = value.toLowerCase()
      else if (arg === '--title') opts.title = value
      else if (arg === '--pr-body-file') opts.prBodyFile = value
      else if (arg === '--ledger-dir') opts.ledgerDir = value
      else if (arg === '--model') opts.model = value
      else if (arg === '--effort' || arg === '--reasoning') opts.reasoning = value
      else if (arg === '--sandbox') opts.sandbox = value
      else if (arg === '--web-search') opts.webSearch = value
      else if (arg === '--goal') opts.goal = value
      else if (arg === '--non-goals') opts.nonGoals = value
      else if (arg === '--focus') opts.focus.push(value)
      else if (arg === '--timeout-min') {
        const parsed = Number.parseFloat(value)
        if (!Number.isFinite(parsed) || parsed < 0) fail('--timeout-min must be a non-negative number')
        opts.timeoutMin = parsed
      }
    } else if (arg === '--uncommitted') {
      opts.uncommitted = true
    } else if (arg === '--reset') {
      opts.reset = true
    } else if (arg === '--force') {
      opts.force = true
    } else if (arg === '--no-reviewer' || arg === '--no-codex') {
      opts.noReviewer = true
    } else {
      fail(`unknown option: ${arg}\n\n${usage()}`)
    }
  }

  const scopeCount = [Boolean(opts.base), Boolean(opts.commit), opts.uncommitted].filter(Boolean).length
  if (scopeCount > 1) fail('use only one of --base, --commit, or --uncommitted')
  opts.provider = opts.provider.toLowerCase()
  if (!SUPPORTED_PROVIDERS.has(opts.provider)) {
    fail(`unsupported provider: ${opts.provider}. Use codex, claude, or copilot.`)
  }

  const defaults = providerDefaults(opts.provider)
  if (!opts.model) opts.model = defaults.model
  if (!opts.reasoning) opts.reasoning = defaults.effort
  if (opts.sandbox !== 'read-only') {
    fail(`Codex sandbox is fixed to read-only; unsupported value: ${opts.sandbox}`)
  }

  return opts
}

function run(command, args, options = {}) {
  let stdoutFileDescriptor
  let stderrFileDescriptor
  let result

  try {
    if (options.stdoutFile) {
      fs.mkdirSync(path.dirname(options.stdoutFile), { recursive: true })
      stdoutFileDescriptor = fs.openSync(options.stdoutFile, 'w', 0o600)
    }
    if (options.stderrFile) {
      fs.mkdirSync(path.dirname(options.stderrFile), { recursive: true })
      stderrFileDescriptor = fs.openSync(options.stderrFile, 'w', 0o600)
    }

    result = spawnSync(command, args, {
      cwd: options.cwd,
      input: options.input,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BUFFER_BYTES,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      stdio: options.inherit
        ? ['pipe', 'inherit', 'inherit']
        : [
            'pipe',
            stdoutFileDescriptor !== undefined ? stdoutFileDescriptor : 'pipe',
            stderrFileDescriptor !== undefined ? stderrFileDescriptor : 'pipe',
          ],
    })
  } finally {
    if (stdoutFileDescriptor !== undefined) fs.closeSync(stdoutFileDescriptor)
    if (stderrFileDescriptor !== undefined) fs.closeSync(stderrFileDescriptor)
  }

  if (result.error) {
    const commandLine = `${command} ${args.join(' ')}`
    if (result.error.code === 'ENOBUFS') {
      fail(
        `${commandLine} exceeded the ${MAX_GIT_OUTPUT_BUFFER_BYTES} byte output buffer. ` +
          'Refusing to continue because the review mutation guard would be incomplete.',
      )
    }
    if (options.allowFailure) return result
    fail(`${command} failed to start: ${result.error.message}`)
  }

  if (result.status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr || '').trim()
    const stdout = (result.stdout || '').trim()
    const outputFiles = [options.stdoutFile, options.stderrFile].filter(Boolean)
    const outputNote = outputFiles.length ? `\nFull output: ${outputFiles.join(', ')}` : ''
    fail(
      `${command} ${args.join(' ')} failed with exit ${result.status}` +
        (stderr ? `\n${stderr}` : stdout ? `\n${stdout}` : outputNote),
    )
  }

  return result
}

function git(repoRoot, args, options = {}) {
  return run('git', args, { ...options, cwd: repoRoot })
}

function gitText(repoRoot, args, options = {}) {
  const result = git(repoRoot, args, options)
  return (result.stdout || '').trim()
}

function gitRaw(repoRoot, args, options = {}) {
  const result = git(repoRoot, args, options)
  return result.stdout || ''
}

function gitCommitExists(repoRoot, rev) {
  return git(repoRoot, ['cat-file', '-e', `${rev}^{commit}`], { allowFailure: true }).status === 0
}

function detectBase(repoRoot) {
  const originHead = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  })
  if (originHead.status === 0 && originHead.stdout.trim()) return originHead.stdout.trim()

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (gitCommitExists(repoRoot, candidate)) return candidate
  }

  fail('could not detect a base ref; pass --base <ref>, --commit <sha>, or --uncommitted')
}

function resolveRepoRoot(repoDir) {
  const dir = path.resolve(repoDir)
  const result = run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
  return result.stdout.trim()
}

function resolveInputFile(repoRoot, filePath) {
  const direct = path.resolve(filePath)
  if (fs.existsSync(direct)) return direct

  const repoRelative = path.resolve(repoRoot, filePath)
  if (fs.existsSync(repoRelative)) return repoRelative

  fail(`file not found: ${filePath}`)
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(
      `canonical review state is invalid at ${filePath}: could not parse JSON: ${error.message}. ` +
        'Repair the ledger or pass --reset to deliberately start a fresh continuity chain.',
    )
  }
}

function requireValidCanonicalState(state, statePath) {
  if (state == null) return
  const invalid = (reason) => fail(
    `canonical review state is invalid at ${statePath}: ${reason}. ` +
      'Repair the ledger or pass --reset to deliberately start a fresh continuity chain.',
  )

  if (!state || typeof state !== 'object' || Array.isArray(state)) invalid('state must be a JSON object')
  if (!Number.isInteger(state.review_count) || state.review_count < 1) invalid('review_count must be a positive integer')
  if (!Number.isInteger(state.schema_version)) invalid('schema_version must be an integer')
  if (typeof state.last_reviewed_head_sha !== 'string') invalid('last_reviewed_head_sha must be a string')
  if (typeof state.scope_key !== 'string') invalid('scope_key must be a string')
  if (!Array.isArray(state.open_issues)) invalid('open_issues must be an array')
  if (!Array.isArray(state.recently_resolved_issues)) invalid('recently_resolved_issues must be an array')
  if (state.review_context_key != null && typeof state.review_context_key !== 'string') {
    invalid('review_context_key must be a string when present')
  }
  if (state.known_issue_ids != null && !Array.isArray(state.known_issue_ids)) {
    invalid('known_issue_ids must be an array when present')
  }
  if (Array.isArray(state.known_issue_ids)) {
    for (const id of state.known_issue_ids) {
      if (typeof id !== 'string' || !id.trim()) invalid('known_issue_ids must contain non-empty strings')
    }
  }
  try {
    validateIssueCollections(state)
  } catch (error) {
    invalid(error.message)
  }
}

function loadGuidelines(repoRoot) {
  const files = ['AGENTS.md', 'REVIEW_GUIDELINES.md']
  const sections = []

  for (const file of files) {
    const filePath = path.join(repoRoot, file)
    if (!fs.existsSync(filePath)) continue
    const content = fs.readFileSync(filePath, 'utf8').trim()
    if (content) sections.push(`### ${file}\n\n${content}`)
  }

  return sections.length
    ? sections.join('\n\n---\n\n')
    : '_No repo guidelines found. Add AGENTS.md or REVIEW_GUIDELINES.md to your repo root for project-specific review rules._'
}

function buildPrompt(vars) {
  let template = fs.readFileSync(PROMPT_TEMPLATE, 'utf8')
  for (const [key, value] of Object.entries(vars)) {
    template = template.split(`\${${key}}`).join(String(value ?? ''))
  }
  return template
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function gitNullList(repoRoot, args) {
  const result = git(repoRoot, args)
  return result.stdout.split('\0').filter(Boolean).sort()
}

function fileType(stat) {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

function fingerprintWorktreeFiles(repoRoot, files, options = {}) {
  let remainingContentBytes = options.maxContentBytes ?? Number.POSITIVE_INFINITY

  return files.map((file) => {
    const absolutePath = path.join(repoRoot, file)
    let stat
    try {
      stat = fs.lstatSync(absolutePath)
    } catch (error) {
      return { path: file, missing: true, error: error.code || error.message }
    }

    const entry = {
      path: file,
      type: fileType(stat),
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }

    if (stat.isSymbolicLink()) {
      try {
        entry.target = fs.readlinkSync(absolutePath)
      } catch (error) {
        entry.readlinkError = error.code || error.message
      }
      return entry
    }

    if (stat.isFile() && options.hashContents !== false) {
      if (stat.size <= remainingContentBytes) {
        try {
          entry.sha256 = sha256File(absolutePath)
          remainingContentBytes -= stat.size
        } catch (error) {
          entry.hashError = error.code || error.message
        }
      } else {
        entry.sha256Skipped = 'content-byte-limit'
      }
    }

    return entry
  })
}

function currentHeadRef(repoRoot) {
  const result = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  return '(detached)'
}

// Gitignored files are deliberately excluded from the mutation signature: they are never part of
// any review scope (branch, commit, or uncommitted), so runtime artifacts such as build output,
// caches, or dev-server logs must not invalidate a review or break ledger continuity.
function worktreeMutationSignatureObject(repoRoot) {
  const untracked = gitNullList(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  return {
    headSha: gitText(repoRoot, ['rev-parse', 'HEAD']),
    headRef: currentHeadRef(repoRoot),
    stagedNames: gitNullList(repoRoot, ['diff', '--cached', '--name-only', '-z']),
    unstagedNames: gitNullList(repoRoot, ['diff', '--name-only', '-z']),
    unstagedDiff: gitRaw(repoRoot, ['diff', '--binary', '--no-ext-diff']),
    stagedDiff: gitRaw(repoRoot, ['diff', '--cached', '--binary', '--no-ext-diff']),
    untrackedFiles: fingerprintWorktreeFiles(repoRoot, untracked),
    status: gitRaw(repoRoot, ['status', '--short', '--untracked-files=all']),
  }
}

function worktreeMutationFingerprint(repoRoot) {
  return sha256(JSON.stringify(worktreeMutationSignatureObject(repoRoot)))
}

function diffNameLists(label, before, after, reasons) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  for (const name of after) {
    if (!beforeSet.has(name)) reasons.push(`${label} added: ${name}`)
  }
  for (const name of before) {
    if (!afterSet.has(name)) reasons.push(`${label} removed: ${name}`)
  }
}

function describeMutation(before, after) {
  const reasons = []

  if (before.headSha !== after.headSha) reasons.push(`HEAD moved: ${before.headSha} -> ${after.headSha}`)
  if (before.headRef !== after.headRef) reasons.push(`HEAD ref changed: ${before.headRef} -> ${after.headRef}`)

  diffNameLists('staged file', before.stagedNames, after.stagedNames, reasons)
  diffNameLists('unstaged file', before.unstagedNames, after.unstagedNames, reasons)

  const beforeUntracked = new Map(before.untrackedFiles.map((entry) => [entry.path, JSON.stringify(entry)]))
  const afterUntracked = new Map(after.untrackedFiles.map((entry) => [entry.path, JSON.stringify(entry)]))
  for (const [file, entry] of afterUntracked) {
    if (!beforeUntracked.has(file)) reasons.push(`untracked file added: ${file}`)
    else if (beforeUntracked.get(file) !== entry) reasons.push(`untracked file changed: ${file}`)
  }
  for (const file of beforeUntracked.keys()) {
    if (!afterUntracked.has(file)) reasons.push(`untracked file removed: ${file}`)
  }

  // For content changes inside already-dirty files the aggregate diffs cannot name the exact
  // culprit, so these entries list candidates. Both staged and unstaged changes are always
  // reported independently.
  if (before.stagedDiff !== after.stagedDiff) {
    reasons.push(`staged content changed in one of: ${after.stagedNames.join(', ') || '(unknown files)'}`)
  }
  if (before.unstagedDiff !== after.unstagedDiff) {
    reasons.push(`unstaged content changed in one of: ${after.unstagedNames.join(', ') || '(unknown files)'}`)
  }
  if (!reasons.length && before.status !== after.status) {
    reasons.push('git status output changed (see git status)')
  }

  const truncated = reasons.length > MAX_REPORTED_MUTATED_PATHS
  const shown = reasons.slice(0, MAX_REPORTED_MUTATED_PATHS)
  if (truncated) shown.push(`... and ${reasons.length - MAX_REPORTED_MUTATED_PATHS} more changes`)
  return shown
}

const REJECTED_OUTPUT_NAME = 'reviewer-output.rejected.json'

// A failed run must not leave a usable-looking findings file behind: rename the structured output
// so nothing downstream can mistake it for a valid review result.
function quarantineFailedRunOutput(runDir, outputRunPath) {
  if (!fs.existsSync(outputRunPath)) return ''
  const rejectedPath = path.join(runDir, REJECTED_OUTPUT_NAME)
  fs.renameSync(outputRunPath, rejectedPath)
  return rejectedPath
}

// Finding IDs are only meaningful within one continuity chain: after --reset a fresh reviewer can
// assign the same ID to an unrelated finding, so stale dispositions would silently suppress it.
// Pair disposition rotation with state promotion. A caught promotion failure restores the current
// chain's file; successful rotation stays inspectable instead of being deleted.
function rotateDispositionsForNewChain(ledgerDir, runId) {
  const dispositionsPath = path.join(ledgerDir, 'dispositions.json')
  if (!fs.existsSync(dispositionsPath)) return null
  const rotatedPath = path.join(ledgerDir, `dispositions.reset-${runId}.json`)
  fs.renameSync(dispositionsPath, rotatedPath)
  return { dispositionsPath, rotatedPath }
}

function loadDispositions(ledgerDir) {
  const dispositionsPath = path.join(ledgerDir, 'dispositions.json')
  if (!fs.existsSync(dispositionsPath)) return []

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(dispositionsPath, 'utf8'))
  } catch (error) {
    fail(`could not parse ${dispositionsPath}: ${error.message}`)
  }

  const entries = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.dispositions) ? parsed.dispositions : null
  if (!entries) fail(`${dispositionsPath} must be an array of dispositions or {"dispositions": [...]}`)

  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      fail(`${dispositionsPath}: every disposition needs a string "id" matching a finding id`)
    }
    if (entry.disposition !== 'rejected' && entry.disposition !== 'deferred') {
      fail(`${dispositionsPath}: disposition for ${entry.id} must be "rejected" or "deferred" (accepted findings are recorded by their fix, not here)`)
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      fail(`${dispositionsPath}: disposition for ${entry.id} needs a non-empty "reason"`)
    }
  }

  return entries
}

function knownIssueIds(state) {
  const ids = new Set()
  if (!state) return ids
  if (Array.isArray(state.known_issue_ids)) for (const id of state.known_issue_ids) ids.add(id)
  for (const issue of state.open_issues || []) if (issue && issue.id) ids.add(issue.id)
  for (const issue of state.recently_resolved_issues || []) if (issue && issue.id) ids.add(issue.id)
  return ids
}

// Migration source for states written before known_issue_ids existed: the dispositions.json
// snapshot of the latest successful run proves which dispositions were already active in this
// chain, because every successful pass copies the current file into its run directory.
function latestSuccessfulRunDispositionIds(ledgerDir) {
  const runsDir = path.join(ledgerDir, 'runs')
  const ids = new Set()
  if (!fs.existsSync(runsDir)) return ids

  for (const name of fs.readdirSync(runsDir).sort().reverse()) {
    const runDir = path.join(runsDir, name)
    if (!fs.existsSync(path.join(runDir, 'state.json'))) continue
    const snapshotPath = path.join(runDir, 'dispositions.json')
    if (fs.existsSync(snapshotPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
        const entries = Array.isArray(parsed) ? parsed : parsed?.dispositions || []
        for (const entry of entries) if (entry && entry.id) ids.add(entry.id)
      } catch {
        // An unreadable snapshot proves nothing; fall through with what we have.
      }
    }
    return ids
  }
  return ids
}

// A disposition may only name a finding this chain has actually reported. Without this check a
// mistyped ID passes silently and can suppress a future, unrelated finding that happens to
// receive that ID - the exact silent-suppression failure the disposition feature must never have.
// For states predating known_issue_ids, the chain memory is reconstructed from the previous
// state's IDs plus the latest successful run's disposition snapshot - never taken on faith.
function requireDispositionsBoundToChain(dispositions, previousState, ledgerDir) {
  if (!dispositions.length) return

  const known = knownIssueIds(previousState)
  if (previousState && !Array.isArray(previousState.known_issue_ids)) {
    console.error(
      '[coding-review-local] previous state predates known_issue_ids; validating dispositions against the latest successful run snapshot.',
    )
    for (const id of latestSuccessfulRunDispositionIds(ledgerDir)) known.add(id)
  }

  const unknown = dispositions.filter((entry) => !known.has(entry.id)).map((entry) => entry.id)
  if (unknown.length) {
    fail(
      `dispositions.json references IDs unknown to this review chain: ${unknown.join(', ')}. ` +
        'A disposition must name a finding a previous pass reported (check for typos). ' +
        'Remove the unknown entries, or use --reset to deliberately start a fresh chain.',
    )
  }
}

function ownerDispositionsSection(dispositions) {
  if (!dispositions.length) return ''
  const list = JSON.stringify(dispositions, null, 2)
  return [
    '## Owner Dispositions',
    '',
    'The repository owner consciously dispositioned these findings. Each ID below names exactly',
    'that incarnation of the finding: do not re-emit it, do not count it toward the verdict, and',
    'do not keep it in `open_issues`. If materially new evidence defeats the recorded reason -',
    'changed code in the relevant area, or a concrete failure scenario the reason does not cover -',
    'report it as a NEW finding under a fresh ID and reference the dispositioned ID in its',
    'description. Never reuse a dispositioned ID. If you merely disagree, say so once under',
    'Questions instead of reporting the finding again.',
    '',
    '```json',
    list,
    '```',
    '',
  ].join('\n')
}

function reviewContractSection(opts) {
  if (!opts.goal && !opts.nonGoals && !opts.focus.length) return ''
  const lines = ['## Review Contract', '']
  if (opts.goal) lines.push(`- Goal of the change under review: ${opts.goal}`)
  if (opts.nonGoals) lines.push(`- Explicit non-goals: ${opts.nonGoals}`)
  if (opts.focus.length) lines.push(`- Focus files: ${opts.focus.join(', ')} (treat other changes in scope as context only)`)
  lines.push(
    '',
    'Judge findings against this contract. Do not propose new guarantees, persistent state,',
    'schedulers, or lifecycle mechanisms beyond the stated goal. If the change under review itself',
    'grows beyond the goal, report that scope growth as a finding instead of designing machinery',
    'to support it.',
    '',
  )
  return lines.join('\n')
}

// Continuity is the loop's brake: when earlier runs produced review output that was never
// persisted into state.json, every later pass silently degrades into a fresh full review.
// Detect that and stop instead of looping.
function requireHealthyContinuity(ledgerDir, previousState, reset) {
  if (reset || previousState) return

  const runsDir = path.join(ledgerDir, 'runs')
  if (!fs.existsSync(runsDir)) return

  const priorRuns = fs.readdirSync(runsDir).filter((name) => {
    const dir = path.join(runsDir, name)
    return fs.existsSync(path.join(dir, 'reviewer-output.json')) && !fs.existsSync(path.join(dir, 'state.json'))
  })

  // Legacy runner versions wrote the structured output straight into the ledger root and only
  // snapshotted it into the run directory on success, so a stray root-level output without
  // state.json is the same broken-continuity signal.
  if (!priorRuns.length && fs.existsSync(path.join(ledgerDir, 'reviewer-output.json'))) {
    priorRuns.push('(ledger root output without state.json)')
  }

  if (priorRuns.length) {
    fail(
      `continuity ledger is broken: ${priorRuns.length} earlier run(s) produced review output that was never persisted ` +
        `(no state.json exists), so this pass would silently restart from scratch.\n` +
        `Inspect the failed runs under ${runsDir} (mutation guard or reviewer errors), fix the cause, ` +
        'then rerun. Pass --reset only to deliberately start a fresh continuity chain.',
    )
  }
}

function computeVerdict(openIssues) {
  if (openIssues.some((issue) => issue.severity === 'P0')) return 'BLOCK'
  if (openIssues.some((issue) => issue.severity === 'P1')) return 'ATTENTION'
  return 'OK'
}

// The reviewer is instructed to keep dispositioned findings out of its verdict, but the runner
// must not depend on reviewer obedience: if the human-facing report still counts a dispositioned
// finding, the persisted review would say ATTENTION while the ledger says no open issues, and an
// autonomous loop would keep working a settled finding. Append the authoritative effective
// verdict instead of rewriting the reviewer's words.
function reconcileReviewVerdict(reviewMarkdown, openIssues, dispositions) {
  const effective = computeVerdict(openIssues)
  const verdictPattern = /Verdict:\s*(BLOCK|ATTENTION|OK)/
  const reviewerVerdict = reviewMarkdown.match(verdictPattern)?.[1]
  const reEmitted = dispositions.filter((entry) => reviewMarkdown.includes(entry.id))
  let reconciled = reviewMarkdown
  const notes = []

  if (reviewerVerdict && reviewerVerdict !== effective) {
    reconciled = reconciled.replace(verdictPattern, `Verdict: ${effective}`)
    notes.push(`corrected reviewer verdict from ${reviewerVerdict} to ${effective}`)
  } else if (!reviewerVerdict) {
    notes.push(`reviewer output had no verdict line; effective verdict is ${effective}`)
  }

  if (reEmitted.length) {
    notes.push(
      `excluded owner-dispositioned findings re-emitted by the reviewer: ${reEmitted
        .map((entry) => `${entry.id} (${entry.disposition})`)
        .join(', ')}`,
    )
  }

  if (!notes.length) return reconciled
  const label = dispositions.length
    ? `Effective verdict after owner dispositions: ${effective}.`
    : `Effective verdict: ${effective}.`
  return (
    `${reconciled}\n\n---\n\n` +
    `[coding-review-local] ${label} ${notes.join('; ')}. ` +
    'Continuity state and this effective verdict are authoritative for the review loop.'
  )
}

// Warn only when the checkout is unchanged since the previous pass: open findings without a
// disposition are then neither fixed nor rejected/deferred, so the loop is spinning without
// acting. When the scope content changed, the driver is presumably fixing findings and the
// reviewer will reconcile them, so a warning would be a chronic false positive.
function warnAboutUndispositionedFindings(previousState, dispositions, scopeUnchanged) {
  if (!scopeUnchanged) return
  const openIssues = previousState?.open_issues || []
  if (!openIssues.length) return
  const dispositioned = new Set(dispositions.map((entry) => entry.id))
  const undispositioned = openIssues.filter((issue) => issue.id && !dispositioned.has(issue.id))
  if (!undispositioned.length) return
  console.error(
    `[coding-review-local] Nothing changed since the previous pass, but ${undispositioned.length} open finding(s) ` +
      `have no recorded disposition: ${undispositioned.map((issue) => issue.id).join(', ')}. ` +
      'Fix them or record rejected/deferred entries in dispositions.json so later passes stop re-raising them.',
  )
}

function resolveLedgerDir(repoRoot, requested) {
  if (requested) return path.resolve(repoRoot, requested)
  return path.resolve(repoRoot, gitText(repoRoot, ['rev-parse', '--git-path', LEDGER_NAME]))
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalizePossiblyMissingPath(filePath) {
  const missingParts = []
  let existing = path.resolve(filePath)
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return path.resolve(filePath)
    missingParts.unshift(path.basename(existing))
    existing = parent
  }
  return path.join(fs.realpathSync(existing), ...missingParts)
}

function requireLedgerInsideGitMetadata(repoRoot, ledgerDir) {
  const gitDir = fs.realpathSync(path.resolve(gitText(repoRoot, ['rev-parse', '--absolute-git-dir'])))
  const canonicalLedgerDir = canonicalizePossiblyMissingPath(ledgerDir)
  if (!pathIsInside(gitDir, canonicalLedgerDir)) {
    fail(`ledger directory must stay inside Git metadata (${gitDir}): ${ledgerDir}`)
  }
}

function currentScope(opts, repoRoot) {
  if (opts.uncommitted) {
    return {
      kind: 'uncommitted',
      base: '',
      commit: '',
      label: 'staged, unstaged, and untracked changes',
      headSha: gitText(repoRoot, ['rev-parse', 'HEAD']),
    }
  }

  if (opts.commit) {
    if (!gitCommitExists(repoRoot, opts.commit)) fail(`commit does not resolve to a commit: ${opts.commit}`)
    const commit = gitText(repoRoot, ['rev-parse', opts.commit])
    const headSha = gitText(repoRoot, ['rev-parse', 'HEAD'])
    if (commit !== headSha) {
      fail(
        `commit reviews require the target commit to be checked out as HEAD.\n` +
          `Requested commit: ${commit}\n` +
          `Current HEAD:      ${headSha}\n\n` +
          'Check out the target commit in this repository or in a temporary git worktree, then rerun with --commit HEAD.',
      )
    }
    return {
      kind: 'commit',
      base: '',
      commit,
      label: `commit ${opts.commit}`,
      headSha,
    }
  }

  const base = opts.base || detectBase(repoRoot)
  if (!gitCommitExists(repoRoot, base)) fail(`base ref does not resolve to a commit: ${base}`)
  return {
    kind: 'base',
    base,
    commit: '',
    label: `current branch against ${base}`,
    headSha: gitText(repoRoot, ['rev-parse', 'HEAD']),
  }
}

function requireCleanWorktreeForCommittedScope(repoRoot, scopeKind) {
  const rawStatus = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']).stdout
  if (!rawStatus.trim()) return
  const status = rawStatus.trimEnd()

  fail(
    `${scopeKind} reviews require a clean worktree so the reviewer reads exactly the committed scope under review.\n` +
      'Use --uncommitted when local staged, unstaged, or untracked changes are part of the review.\n\n' +
      `Current git status:\n${status}`,
  )
}

function scopeKey(repoRoot, scope) {
  if (scope.kind === 'uncommitted') {
    return sha256(
      JSON.stringify({
        kind: scope.kind,
        headSha: scope.headSha,
        worktree: worktreeMutationFingerprint(repoRoot),
      }),
    )
  }

  if (scope.kind === 'commit') {
    return sha256(
      JSON.stringify({
        kind: scope.kind,
        commit: scope.commit,
        headSha: scope.headSha,
      }),
    )
  }

  return sha256(
    JSON.stringify({
      kind: scope.kind,
      baseSha: gitText(repoRoot, ['rev-parse', scope.base]),
      mergeBaseSha: gitText(repoRoot, ['merge-base', scope.base, 'HEAD']),
      headSha: scope.headSha,
    }),
  )
}

function writeScopeArtifacts(repoRoot, scope, runDir) {
  const scopePath = path.join(runDir, 'scope.patch')
  const changedFilesPath = path.join(runDir, 'changed-files.txt')
  const scopeSummaryPath = path.join(runDir, 'scope-summary.txt')
  let patch = ''
  let changedFiles = []
  let summary = ''

  if (scope.kind === 'uncommitted') {
    const staged = gitRaw(repoRoot, ['diff', '--cached', '--find-renames', '--unified=80'])
    const unstaged = gitRaw(repoRoot, ['diff', '--find-renames', '--unified=80'])
    const untracked = gitNullList(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    changedFiles = [
      ...gitNullList(repoRoot, ['diff', '--cached', '--name-only', '-z']),
      ...gitNullList(repoRoot, ['diff', '--name-only', '-z']),
      ...untracked,
    ]
    summary = [
      'Scope: staged, unstaged, and untracked changes',
      '',
      gitRaw(repoRoot, ['status', '--short', '--untracked-files=all']),
      untracked.length ? `Untracked files (read these from the checkout):\n${untracked.join('\n')}` : 'Untracked files: none',
    ].join('\n')
    patch = ['### Staged diff', staged || '(none)', '', '### Unstaged diff', unstaged || '(none)', ''].join('\n')
  } else if (scope.kind === 'commit') {
    summary = gitRaw(repoRoot, ['show', '--stat', '--oneline', '--decorate', '--no-renames', scope.commit])
    patch = gitRaw(repoRoot, ['show', '--format=fuller', '--find-renames', '--unified=80', scope.commit])
    changedFiles = gitRaw(repoRoot, ['show', '--format=', '--name-only', '-z', scope.commit])
      .split('\0')
      .filter(Boolean)
      .sort()
  } else {
    const range = `${scope.base}...HEAD`
    summary = [
      `Scope: current branch against ${scope.base}`,
      '',
      gitRaw(repoRoot, ['log', '--oneline', `${scope.base}..HEAD`]),
      gitRaw(repoRoot, ['diff', '--stat', range]),
    ].join('\n')
    patch = gitRaw(repoRoot, ['diff', '--find-renames', '--unified=80', range])
    changedFiles = gitRaw(repoRoot, ['diff', '--name-only', '-z', range])
      .split('\0')
      .filter(Boolean)
      .sort()
  }

  fs.mkdirSync(runDir, { recursive: true })
  writeFile(scopePath, patch || '(empty diff)\n')
  writeFile(changedFilesPath, `${[...new Set(changedFiles)].sort().join('\n')}\n`)
  writeFile(scopeSummaryPath, summary || '(no scope summary)\n')
  return { scopePath, changedFilesPath, scopeSummaryPath }
}

function scopeArtifactSignature(artifacts) {
  const signature = {}
  for (const filePath of Object.values(artifacts)) {
    signature[filePath] = fs.existsSync(filePath) ? sha256File(filePath) : '(missing)'
  }
  return signature
}

function codexScopeInstructions(scope) {
  if (scope.kind === 'uncommitted') {
    return [
      'Review staged, unstaged, and untracked changes in the current working tree.',
      'Start with:',
      '- `git status --short`',
      '- `git diff --cached --stat` and `git diff --cached` for staged changes',
      '- `git diff --stat` and `git diff` for unstaged changes',
      '- `git ls-files --others --exclude-standard` for untracked files, then read each relevant file',
    ].join('\n')
  }

  if (scope.kind === 'commit') {
    return [
      `Review the changes introduced by commit ${scope.commit}.`,
      'Start with:',
      `- \`git show --stat --oneline --decorate --no-renames ${scope.commit}\``,
      `- \`git show --find-renames --unified=80 ${scope.commit}\``,
      '- Read touched source files and their callers/siblings as needed.',
    ].join('\n')
  }

  return [
    `Review the current branch against base ref ${scope.base}.`,
    'Start with:',
    `- \`git log --oneline ${scope.base}..HEAD\``,
    `- \`git diff --stat ${scope.base}...HEAD\``,
    `- \`git diff --find-renames --unified=80 ${scope.base}...HEAD\``,
    '- Read touched source files and their callers/siblings as needed.',
  ].join('\n')
}

function scopeInstructions(scope, artifacts, provider) {
  if (provider === 'codex') return codexScopeInstructions(scope)
  return [
    `Review ${scope.label}.`,
    'The runner collected the exact Git scope before starting the reviewer. Read these artifacts first:',
    `- Scope summary: ${artifacts.scopeSummaryPath}`,
    `- Diff: ${artifacts.scopePath}`,
    `- Changed files: ${artifacts.changedFilesPath}`,
    scope.kind === 'uncommitted'
      ? '- The diff artifact excludes untracked file contents. Read every relevant untracked file named in the summary from the checkout.'
      : '- Read touched source files and their callers or siblings from the checkout as needed.',
    '- Use only read-only inspection. If the provider exposes file access through a shell tool, run read-only commands only. Do not modify files.',
  ].join('\n')
}

function normalizeState(outputState, previousState, headSha, reviewNumber, currentScopeKey, dispositions = [], contextKey = '') {
  const state = outputState && typeof outputState === 'object' ? outputState : {}
  state.schema_version = 1
  state.last_reviewed_head_sha = headSha
  state.scope_key = currentScopeKey
  state.review_context_key = contextKey
  state.review_count = reviewNumber
  state.updated_at = new Date().toISOString()
  if (!Array.isArray(state.open_issues)) state.open_issues = []
  if (!Array.isArray(state.recently_resolved_issues)) state.recently_resolved_issues = []

  // The chain's cumulative ID memory: every ID any pass has reported, including ones later
  // filtered by dispositions. Validated disposition IDs are added explicitly because an obedient
  // reviewer stops emitting them - without this they would fall out of the chain's memory and
  // their own dispositions would be rejected as unknown on later passes.
  const known = knownIssueIds(previousState)
  for (const issue of state.open_issues) if (issue && issue.id) known.add(issue.id)
  for (const issue of state.recently_resolved_issues) if (issue && issue.id) known.add(issue.id)
  for (const entry of dispositions) known.add(entry.id)
  state.known_issue_ids = [...known].sort()

  // Owner-dispositioned findings are conscious decisions, not open work: keep them out of
  // open_issues so they stop driving verdicts, and out of resolved so they do not read as fixed.
  const dispositionedIds = new Set(dispositions.map((entry) => entry.id))
  state.open_issues = state.open_issues.filter((issue) => !dispositionedIds.has(issue.id))
  state.recently_resolved_issues = state.recently_resolved_issues.filter((issue) => !dispositionedIds.has(issue?.id))

  for (const issue of state.open_issues) {
    if (!issue.first_seen_head_sha) issue.first_seen_head_sha = headSha
    issue.last_seen_head_sha = headSha
    issue.status = 'open'
  }

  const previousOpenIds = new Set((previousState?.open_issues || []).map((issue) => issue.id).filter(Boolean))
  state.recently_resolved_issues = state.recently_resolved_issues.filter((issue) => {
    return issue && issue.id && previousOpenIds.has(issue.id)
  })

  return state
}

function reviewerLabel(provider) {
  if (provider === 'claude') return 'Claude'
  if (provider === 'copilot') return 'GitHub Copilot'
  return 'Codex'
}

function outputContract(schemaPath) {
  const schema = fs.readFileSync(schemaPath, 'utf8').trim()
  return [
    '',
    '## Machine Output Contract',
    '',
    'Your final response must be exactly one JSON object that validates against the schema below.',
    'Do not wrap it in Markdown fences and do not add prose before or after it.',
    '',
    '```json',
    schema,
    '```',
    '',
  ].join('\n')
}

function reviewerCommand(opts, prompt, schemaPath, outputRunPath, runDir, repoRoot) {
  if (opts.provider === 'claude') {
    return {
      command: 'claude',
      args: [
        '-p',
        '--safe-mode',
        '--model',
        opts.model,
        '--effort',
        opts.reasoning,
        '--permission-mode',
        'dontAsk',
        '--tools',
        'Read,Grep,Glob',
        '--allowedTools',
        'Read,Grep,Glob',
        '--add-dir',
        repoRoot,
        '--add-dir',
        runDir,
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--no-session-persistence',
        '--no-chrome',
        '--output-format',
        'json',
        '--json-schema',
        fs.readFileSync(schemaPath, 'utf8'),
      ],
      input: prompt,
    }
  }

  if (opts.provider === 'copilot') {
    return {
      command: 'copilot',
      args: [
        '--prompt',
        `Read the complete review instructions from ${path.join(runDir, 'prompt.md')} and follow them. ` +
          'Use the read-only tools to inspect that file before reviewing the repository.',
        '--model',
        opts.model,
        '--effort',
        opts.reasoning,
        '--silent',
        '--stream',
        'off',
        '--output-format',
        'json',
        '--no-auto-update',
        '--no-remote',
        '--no-remote-export',
        '--no-custom-instructions',
        '--disable-builtin-mcps',
        '--no-ask-user',
        '--available-tools=view,glob,grep',
        '--allow-tool=read',
        '--add-dir',
        runDir,
      ],
      input: undefined,
    }
  }

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--model',
    opts.model,
    '--sandbox',
    opts.sandbox,
    '-c',
    'allow_login_shell=false',
    '-c',
    `web_search="${opts.webSearch}"`,
    '-c',
    `model_reasoning_effort="${opts.reasoning}"`,
    '-c',
    'sandbox_workspace_write.network_access=false',
    '--output-schema',
    schemaPath,
    '-o',
    outputRunPath,
    '-',
  ]
  return { command: 'codex', args, input: prompt }
}

function parseJsonText(raw) {
  const trimmed = raw.trim().replace(/^\uFEFF/, '')
  if (!trimmed) throw new Error('reviewer stdout was empty')
  try {
    return JSON.parse(trimmed)
  } catch (firstError) {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    if (fenced) return JSON.parse(fenced[1])
    throw firstError
  }
}

function findClaudeStructuredOutput(value) {
  if (!value || typeof value !== 'object') return null
  if (value.structured_output && typeof value.structured_output === 'object') {
    return value.structured_output
  }
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const found = findClaudeStructuredOutput(value[i])
      if (found) return found
    }
  }
  if (value.type === 'result' && typeof value.result === 'string') {
    try {
      const parsed = JSON.parse(value.result)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // The structured_output field is authoritative when the result string is not JSON.
    }
  }
  return null
}

function parseCopilotOutput(raw) {
  try {
    const direct = parseJsonText(raw)
    if (direct && typeof direct === 'object' && typeof direct.review_markdown === 'string') return direct
  } catch {
    // Current Copilot CLI emits JSONL events when --output-format json is selected.
  }

  const candidates = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'assistant.message' && typeof event?.data?.content === 'string') {
      candidates.push(event.data.content)
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = parseJsonText(candidates[i])
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Earlier assistant messages may be progress notes rather than the final JSON response.
    }
  }
  throw new Error('Copilot output did not include a JSON assistant message matching the review schema')
}

function parseReviewerOutput(provider, stdoutPath, outputRunPath) {
  let output
  if (provider === 'codex') {
    if (!fs.existsSync(outputRunPath) || fs.statSync(outputRunPath).size === 0) {
      throw new Error('Codex produced no structured review output')
    }
    output = JSON.parse(fs.readFileSync(outputRunPath, 'utf8'))
  } else {
    const raw = readFileIfExists(stdoutPath)
    if (provider === 'claude') {
      output = findClaudeStructuredOutput(parseJsonText(raw))
      if (!output) throw new Error('Claude output did not include structured_output')
    } else {
      output = parseCopilotOutput(raw)
    }
    writeFile(outputRunPath, `${JSON.stringify(output, null, 2)}\n`)
  }
  return output
}

function requireExactObjectKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`${label} is missing required field: ${field}`)
    }
  }
  const allowed = new Set(fields)
  const extra = Object.keys(value).filter((field) => !allowed.has(field))
  if (extra.length) throw new Error(`${label} has unsupported field(s): ${extra.join(', ')}`)
}

function requireStringFields(value, fields, label) {
  for (const field of fields) {
    if (typeof value[field] !== 'string') throw new Error(`${label} is missing string field: ${field}`)
  }
}

function validateIssueCollections(state) {
  const issueFields = [
    'id',
    'severity',
    'category',
    'title',
    'file',
    'line_range',
    'failure_scenario',
    'suggested_fix',
    'status',
    'first_seen_head_sha',
    'last_seen_head_sha',
  ]
  const openIds = new Set()
  for (const issue of state.open_issues) {
    requireExactObjectKeys(issue, issueFields, 'open issue')
    requireStringFields(issue, issueFields, 'open issue')
    if (!issue.id.trim()) throw new Error('finding ID must be non-empty')
    if (openIds.has(issue.id)) throw new Error(`duplicate finding ID: ${issue.id}`)
    openIds.add(issue.id)
    if (!['P0', 'P1', 'P2'].includes(issue.severity)) throw new Error(`invalid issue severity: ${issue.severity}`)
    if (issue.status !== 'open') throw new Error(`invalid issue status for ${issue.id}`)
  }

  const resolvedFields = ['id', 'resolved_in_head_sha', 'resolution']
  const resolvedIds = new Set()
  for (const issue of state.recently_resolved_issues) {
    requireExactObjectKeys(issue, resolvedFields, 'resolved issue')
    requireStringFields(issue, resolvedFields, 'resolved issue')
    if (!issue.id.trim()) throw new Error('finding ID must be non-empty')
    if (openIds.has(issue.id)) throw new Error(`finding ID appears as both open and resolved: ${issue.id}`)
    if (resolvedIds.has(issue.id)) throw new Error(`duplicate finding ID: ${issue.id}`)
    resolvedIds.add(issue.id)
  }
}

function validateReviewerOutput(output) {
  requireExactObjectKeys(output, ['review_markdown', 'state'], 'structured output')
  if (typeof output.review_markdown !== 'string' || !output.review_markdown.trim()) {
    throw new Error('structured output did not include a non-empty review_markdown')
  }

  const stateFields = [
    'schema_version',
    'last_reviewed_head_sha',
    'scope_key',
    'review_count',
    'updated_at',
    'open_issues',
    'recently_resolved_issues',
  ]
  requireExactObjectKeys(output.state, stateFields, 'structured state')
  if (!Number.isInteger(output.state.schema_version)) throw new Error('structured state schema_version must be an integer')
  if (!Number.isInteger(output.state.review_count)) throw new Error('structured state review_count must be an integer')
  requireStringFields(output.state, ['last_reviewed_head_sha', 'scope_key', 'updated_at'], 'structured state')
  if (!Array.isArray(output.state.open_issues) || !Array.isArray(output.state.recently_resolved_issues)) {
    throw new Error('structured state must include open_issues and recently_resolved_issues arrays')
  }

  validateIssueCollections(output.state)
}

function requirePriorIssuesAccountedFor(outputState, previousState, dispositions) {
  if (!previousState) return
  const openIds = new Set(outputState.open_issues.map((issue) => issue.id))
  const resolvedIds = new Set(outputState.recently_resolved_issues.map((issue) => issue.id))
  const dispositionedIds = new Set(dispositions.map((entry) => entry.id))
  const missing = (previousState.open_issues || [])
    .map((issue) => issue.id)
    .filter((id) => id && !openIds.has(id) && !resolvedIds.has(id) && !dispositionedIds.has(id))

  if (missing.length) {
    throw new Error(
      `previously open finding disappeared without resolution or disposition: ${missing.join(', ')}`,
    )
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const repoRoot = resolveRepoRoot(opts.repoDir)
  const scope = currentScope(opts, repoRoot)
  if (scope.kind !== 'uncommitted') requireCleanWorktreeForCommittedScope(repoRoot, scope.kind)
  const currentScopeKey = scopeKey(repoRoot, scope)
  const ledgerDir = resolveLedgerDir(repoRoot, opts.ledgerDir)
  requireLedgerInsideGitMetadata(repoRoot, ledgerDir)
  const statePath = path.join(ledgerDir, 'state.json')
  const reviewPath = path.join(ledgerDir, 'review.md')
  const outputPath = path.join(ledgerDir, 'reviewer-output.json')
  const promptPath = path.join(ledgerDir, 'prompt.md')
  const schemaPath = path.join(ledgerDir, 'local-output-schema.json')
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = path.join(ledgerDir, 'runs', runId)
  const outputRunPath = path.join(runDir, 'reviewer-output.json')
  const stdoutPath = path.join(runDir, 'reviewer.stdout.log')
  const stderrPath = path.join(runDir, 'reviewer.stderr.log')
  const displayLogs = [stdoutPath, stderrPath].map((file) => path.relative(repoRoot, file) || file).join(', ')

  const previousState = opts.reset ? null : loadJsonIfExists(statePath)
  requireValidCanonicalState(previousState, statePath)
  const previousReview = opts.reset ? '' : readFileIfExists(reviewPath)
  requireHealthyContinuity(ledgerDir, previousState, opts.reset)
  const previousCanonicalArtifacts = [statePath, reviewPath, outputPath].map((artifactPath) => ({
    artifactPath,
    content: fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath) : null,
  }))
  // A reset pass previews the new chain (no old dispositions in prompt or filtering), but the
  // file itself is rotated only after the pass succeeds.
  const dispositions = opts.reset ? [] : loadDispositions(ledgerDir)
  requireDispositionsBoundToChain(dispositions, previousState, ledgerDir)
  warnAboutUndispositionedFindings(
    previousState,
    dispositions,
    !opts.reset && previousState?.scope_key === currentScopeKey,
  )
  const reviewNumber = Number(previousState?.review_count || 0) + 1
  // The skip identity keeps the old semantic inputs and adds reviewer settings. Switching providers,
  // models, or effort re-runs the same scope while preserving continuity from the prior pass.
  const currentContextKey = sha256(
    JSON.stringify({
      goal: opts.goal,
      nonGoals: opts.nonGoals,
      focus: opts.focus,
      dispositions,
      provider: opts.provider,
      model: opts.model,
      reasoning: opts.reasoning,
      sandbox: opts.provider === 'codex' ? opts.sandbox : '',
      webSearch: opts.provider === 'codex' ? opts.webSearch : '',
    }),
  )
  const alreadyReviewed =
    !opts.reset &&
    !opts.force &&
    previousState?.last_reviewed_head_sha &&
    previousState.last_reviewed_head_sha === scope.headSha &&
    previousState.scope_key === currentScopeKey &&
    previousState.review_context_key === currentContextKey

  if (alreadyReviewed) {
    console.log(
      `[coding-review-local] No new scope to review. Last reviewed head: ${scope.headSha.slice(0, 8)}. Use --force to re-review.`,
    )
    process.exit(0)
  }

  const prBody = opts.prBodyFile
    ? fs.readFileSync(resolveInputFile(repoRoot, opts.prBodyFile), 'utf8')
    : '(local review; no PR description supplied)'
  fs.mkdirSync(runDir, { recursive: true })
  const artifacts = writeScopeArtifacts(repoRoot, scope, runDir)
  fs.mkdirSync(ledgerDir, { recursive: true })
  fs.copyFileSync(OUTPUT_SCHEMA, schemaPath)

  const title =
    opts.title ||
    (scope.kind === 'commit'
      ? gitText(repoRoot, ['show', '-s', '--format=%s', scope.commit])
      : gitText(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true }) || 'local review')
  const continuityReason = opts.reset
    ? 'reset_requested'
    : previousState
      ? previousState.scope_key === currentScopeKey
        ? 'previous_state_loaded'
        : 'previous_state_loaded_for_different_scope'
      : 'no_previous_review'
  const prompt = buildPrompt({
    REVIEWER_NAME: reviewerLabel(opts.provider),
    REVIEW_TITLE: title,
    REVIEW_SCOPE: `${scope.label}\n\nExtra context:\n${prBody}`,
    BASE_REF: scope.base || '(not used)',
    COMMIT_REF: scope.commit || '(not used)',
    HEAD_SHA: scope.headSha,
    SCOPE_KEY: currentScopeKey,
    REVIEW_NUMBER: reviewNumber,
    CONTINUITY_REASON: continuityReason,
    SCOPE_INSTRUCTIONS: scopeInstructions(scope, artifacts, opts.provider),
    REVIEW_CONTRACT_SECTION: reviewContractSection(opts),
    OWNER_DISPOSITIONS_SECTION: ownerDispositionsSection(dispositions),
    PREVIOUS_STATE_JSON: previousState ? JSON.stringify(previousState, null, 2) : '{}',
    PREVIOUS_REVIEW_MARKDOWN: previousReview || '(none)',
    GUIDELINES_SECTION: loadGuidelines(repoRoot),
  })

  const reviewerPrompt = opts.provider === 'copilot' ? `${prompt}${outputContract(schemaPath)}` : prompt
  const runPromptPath = path.join(runDir, 'prompt.md')
  writeFile(promptPath, reviewerPrompt)
  writeFile(runPromptPath, reviewerPrompt)
  artifacts.promptPath = runPromptPath
  artifacts.schemaPath = schemaPath

  console.error(`[coding-review-local] Scope: ${scope.label}`)
  console.error(`[coding-review-local] Reviewer: ${reviewerLabel(opts.provider)} (${opts.model}, effort ${opts.reasoning})`)
  console.error(`[coding-review-local] Ledger: ${path.relative(repoRoot, ledgerDir) || ledgerDir}`)

  if (opts.noReviewer) {
    console.log(`[coding-review-local] Prompt built: ${promptPath}`)
    process.exit(0)
  }

  const invocation = reviewerCommand(opts, reviewerPrompt, schemaPath, outputRunPath, runDir, repoRoot)
  const beforeSignature = worktreeMutationSignatureObject(repoRoot)
  const beforeArtifactSignature = scopeArtifactSignature(artifacts)
  const started = Date.now()
  console.error('[coding-review-local] Review in progress - do not modify the repository until this process exits')
  console.error(`[coding-review-local] Reviewer logs: ${displayLogs}`)
  const reviewerResult = run(invocation.command, invocation.args, {
    cwd: repoRoot,
    input: invocation.input,
    stdoutFile: stdoutPath,
    stderrFile: stderrPath,
    allowFailure: true,
    timeoutMs: opts.timeoutMin > 0 ? opts.timeoutMin * 60 * 1000 : undefined,
  })
  const durationSeconds = Math.round((Date.now() - started) / 1000)
  const afterSignature = worktreeMutationSignatureObject(repoRoot)
  const afterArtifactSignature = scopeArtifactSignature(artifacts)

  const failures = []
  if (JSON.stringify(afterSignature) !== JSON.stringify(beforeSignature)) {
    const changes = describeMutation(beforeSignature, afterSignature)
    failures.push(
      'The worktree changed during the review, so the reviewed scope is no longer trustworthy.\n' +
        `Changed:\n${changes.map((line) => `  - ${line}`).join('\n')}\n` +
        'Stop concurrent processes writing into the repo (dev servers, builds, editors) or review a separate git worktree.',
    )
  }
  if (JSON.stringify(afterArtifactSignature) !== JSON.stringify(beforeArtifactSignature)) {
    failures.push('The reviewer changed or deleted the private scope artifacts. The run is not trustworthy.')
  }
  if (reviewerResult.error && reviewerResult.error.code === 'ETIMEDOUT') {
    failures.push(
      `${reviewerLabel(opts.provider)} exceeded the ${opts.timeoutMin} minute timeout and was killed. ` +
        'Healthy passes finish well under this limit, so this is almost certainly a hang, not deep thinking. ' +
        'Rerun the review; raise --timeout-min only if the reviewed scope is genuinely huge.',
    )
  } else if (reviewerResult.error) {
    failures.push(`${invocation.command} failed to start: ${reviewerResult.error.message}`)
  } else if (reviewerResult.status !== 0) {
    failures.push(`${invocation.command} failed with exit ${reviewerResult.status}.`)
  }

  if (failures.length) {
    const rejectedPath = quarantineFailedRunOutput(runDir, outputRunPath)
    const quarantineNote = rejectedPath
      ? `\nThe run produced structured output, but the run failed: it was quarantined as ${rejectedPath}. Do not use its findings.`
      : ''
    fail(`${failures.join('\n')}${quarantineNote}\nReviewer logs: ${displayLogs}`)
  }

  let output
  try {
    output = parseReviewerOutput(opts.provider, stdoutPath, outputRunPath)
    validateReviewerOutput(output)
    requirePriorIssuesAccountedFor(output.state, previousState, dispositions)
  } catch (error) {
    const rejectedPath = quarantineFailedRunOutput(runDir, outputRunPath)
    const quarantineNote = rejectedPath ? ` Quarantined as ${rejectedPath}.` : ''
    fail(`could not use structured review output: ${error.message}.${quarantineNote} Do not use its findings. Reviewer logs: ${displayLogs}`)
  }

  const reviewMarkdown = output.review_markdown.trim()
  const state = normalizeState(
    output.state,
    previousState,
    scope.headSha,
    reviewNumber,
    currentScopeKey,
    dispositions,
    currentContextKey,
  )
  const finalReviewMarkdown = reconcileReviewVerdict(reviewMarkdown, state.open_issues, dispositions)
  const stateText = `${JSON.stringify(state, null, 2)}\n`
  let rotation = null
  try {
    // Prepare the successful-run snapshot before changing canonical artifacts.
    writeFile(path.join(runDir, 'state.json'), stateText)
    writeFile(path.join(runDir, 'review.md'), `${finalReviewMarkdown}\n`)
    if (!opts.reset && fs.existsSync(path.join(ledgerDir, 'dispositions.json'))) {
      fs.copyFileSync(path.join(ledgerDir, 'dispositions.json'), path.join(runDir, 'dispositions.json'))
    }

    writeFile(reviewPath, `${finalReviewMarkdown}\n`)
    fs.copyFileSync(outputRunPath, outputPath)
    if (opts.reset) rotation = rotateDispositionsForNewChain(ledgerDir, runId)
    // Canonical state is the final success marker. No later file operation may fail the run.
    writeFile(statePath, stateText)
  } catch (error) {
    if (rotation && fs.existsSync(rotation.rotatedPath) && !fs.existsSync(rotation.dispositionsPath)) {
      try { fs.renameSync(rotation.rotatedPath, rotation.dispositionsPath) } catch {}
    }
    for (const previous of previousCanonicalArtifacts) {
      try {
        fs.rmSync(previous.artifactPath, { recursive: true, force: true })
        if (previous.content !== null) writeFile(previous.artifactPath, previous.content)
      } catch {}
    }
    for (const snapshotPath of [path.join(runDir, 'state.json'), path.join(runDir, 'review.md')]) {
      try { fs.rmSync(snapshotPath, { force: true }) } catch {}
    }
    const rejectedPath = quarantineFailedRunOutput(runDir, outputRunPath)
    const quarantineNote = rejectedPath ? ` Quarantined as ${rejectedPath}.` : ''
    fail(`could not promote successful review artifacts: ${error.message}.${quarantineNote} Do not use this run.`)
  }
  if (rotation) {
    console.error(
      `[coding-review-local] --reset rotated recorded dispositions to ${path.basename(rotation.rotatedPath)}; ` +
        'the new review chain starts without them.',
    )
  }

  console.error(`[coding-review-local] Review completed in ${durationSeconds}s`)
  console.error(`[coding-review-local] Review: ${reviewPath}`)
  console.log(finalReviewMarkdown)
}

main()
