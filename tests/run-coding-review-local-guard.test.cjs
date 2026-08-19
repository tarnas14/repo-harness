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

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-review-local-guard-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const repoDir = path.join(root, 'repo')
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(repoDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  run('git', ['init', '--quiet'], { cwd: repoDir })
  run('git', ['config', 'user.email', 'review-test@example.com'], { cwd: repoDir })
  run('git', ['config', 'user.name', 'Review Test'], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n')
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'scratch/\n')
  run('git', ['add', 'README.md', '.gitignore'], { cwd: repoDir })
  run('git', ['commit', '--quiet', '-m', 'Initial fixture'], { cwd: repoDir })

  const fakeCodexPath = path.join(binDir, 'codex')
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const outputIndex = process.argv.indexOf('-o')
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : ''

if (process.env.FAKE_CODEX_SLEEP_MS) {
  const wake = Date.now() + Number(process.env.FAKE_CODEX_SLEEP_MS)
  while (Date.now() < wake) {}
}

if (process.env.FAKE_CODEX_WRITE_IGNORED === '1') {
  fs.mkdirSync('scratch', { recursive: true })
  fs.writeFileSync(path.join('scratch', 'runtime.log'), 'dev server noise ' + Date.now() + '\\n')
}

if (process.env.FAKE_CODEX_MUTATE_TRACKED === '1') {
  fs.appendFileSync('README.md', 'reviewer vandalism\\n')
}

const openIssues = []
for (const findingId of (process.env.FAKE_CODEX_FINDING_ID || '').split(',').filter(Boolean)) {
  openIssues.push({
    id: findingId,
    severity: 'P1',
    category: 'correctness',
    title: 'Fixture finding ' + findingId,
    file: 'README.md',
    line_range: '1-1',
    failure_scenario: 'Fixture failure scenario.',
    suggested_fix: 'Fixture fix.',
    status: 'open',
    first_seen_head_sha: '',
    last_seen_head_sha: ''
  })
}

const findingSection = openIssues.length
  ? '\\n\\n### P1 Issues\\n\\n#### ' + openIssues[0].id + ' - Fixture finding'
  : ''

fs.writeFileSync(
  outputPath,
  JSON.stringify({
    review_markdown: '## Codex Review Pass 1 - Verdict: ' + (openIssues.length ? 'ATTENTION' : 'OK') + '\\n\\nFixture review.' + findingSection,
    state: {
      schema_version: 1,
      last_reviewed_head_sha: '',
      scope_key: '',
      review_count: 1,
      updated_at: '',
      open_issues: openIssues,
      recently_resolved_issues: []
    }
  })
)
`,
  )
  fs.chmodSync(fakeCodexPath, 0o755)

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
  }

  return { env, repoDir }
}

function runReview(fixture, extraArgs = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--repo-dir', fixture.repoDir, '--commit', 'HEAD', '--title', 'Guard test', ...extraArgs],
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

function runDirs(repoDir) {
  const runsDir = path.join(ledgerDir(repoDir), 'runs')
  if (!fs.existsSync(runsDir)) return []
  return fs
    .readdirSync(runsDir)
    .sort()
    .map((name) => path.join(runsDir, name))
}

test('gitignored runtime files changing during review do not trip the mutation guard', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, [], { FAKE_CODEX_WRITE_IGNORED: '1' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verdict: OK/)
  assert.ok(fs.existsSync(path.join(ledgerDir(fixture.repoDir), 'state.json')))
})

test('tracked-file mutation trips the guard, names the file, and quarantines the output', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, [], { FAKE_CODEX_MUTATE_TRACKED: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /worktree changed during the review/)
  assert.match(result.stderr, /README\.md/)
  assert.match(result.stderr, /Do not use its findings/)

  const ledger = ledgerDir(fixture.repoDir)
  assert.ok(!fs.existsSync(path.join(ledger, 'state.json')), 'state must not persist for a failed run')
  assert.ok(
    !fs.existsSync(path.join(ledger, 'reviewer-output.json')),
    'ledger root must not contain output of a failed run',
  )

  const [runDir] = runDirs(fixture.repoDir)
  assert.ok(runDir)
  assert.ok(fs.existsSync(path.join(runDir, 'reviewer-output.rejected.json')))
  assert.ok(!fs.existsSync(path.join(runDir, 'reviewer-output.json')))
})

test('owner dispositions reach the reviewer prompt and filter dispositioned findings from state', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-FIX-001' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  const firstState = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.equal(firstState.open_issues.length, 1)

  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([
      { id: 'RR-FIX-001', disposition: 'rejected', reason: 'Conflicts with the product decision to keep the flow simple.' },
    ]),
  )

  const second = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-FIX-001' })
  assert.equal(second.status, 0, second.stderr)

  const prompt = fs.readFileSync(path.join(ledger, 'prompt.md'), 'utf8')
  assert.match(prompt, /## Owner Dispositions/)
  assert.match(prompt, /RR-FIX-001/)
  assert.match(prompt, /do not count it toward the verdict/)
  assert.match(prompt, /report it as a NEW finding under a fresh ID/)

  const secondState = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.equal(secondState.open_issues.length, 0, 'dispositioned finding must not stay in open_issues')

  // The fake reviewer re-emitted the dispositioned finding with an ATTENTION verdict; the
  // persisted review and stdout must carry the authoritative effective verdict instead.
  assert.match(second.stdout, /Effective verdict after owner dispositions: OK/)
  assert.match(second.stdout, /RR-FIX-001 \(rejected\)/)
  const persistedReview = fs.readFileSync(path.join(ledger, 'review.md'), 'utf8')
  assert.match(persistedReview, /Effective verdict after owner dispositions: OK/)
})

test('--reset rotates dispositions so a fresh chain cannot be muted by stale IDs', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-RESET-001' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-RESET-001', disposition: 'rejected', reason: 'Old chain decision.' }]),
  )

  const reset = runReview(fixture, ['--reset'], { FAKE_CODEX_FINDING_ID: 'RR-RESET-001' })
  assert.equal(reset.status, 0, reset.stderr)
  assert.match(reset.stderr, /rotated recorded dispositions/)

  const prompt = fs.readFileSync(path.join(ledger, 'prompt.md'), 'utf8')
  assert.doesNotMatch(prompt, /## Owner Dispositions/)
  assert.doesNotMatch(prompt, /RR-RESET-001.*rejected/s)

  const state = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.equal(state.open_issues.length, 1, 'the new chain finding must stay visible after --reset')

  assert.ok(!fs.existsSync(path.join(ledger, 'dispositions.json')))
  const rotated = fs.readdirSync(ledger).filter((name) => name.startsWith('dispositions.reset-'))
  assert.equal(rotated.length, 1)

  const followUp = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-RESET-001' })
  assert.equal(followUp.status, 0, followUp.stderr)
  const followUpState = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.equal(followUpState.open_issues.length, 1, 'later passes must not reload the rotated dispositions')
})

test('a disposition ID unknown to the chain fails before the reviewer runs', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-K-001' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-TYPO-010', disposition: 'rejected', reason: 'Mistyped entry.' }]),
  )

  const blocked = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-K-001' })
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /unknown to this review chain/)
  assert.match(blocked.stderr, /RR-TYPO-010/)
})

test('a disposition stays valid after its finding has been filtered from the latest state', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-K-002' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-K-002', disposition: 'deferred', reason: 'Owner decision.' }]),
  )

  const second = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-K-002' })
  assert.equal(second.status, 0, second.stderr)

  // The finding is now filtered out of open_issues, but the chain still knows its ID, so the
  // recorded disposition must keep loading on later passes instead of failing as unknown.
  const third = runReview(fixture, ['--force'])
  assert.equal(third.status, 0, third.stderr)
  const state = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.ok(state.known_issue_ids.includes('RR-K-002'))

  // An obedient reviewer stops emitting the dispositioned ID entirely; the disposition itself
  // must keep the ID in the chain memory, so a fourth pass still validates cleanly.
  const fourth = runReview(fixture, ['--force'])
  assert.equal(fourth.status, 0, fourth.stderr)
  const fourthState = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.ok(fourthState.known_issue_ids.includes('RR-K-002'))
})

test('legacy states migrate dispositions proven by the latest successful run snapshot', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-LEGACY-001' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  const statePath = path.join(ledger, 'state.json')
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-LEGACY-001', disposition: 'deferred', reason: 'Recorded before the migration.' }]),
  )

  // A successful pass snapshots the active dispositions into its run directory.
  const second = runReview(fixture, ['--force'])
  assert.equal(second.status, 0, second.stderr)

  // Simulate a state written before known_issue_ids existed, after the finding left open_issues.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  delete state.known_issue_ids
  state.open_issues = []
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))

  const third = runReview(fixture, ['--force'])
  assert.equal(third.status, 0, third.stderr)
  assert.match(third.stderr, /latest successful run snapshot/)

  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.ok(migrated.known_issue_ids.includes('RR-LEGACY-001'), 'the migrated state must adopt the proven disposition ID')
})

test('a mistyped ID added during legacy migration fails instead of poisoning the chain memory', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-LEGACY-002' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  const statePath = path.join(ledger, 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  delete state.known_issue_ids
  state.open_issues = []
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))

  // No prior snapshot proves this ID and the doctored legacy state does not contain it either.
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-TYPO-999', disposition: 'deferred', reason: 'Mistyped during migration.' }]),
  )

  const blocked = runReview(fixture, ['--force'])
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /unknown to this review chain/)
  assert.match(blocked.stderr, /RR-TYPO-999/)
})

test('changed review contract or dispositions re-trigger a pass on an unchanged checkout', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-CTX-001' })
  assert.equal(first.status, 0, first.stderr)

  // Same checkout, changed contract: must run a fresh pass instead of skipping.
  const withGoal = runReview(fixture, ['--goal', 'Ship the fixture feature'], { FAKE_CODEX_FINDING_ID: 'RR-CTX-001' })
  assert.equal(withGoal.status, 0, withGoal.stderr)
  assert.match(withGoal.stdout, /Verdict:/)
  assert.doesNotMatch(withGoal.stdout, /No new scope to review/)

  // Identical inputs: now the skip applies.
  const identical = runReview(fixture, ['--goal', 'Ship the fixture feature'], { FAKE_CODEX_FINDING_ID: 'RR-CTX-001' })
  assert.equal(identical.status, 0, identical.stderr)
  assert.match(identical.stdout, /No new scope to review/)

  // Recording a disposition changes the review inputs and must re-trigger a pass too.
  fs.writeFileSync(
    path.join(ledgerDir(fixture.repoDir), 'dispositions.json'),
    JSON.stringify([{ id: 'RR-CTX-001', disposition: 'rejected', reason: 'Owner decision.' }]),
  )
  const afterDisposition = runReview(fixture, ['--goal', 'Ship the fixture feature'], { FAKE_CODEX_FINDING_ID: 'RR-CTX-001' })
  assert.equal(afterDisposition.status, 0, afterDisposition.stderr)
  assert.doesNotMatch(afterDisposition.stdout, /No new scope to review/)
  assert.match(afterDisposition.stdout, /Effective verdict after owner dispositions: OK/)
})

test('a fresh finding ID survives filtering while the dispositioned old ID stays excluded', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-OLD-001' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-OLD-001', disposition: 'rejected', reason: 'Old incarnation settled.' }]),
  )

  // The reviewer re-emits the settled old ID and raises materially new evidence under a fresh ID.
  const second = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-OLD-001,RR-NEW-002' })
  assert.equal(second.status, 0, second.stderr)

  const state = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.deepEqual(
    state.open_issues.map((issue) => issue.id),
    ['RR-NEW-002'],
    'the fresh ID must stay open while the dispositioned old ID is filtered',
  )
  assert.match(second.stdout, /Effective verdict after owner dispositions: ATTENTION/)
})

test('a reset pass that does not complete leaves the current chain dispositions intact', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-KEEP-001' })
  assert.equal(first.status, 0, first.stderr)

  const ledger = ledgerDir(fixture.repoDir)
  fs.writeFileSync(
    path.join(ledger, 'dispositions.json'),
    JSON.stringify([{ id: 'RR-KEEP-001', disposition: 'rejected', reason: 'Owner decision on the current chain.' }]),
  )

  const preview = runReview(fixture, ['--reset', '--no-codex'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(
    fs.existsSync(path.join(ledger, 'dispositions.json')),
    'a --no-codex reset preview must not rotate the current chain dispositions',
  )

  const normal = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-KEEP-001' })
  assert.equal(normal.status, 0, normal.stderr)
  const state = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'))
  assert.equal(state.open_issues.length, 0, 'the still-current chain must keep suppressing its rejected finding')
})

test('warns when previous open findings have no recorded disposition', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-FIX-002' })
  assert.equal(first.status, 0, first.stderr)

  const second = runReview(fixture, ['--force'], { FAKE_CODEX_FINDING_ID: 'RR-FIX-002' })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stderr, /no recorded disposition/)
  assert.match(second.stderr, /RR-FIX-002/)
})

test('fixing the checkout between passes silences the undispositioned warning', (t) => {
  const fixture = createFixture(t)

  const first = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-FIX-002' })
  assert.equal(first.status, 0, first.stderr)

  fs.appendFileSync(path.join(fixture.repoDir, 'README.md'), 'fix for RR-FIX-002\n')
  run('git', ['add', 'README.md'], { cwd: fixture.repoDir })
  run('git', ['commit', '--quiet', '-m', 'Fix finding'], { cwd: fixture.repoDir })

  const second = runReview(fixture, [], { FAKE_CODEX_FINDING_ID: 'RR-FIX-002' })
  assert.equal(second.status, 0, second.stderr)
  assert.doesNotMatch(second.stderr, /no recorded disposition/)
})

test('review contract flags land in the prompt', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, [
    '--no-codex',
    '--goal',
    'Render one report as a PDF and return a download URL',
    '--non-goals',
    'No job queue, no persistent export registry',
    '--focus',
    'docs/plan.md',
  ])

  assert.equal(result.status, 0, result.stderr)
  const prompt = fs.readFileSync(path.join(ledgerDir(fixture.repoDir), 'prompt.md'), 'utf8')
  assert.match(prompt, /## Review Contract/)
  assert.match(prompt, /Render one report as a PDF and return a download URL/)
  assert.match(prompt, /No job queue, no persistent export registry/)
  assert.match(prompt, /docs\/plan\.md/)
  assert.match(prompt, /report that scope growth as a finding/)
})

test('kills a hung reviewer at the timeout and reports it as a hang', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, ['--timeout-min', '0.02'], { FAKE_CODEX_SLEEP_MS: '15000' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /timeout and was killed/)
  assert.match(result.stderr, /hang/)
})
