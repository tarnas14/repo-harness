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
  'local-code-review',
  'scripts',
  'run-local-review.cjs',
)
const STDOUT_MARKER = 'VERBOSE_REVIEWER_STDOUT_MARKER'
const STDERR_MARKER = 'VERBOSE_REVIEWER_STDERR_MARKER'

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-code-review-output-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const repoDir = path.join(root, 'repo')
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(repoDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  run('git', ['init', '--quiet'], { cwd: repoDir })
  run('git', ['config', 'user.email', 'review-test@example.com'], { cwd: repoDir })
  run('git', ['config', 'user.name', 'Review Test'], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n')
  run('git', ['add', 'README.md'], { cwd: repoDir })
  run('git', ['commit', '--quiet', '-m', 'Initial fixture'], { cwd: repoDir })

  const fakeCodexPath = path.join(binDir, 'codex')
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
'use strict'

const fs = require('node:fs')

const outputIndex = process.argv.indexOf('-o')
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : ''

process.stdout.write('${STDOUT_MARKER}\\n'.repeat(2000))
process.stderr.write('${STDERR_MARKER}\\n'.repeat(2000))

if (process.env.FAKE_CODEX_FAIL === '1') process.exit(7)

fs.writeFileSync(
  outputPath,
  JSON.stringify({
    review_markdown: '## Codex Review Pass 1 - Verdict: OK\\n\\nNo findings.',
    state: {
      schema_version: 1,
      last_reviewed_head_sha: '',
      scope_key: '',
      review_count: 1,
      updated_at: '',
      open_issues: [],
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

function runReview(fixture, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--repo-dir', fixture.repoDir, '--commit', 'HEAD', '--title', 'Output test'],
    {
      cwd: REPO_ROOT,
      env: { ...fixture.env, ...extraEnv },
      encoding: 'utf8',
    },
  )
}

function findCodexLog(repoDir) {
  const ledgerPath = run('git', ['rev-parse', '--git-path', 'codex-review'], { cwd: repoDir })
  const ledgerDir = path.resolve(repoDir, ledgerPath)
  const runsDir = path.join(ledgerDir, 'runs')
  const runDirs = fs.readdirSync(runsDir)
  assert.equal(runDirs.length, 1)
  return path.join(runsDir, runDirs[0], 'codex-exec.log')
}

test('prints only the final review while saving verbose reviewer output', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verdict: OK/)
  assert.doesNotMatch(result.stdout, new RegExp(STDOUT_MARKER))
  assert.doesNotMatch(result.stderr, new RegExp(STDERR_MARKER))

  const log = fs.readFileSync(findCodexLog(fixture.repoDir), 'utf8')
  assert.match(log, new RegExp(STDOUT_MARKER))
  assert.match(log, new RegExp(STDERR_MARKER))
})

test('keeps verbose reviewer output out of a failed run response', (t) => {
  const fixture = createFixture(t)
  const result = runReview(fixture, { FAKE_CODEX_FAIL: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /codex exec failed with exit 7/)
  assert.match(result.stderr, /codex-exec\.log/)
  assert.doesNotMatch(result.stdout, new RegExp(STDOUT_MARKER))
  assert.doesNotMatch(result.stderr, new RegExp(STDERR_MARKER))

  const log = fs.readFileSync(findCodexLog(fixture.repoDir), 'utf8')
  assert.match(log, new RegExp(STDOUT_MARKER))
  assert.match(log, new RegExp(STDERR_MARKER))
})
