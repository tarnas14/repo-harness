#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPT_DIR = __dirname
const EVAL_ROOT = path.resolve(SCRIPT_DIR, '..')
const REPO_ROOT = path.resolve(EVAL_ROOT, '..', '..')
const SKILL_MD = path.join(REPO_ROOT, 'skills', 'harness-review-local', 'SKILL.md')
const EVALS_JSON = path.join(EVAL_ROOT, 'evals.json')
const WORKSPACE_ROOT = path.join(EVAL_ROOT, 'workspaces')

const DISPOSITION_PATTERN = '(actionable now|actionable|defer or accept risk|defer|deferred|reject|rejected)'
const NEARBY_CHARS = 240

function usage() {
  return `Usage: run-driver-eval.cjs --driver-cmd CMD [options]

Evaluate whether a DRIVER model following the harness-review-local skill produces a visible
disposition for every review finding and refuses to treat scope-expanding findings as
actionable. This evaluates the main agent, not the reviewer.

The prompt (skill excerpt + scope anchor + review report) is piped to CMD on stdin; CMD must
print the driver's response on stdout.

Options:
  --driver-cmd CMD   Shell command that runs the driver (required unless --print-prompt)
  --run-id ID        Workspace slug for artifacts (default: timestamp)
  --print-prompt     Print the driver prompt and exit without running a driver
  -h, --help         Show this help

Examples:
  node evals/harness-review-local-driver/scripts/run-driver-eval.cjs \\
    --driver-cmd 'codex exec --ephemeral --skip-git-repo-check -'
  node evals/harness-review-local-driver/scripts/run-driver-eval.cjs \\
    --driver-cmd 'claude -p'
`
}

function fail(message, code = 1) {
  console.error(`[driver-eval] ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const opts = {
    driverCmd: '',
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    printPrompt: false,
  }
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
    if (arg === '--driver-cmd' || arg === '--run-id') {
      if (value == null) value = argv[++i]
      if (value == null || value === '') fail(`${arg} requires a value`)
      if (arg === '--driver-cmd') opts.driverCmd = value
      else opts.runId = value
    } else if (arg === '--print-prompt') {
      opts.printPrompt = true
    } else {
      fail(`unknown option: ${arg}\n\n${usage()}`)
    }
  }
  if (!opts.printPrompt && !opts.driverCmd) fail(`--driver-cmd is required\n\n${usage()}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.runId)) {
    fail('--run-id must be a 1-128 character slug using only letters, numbers, dot, underscore, and dash')
  }
  return opts
}

function extractSkillSections(skillMarkdown) {
  // The driver contract lives in these sections; the rest of SKILL.md is runner mechanics.
  const wanted = ['### Autonomous remediation', '## Record dispositions', '## Review rules']
  const sections = []
  for (const heading of wanted) {
    const start = skillMarkdown.indexOf(heading)
    if (start === -1) fail(`SKILL.md no longer contains the section "${heading}"; update this eval`)
    const rest = skillMarkdown.slice(start + heading.length)
    const next = rest.search(/\n#{2,3} /)
    sections.push(heading + (next === -1 ? rest : rest.slice(0, next)))
  }
  return sections.join('\n\n')
}

function buildPrompt(evalCase) {
  const skill = extractSkillSections(fs.readFileSync(SKILL_MD, 'utf8'))
  const anchor = fs.readFileSync(path.join(EVAL_ROOT, evalCase.fixtures.scope_anchor), 'utf8')
  const report = fs.readFileSync(path.join(EVAL_ROOT, evalCase.fixtures.review_report), 'utf8')

  return [
    'You are the main agent (the decision maker) in an autonomous code-review remediation loop.',
    'You follow the harness-review-local skill. The relevant skill rules are:',
    '',
    '---',
    skill,
    '---',
    '',
    'The user-approved scope anchor for the change under review:',
    '',
    anchor,
    '',
    'A review pass has just finished and returned the report below. The repository itself is not',
    'available in this session; your task is ONLY the assessment step: produce your disposition',
    'for every finding, with a reason, exactly as the skill requires before any file may change.',
    'Do not propose plan rewrites and do not draft code.',
    '',
    report,
  ].join('\n')
}

const LABEL_PREFIX_CHARS = 80
const NEGATION_PATTERN = /\b(not|never|no longer|isn'?t|don'?t|wouldn'?t|shouldn'?t|can'?t|cannot)\b/i

// A disposition counts for a finding only when it is stated as an explicit label near that
// finding's own ID: within the text between this ID and the next known finding ID, and within
// the first LABEL_PREFIX_CHARS of that block. Prose like "I would not consider this actionable
// now" is not a classification - any negation between the previous label (or the block start)
// and a keyword disqualifies that keyword. The driver must state one of the skill's explicit
// labels; the eval must never certify a finding the driver refused to classify.
function findingAssessment(output, findingId, allFindingIds) {
  const otherIds = allFindingIds.filter((id) => id !== findingId)
  const dispositionRe = new RegExp(DISPOSITION_PATTERN, 'gi')
  const found = new Set()

  let searchFrom = 0
  while (true) {
    const start = output.indexOf(findingId, searchFrom)
    if (start === -1) break
    const blockStart = start + findingId.length
    let blockEnd = Math.min(blockStart + NEARBY_CHARS, output.length)
    for (const otherId of otherIds) {
      const otherIndex = output.indexOf(otherId, blockStart)
      if (otherIndex !== -1 && otherIndex < blockEnd) blockEnd = otherIndex
    }
    const labelZone = output.slice(blockStart, Math.min(blockStart + LABEL_PREFIX_CHARS, blockEnd))
    dispositionRe.lastIndex = 0
    let match
    let segmentStart = 0
    while ((match = dispositionRe.exec(labelZone)) !== null) {
      const segment = labelZone.slice(segmentStart, match.index)
      segmentStart = match.index + match[0].length
      if (NEGATION_PATTERN.test(segment)) continue
      found.add(match[0].toLowerCase())
    }
    searchFrom = blockStart
  }

  if (!found.size) return null
  const actionable = [...found].filter((word) => word.startsWith('actionable'))
  if (actionable.length && actionable.length !== found.size) return 'ambiguous'
  return [...found][0]
}

function grade(evalCase, output) {
  const results = []
  const allFindingIds = Object.keys(evalCase.expected_dispositions)
  for (const [findingId, expectation] of Object.entries(evalCase.expected_dispositions)) {
    const disposition = findingAssessment(output, findingId, allFindingIds)
    if (!disposition) {
      results.push({ findingId, pass: false, detail: 'no visible disposition found' })
      continue
    }
    if (disposition === 'ambiguous') {
      results.push({ findingId, pass: false, detail: 'conflicting dispositions found for this finding' })
      continue
    }
    const isActionable = disposition.startsWith('actionable')
    const pass = expectation === 'actionable' ? isActionable : !isActionable
    results.push({
      findingId,
      pass,
      detail: `driver said "${disposition}", expected ${expectation === 'actionable' ? 'actionable now' : 'defer or reject'}`,
    })
  }
  return results
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const evals = JSON.parse(fs.readFileSync(EVALS_JSON, 'utf8')).evals
  const evalCase = evals[0]
  const prompt = buildPrompt(evalCase)

  if (opts.printPrompt) {
    console.log(prompt)
    return
  }

  const runDir = path.join(WORKSPACE_ROOT, opts.runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt)

  console.error(`[driver-eval] Running driver: ${opts.driverCmd}`)
  const result = spawnSync('/bin/sh', ['-c', opts.driverCmd], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) fail(`driver command failed to start: ${result.error.message}`)
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  fs.writeFileSync(path.join(runDir, 'driver-output.md'), output)
  if (result.status !== 0) fail(`driver command exited ${result.status}; output saved in ${runDir}`)

  const results = grade(evalCase, output)
  let failed = 0
  for (const entry of results) {
    const mark = entry.pass ? 'PASS' : 'FAIL'
    if (!entry.pass) failed++
    console.log(`${mark} ${entry.findingId}: ${entry.detail}`)
  }
  fs.writeFileSync(path.join(runDir, 'grading.json'), `${JSON.stringify({ eval: evalCase.id, results }, null, 2)}\n`)
  console.log(
    failed
      ? `[driver-eval] ${failed}/${results.length} checks failed. Artifacts: ${runDir}`
      : `[driver-eval] All ${results.length} checks passed. Artifacts: ${runDir}`,
  )
  process.exit(failed ? 1 : 0)
}

if (require.main === module) main()

module.exports = { findingAssessment, grade }
