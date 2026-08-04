'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUNNER = path.join(
  REPO_ROOT,
  'skills',
  'coding-review-local',
  'scripts',
  'run-local-review.cjs',
)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
  )
  return result.stdout.trim()
}

function fakeReviewerScript(provider) {
  return `#!/usr/bin/env node
'use strict'

const fs = require('node:fs')

if (process.env.FAKE_REVIEWER_ARGS) {
  fs.writeFileSync(process.env.FAKE_REVIEWER_ARGS, JSON.stringify(process.argv.slice(2)))
}

if (process.env.FAKE_REVIEWER_FAIL === '1') process.exit(7)
if (process.env.FAKE_REVIEWER_MUTATE === '1') fs.appendFileSync('README.md', 'mutated\\n')
if (process.env.FAKE_REVIEWER_MUTATE_ARTIFACT === '1') {
  const addDirIndexes = process.argv.map((arg, index) => arg === '--add-dir' ? index : -1).filter((index) => index >= 0)
  const runDir = process.argv[addDirIndexes.at(-1) + 1]
  fs.appendFileSync(require('node:path').join(runDir, 'scope.patch'), 'mutated\\n')
}

if (process.env.FAKE_REVIEWER_MALFORMED === '1') {
  process.stdout.write('not-json')
  process.exit(0)
}

const findingIds = (process.env.FAKE_REVIEWER_FINDING_IDS || '').split(',').filter(Boolean)
const resolvedIds = (process.env.FAKE_REVIEWER_RESOLVED_IDS || '').split(',').filter(Boolean)
if (process.env.FAKE_EMPTY_FINDING_ID === '1') findingIds.push('   ')
const openIssues = findingIds.map((id) => ({
  id,
  severity: 'P1',
  category: 'correctness',
  title: 'Fixture finding ' + id,
  file: 'README.md',
  line_range: '1-1',
  failure_scenario: 'Fixture failure scenario for ' + id + '.',
  suggested_fix: 'Fix ' + id + '.',
  status: 'open',
  first_seen_head_sha: '',
  last_seen_head_sha: ''
}))
const verdict = process.env.FAKE_REVIEWER_VERDICT || (openIssues.length ? 'ATTENTION' : 'OK')
const output = {
  review_markdown: '## ${provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'GitHub Copilot'} Review Pass 1 - Verdict: ' + verdict + '\\n\\nFixture review.',
  state: {
    schema_version: 1,
    last_reviewed_head_sha: '',
    scope_key: '',
    review_count: 1,
    updated_at: '',
    open_issues: openIssues,
    recently_resolved_issues: resolvedIds.map((id) => ({
      id,
      resolved_in_head_sha: '',
      resolution: 'Resolved fixture finding ' + id + '.'
    }))
  }
}

if (process.env.FAKE_OMIT_STATE_METADATA === '1') {
  delete output.state.schema_version
  delete output.state.last_reviewed_head_sha
  delete output.state.scope_key
  delete output.state.review_count
  delete output.state.updated_at
}

if ('${provider}' === 'codex') {
  const outputIndex = process.argv.indexOf('-o')
  const outputPath = process.argv[outputIndex + 1]
  fs.writeFileSync(outputPath, JSON.stringify(output))
  process.stdout.write('verbose codex output\\n')
} else if ('${provider}' === 'claude') {
  process.stdout.write(JSON.stringify([{ type: 'result', structured_output: output }]))
} else if (process.env.FAKE_COPILOT_JSONL === '1') {
  process.stdout.write(JSON.stringify({ type: 'assistant.message', data: { content: 'Inspecting scope.' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(output) } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'result', exitCode: 0 }) + '\\n')
} else {
  process.stdout.write(JSON.stringify(output))
}
process.stderr.write('verbose ${provider} diagnostics\\n')
`
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-review-local-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const repoDir = path.join(root, 'repo')
  const binDir = path.join(root, 'bin')
  const argsPath = path.join(root, 'reviewer-args.json')
  fs.mkdirSync(repoDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  run('git', ['init', '--quiet'], { cwd: repoDir })
  run('git', ['config', 'user.email', 'review-test@example.com'], { cwd: repoDir })
  run('git', ['config', 'user.name', 'Review Test'], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n')
  run('git', ['add', 'README.md'], { cwd: repoDir })
  run('git', ['commit', '--quiet', '-m', 'Initial fixture'], { cwd: repoDir })

  for (const provider of ['codex', 'claude', 'copilot']) {
    const executable = path.join(binDir, provider)
    fs.writeFileSync(executable, fakeReviewerScript(provider))
    fs.chmodSync(executable, 0o755)
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_REVIEWER_ARGS: argsPath,
  }
  return { argsPath, env, repoDir, root }
}

function runReview(fixture, extraArgs = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--repo-dir', fixture.repoDir, '--commit', 'HEAD', '--title', 'Provider test', ...extraArgs],
    {
      cwd: REPO_ROOT,
      env: { ...fixture.env, ...extraEnv },
      encoding: 'utf8',
    },
  )
}

function ledgerDir(repoDir) {
  const ledgerPath = run('git', ['rev-parse', '--git-path', 'coding-review-local'], { cwd: repoDir })
  return path.resolve(repoDir, ledgerPath)
}

function reviewerArgs(fixture) {
  return JSON.parse(fs.readFileSync(fixture.argsPath, 'utf8'))
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1, `missing flag ${flag}`)
  return args[index + 1]
}

test('Codex remains the default provider with the existing production defaults', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Codex Review Pass 1 - Verdict: OK/)
  assert.doesNotMatch(result.stdout, /verbose codex output/)
  assert.match(result.stderr, /Reviewer: Codex \(gpt-5\.6-sol, effort high\)/)

  const args = reviewerArgs(fixture)
  assert.equal(args[0], 'exec')
  assert.equal(valueAfter(args, '--model'), 'gpt-5.6-sol')
  assert.equal(valueAfter(args, '--sandbox'), 'workspace-write')
  assert.ok(args.includes('model_reasoning_effort="high"'))
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'))
  assert.ok(!args.includes('--ignore-user-config'))
  assert.ok(!args.includes('--ignore-rules'))

  const prompt = fs.readFileSync(path.join(ledgerDir(fixture.repoDir), 'prompt.md'), 'utf8')
  assert.match(prompt, /git show --find-renames --unified=80/)
})

test('Claude uses fable/high, native schema output, and read-only tools', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'claude'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Claude Review Pass 1 - Verdict: OK/)
  assert.match(result.stderr, /Reviewer: Claude \(fable, effort high\)/)

  const args = reviewerArgs(fixture)
  assert.equal(valueAfter(args, '--model'), 'fable')
  assert.equal(valueAfter(args, '--effort'), 'high')
  assert.equal(valueAfter(args, '--tools'), 'Read,Grep,Glob')
  assert.equal(valueAfter(args, '--allowedTools'), 'Read,Grep,Glob')
  assert.ok(args.includes('--safe-mode'))
  assert.ok(args.includes('--no-session-persistence'))
  assert.ok(args.includes('--json-schema'))
  assert.ok(!args.join(' ').includes('Bash'))
})

test('GitHub Copilot uses gpt-5.6-sol/high with only read, glob, and grep tools', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'copilot'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /copilot Review Pass 1 - Verdict: OK/i)
  assert.match(result.stderr, /Reviewer: GitHub Copilot \(gpt-5\.6-sol, effort high\)/)

  const args = reviewerArgs(fixture)
  assert.equal(valueAfter(args, '--model'), 'gpt-5.6-sol')
  assert.equal(valueAfter(args, '--effort'), 'high')
  assert.ok(args.includes('--available-tools=view,glob,grep'))
  assert.ok(args.includes('--allow-tool=read'))
  assert.equal(valueAfter(args, '--output-format'), 'json')
  assert.ok(args.includes('--no-custom-instructions'))
  assert.ok(args.includes('--disable-builtin-mcps'))
  assert.ok(args.includes('--no-remote-export'))
  assert.ok(!args.some((arg) => arg.includes('allow-all')))
  assert.match(valueAfter(args, '--prompt'), /prompt\.md/)
  assert.doesNotMatch(valueAfter(args, '--prompt'), /Machine Output Contract/)

  const prompt = fs.readFileSync(path.join(ledgerDir(fixture.repoDir), 'prompt.md'), 'utf8')
  assert.match(prompt, /## Machine Output Contract/)
})

test('parses Copilot JSONL and takes the final structured assistant message', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'copilot'], { FAKE_COPILOT_JSONL: '1' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /GitHub Copilot Review Pass 1 - Verdict: OK/)
})

test('switching providers reruns the same scope and preserves continuity', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture)
  assert.equal(first.status, 0, first.stderr)

  const second = runReview(fixture, ['--provider', 'claude'])
  assert.equal(second.status, 0, second.stderr)
  const state = JSON.parse(fs.readFileSync(path.join(ledgerDir(fixture.repoDir), 'state.json'), 'utf8'))
  assert.equal(state.review_count, 2)

  const third = runReview(fixture, ['--provider', 'claude'])
  assert.equal(third.status, 0, third.stderr)
  assert.match(third.stdout, /No new scope to review/)
})

test('provider switching fails closed when a prior open issue disappears', (t) => {
  const fixture = createFixture(t)
  const first = runReview(fixture, [], { FAKE_REVIEWER_FINDING_IDS: 'RR-CONT-001' })
  assert.equal(first.status, 0, first.stderr)

  const second = runReview(fixture, ['--provider', 'claude'])
  assert.equal(second.status, 1)
  assert.match(second.stderr, /previously open finding disappeared without resolution or disposition/)
  assert.match(second.stderr, /RR-CONT-001/)

  const state = JSON.parse(fs.readFileSync(path.join(ledgerDir(fixture.repoDir), 'state.json'), 'utf8'))
  assert.deepEqual(state.open_issues.map((issue) => issue.id), ['RR-CONT-001'])
})

test('schema-invalid Copilot output fails closed before normalization', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'copilot'], { FAKE_OMIT_STATE_METADATA: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /structured state is missing required field/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('duplicate finding IDs fail schema validation', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, [], { FAKE_REVIEWER_FINDING_IDS: 'RR-DUP-001,RR-DUP-001' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /duplicate finding ID: RR-DUP-001/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('blank finding IDs fail schema validation', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, [], { FAKE_EMPTY_FINDING_ID: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /finding ID must be non-empty/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('an ID cannot be both open and resolved', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, [], {
    FAKE_REVIEWER_FINDING_IDS: 'RR-OVERLAP-001',
    FAKE_REVIEWER_RESOLVED_IDS: 'RR-OVERLAP-001',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /finding ID appears as both open and resolved: RR-OVERLAP-001/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('malformed provider output fails closed without updating continuity', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'copilot'], { FAKE_REVIEWER_MALFORMED: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /could not use structured review output/)
  assert.match(result.stderr, /Do not use its findings/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('the provider-independent mutation guard rejects reviewer writes', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'claude'], { FAKE_REVIEWER_MUTATE: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /worktree changed during the review/)
  assert.match(result.stderr, /README\.md/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('rejects a run when the reviewer changes private scope artifacts', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'claude'], { FAKE_REVIEWER_MUTATE_ARTIFACT: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /changed or deleted the private scope artifacts/)
  assert.match(result.stderr, /not trustworthy/)
  assert.ok(!fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('--no-reviewer builds private scope artifacts without starting a CLI', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--provider', 'copilot', '--no-reviewer'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Prompt built/)
  assert.ok(!fs.existsSync(fixture.argsPath), 'no reviewer executable should run')

  const ledger = ledgerDir(fixture.repoDir)
  const runs = fs.readdirSync(path.join(ledger, 'runs'))
  assert.equal(runs.length, 1)
  const runDir = path.join(ledger, 'runs', runs[0])
  assert.ok(fs.existsSync(path.join(runDir, 'scope.patch')))
  assert.ok(fs.existsSync(path.join(runDir, 'scope-summary.txt')))
  assert.ok(fs.existsSync(path.join(runDir, 'changed-files.txt')))
})
