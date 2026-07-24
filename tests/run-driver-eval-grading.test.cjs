'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { findingAssessment, grade } = require('../evals/local-code-review-driver/scripts/run-driver-eval.cjs')

const ALL_IDS = ['RRD-001', 'RRD-002', 'RRD-003']

test('reads each disposition from its own finding block', () => {
  const output = [
    'RRD-001: actionable now - real bug in scope',
    'RRD-002: reject - invented guarantee',
    'RRD-003: defer or accept risk - follow-up for the owner',
  ].join('\n')

  assert.equal(findingAssessment(output, 'RRD-001', ALL_IDS), 'actionable now')
  assert.equal(findingAssessment(output, 'RRD-002', ALL_IDS), 'reject')
  assert.equal(findingAssessment(output, 'RRD-003', ALL_IDS), 'defer or accept risk')
})

test('a finding without its own disposition cannot borrow the next finding verdict', () => {
  const output = [
    'RRD-001 looks concerning and needs more thought.',
    'RRD-002: reject - invented guarantee',
  ].join('\n')

  assert.equal(findingAssessment(output, 'RRD-001', ALL_IDS), null)
  assert.equal(findingAssessment(output, 'RRD-002', ALL_IDS), 'reject')
})

test('conflicting dispositions across mentions are reported as ambiguous and fail grading', () => {
  const output = [
    'RRD-001: reject - out of scope.',
    'On second thought: RRD-001 is actionable now after all.',
  ].join('\n')

  assert.equal(findingAssessment(output, 'RRD-001', ALL_IDS), 'ambiguous')

  const evalCase = { expected_dispositions: { 'RRD-001': 'not-actionable' } }
  const results = grade(evalCase, output)
  assert.equal(results[0].pass, false)
  assert.match(results[0].detail, /conflicting/)
})

test('prompt echo of the report without disposition words does not grade as a pass', () => {
  const output = [
    '### RRD-001: Unclosed file handle leaks on render failure',
    'Suggested fix: close the handle in a finally block.',
    '### RRD-002: Download URL is built from unvalidated user input',
    'Suggested fix: validate the report name.',
  ].join('\n')

  assert.equal(findingAssessment(output, 'RRD-001', ALL_IDS), null)
  assert.equal(findingAssessment(output, 'RRD-002', ALL_IDS), null)
})

test('negated actionable is never graded as actionable', () => {
  const output = 'RRD-001: not actionable now because this is outside the approved scope.'
  assert.equal(findingAssessment(output, 'RRD-001', ALL_IDS), null)

  const evalCase = { expected_dispositions: { 'RRD-001': 'actionable' } }
  const results = grade(evalCase, output)
  assert.equal(results[0].pass, false, 'a negated actionable must fail an actionable expectation')
})

test('indirect negation is never graded as actionable', () => {
  assert.equal(
    findingAssessment('RRD-001: I would not consider this actionable now because it is outside scope.', 'RRD-001', ALL_IDS),
    null,
  )
  assert.equal(findingAssessment('RRD-001: not really actionable now.', 'RRD-001', ALL_IDS), null)
  assert.equal(findingAssessment("RRD-001: this isn't actionable now in my view.", 'RRD-001', ALL_IDS), null)
})

test('a label buried deep in prose is not an explicit classification', () => {
  const prose =
    'RRD-001 raises an interesting concern about resource cleanup that deserves a longer discussion ' +
    'of tradeoffs before anyone decides, though eventually one might call it actionable now.'
  assert.equal(findingAssessment(prose, 'RRD-001', ALL_IDS), null)
})

test('negated actionable followed by an explicit label grades as the explicit label', () => {
  const output = 'RRD-002: not actionable now - reject, invented guarantee.'
  assert.equal(findingAssessment(output, 'RRD-002', ALL_IDS), 'reject')
})

test('grade fails findings with no visible disposition', () => {
  const evalCase = {
    expected_dispositions: {
      'RRD-001': 'actionable',
      'RRD-002': 'not-actionable',
    },
  }
  const output = 'RRD-001: actionable now - fix it.'
  const results = grade(evalCase, output)

  assert.deepEqual(
    results.map((entry) => [entry.findingId, entry.pass]),
    [
      ['RRD-001', true],
      ['RRD-002', false],
    ],
  )
})
