import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSchedule } from '../lib/schedule.js';
import { findUncoveredRequirements, validateKitStructure } from '../lib/validate.js';
import { buildPracticeQueue, reorderQuestions, updateQuestionState } from '../lib/builder.js';
import { createSessionToken, verifySessionToken } from '../lib/session.js';
import { extractRequirementsFromJD } from '../backend/pipeline.js';
import { generateQuestionsWithGemini } from '../backend/llm.js';

const requirements = [
  { id: 'r1', text: '5+ years of React', priority: 'must', kind: 'technical' },
  { id: 'r2', text: 'Mentor junior engineers', priority: 'must', kind: 'behavioural' },
  { id: 'r3', text: 'Build distributed systems', priority: 'nice', kind: 'domain' },
  { id: 'r4', text: 'Leadership experience', priority: 'must', kind: 'behavioural' },
];

test('allocateSchedule distributes material over the requested days and covers must-haves', () => {
  const schedule = allocateSchedule(requirements, 5, ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.equal(schedule.days_available, 5);
  assert.equal(schedule.days.length, 5);
  assert.ok(schedule.days.every((day) => Number.isInteger(day.minutes) && day.minutes > 0));
  assert.ok(schedule.days.every((day) => Array.isArray(day.question_ids)));
  const allIds = new Set(schedule.days.flatMap((day) => day.question_ids));
  assert.ok(allIds.size >= 4);
  assert.ok(schedule.days[0].focus.length > 0);
});

test('findUncoveredRequirements reports gaps against must requirements', () => {
  const questions = [
    { id: 'q1', requirement_ids: ['r1'] },
    { id: 'q2', requirement_ids: ['r3'] },
  ];

  const uncovered = findUncoveredRequirements(requirements, questions);
  assert.deepEqual(uncovered.sort(), ['r2', 'r4'].sort());
});

test('validateKitStructure rejects missing required fields', () => {
  const invalidKit = {
    source: { company: 'Acme' },
    company_brief: { summary: 'x' },
    role: { title: 'Engineer' },
    questions: [],
    flashcards: [],
    schedule: { days_available: 2, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };

  assert.throws(() => validateKitStructure(invalidKit), /source.company_url/);
});

test('buildPracticeQueue prioritises weaker confidence answers', () => {
  const questions = [
    { id: 'q1', prompt: 'A', answer_outline: 'A', state: 'generated' },
    { id: 'q2', prompt: 'B', answer_outline: 'B', state: 'generated' },
    { id: 'q3', prompt: 'C', answer_outline: 'C', state: 'generated' },
  ];

  const queue = buildPracticeQueue(questions, { q3: 4, q1: 2 });
  assert.deepEqual(queue.map((item) => item.id), ['q1', 'q2', 'q3']);
});

test('reorderQuestions keeps the edited state and moves only the selected item', () => {
  const questions = [
    { id: 'q1', prompt: 'a', state: 'generated' },
    { id: 'q2', prompt: 'b', state: 'edited' },
    { id: 'q3', prompt: 'c', state: 'generated' },
  ];

  const reordered = reorderQuestions(questions, 'q1', 1);
  assert.deepEqual(reordered.map((item) => item.id), ['q2', 'q1', 'q3']);
  assert.equal(reordered[1].state, 'generated');
  assert.equal(reordered[0].state, 'edited');
});

test('createSessionToken and verifySessionToken round-trip a valid user session', () => {
  const secret = 'test-secret';
  const token = createSessionToken({ id: 'u-1', email: 'demo@example.com' }, secret, 60_000);

  assert.ok(token.length > 20);
  const session = verifySessionToken(token, secret);
  assert.deepEqual(session, { id: 'u-1', email: 'demo@example.com' });
});

test('extractRequirementsFromJD preserves unfamiliar technical requirements from unseen postings', () => {
  const extracted = extractRequirementsFromJD(`
    Required qualifications: 4+ years building TypeScript services with GraphQL, Kafka, and Terraform.
    You will own observability and coach cross-functional partners.
    Preferred: experience with Rust and WebAssembly.
  `);

  const text = extracted.map((requirement) => requirement.text.toLowerCase()).join(' ');
  assert.match(text, /typescript/);
  assert.match(text, /graphql/);
  assert.match(text, /kafka/);
  assert.match(text, /terraform/);
  assert.match(text, /observability/);
  assert.ok(extracted.some((requirement) => requirement.priority === 'nice' && /rust/i.test(requirement.text)));
});

test('extractRequirementsFromJD stays honest for a thin description', () => {
  const extracted = extractRequirementsFromJD('Two line stub');
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].priority, 'nice');
  assert.match(extracted[0].text, /No concrete requirements/i);
});

test('Gemini adapter validates separate category responses and retries provider throttling', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = global.fetch;
  process.env.GEMINI_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ prompt: 'Question', answer_outline: 'Answer', requirement_ids: ['r1'], difficulty: 2 }]) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const questions = await generateQuestionsWithGemini([{ id: 'r1', text: 'Build APIs', kind: 'technical', priority: 'must' }], { summary: 'Public research' });
    assert.equal(questions.length, 3);
    assert.deepEqual(new Set(questions.map((question) => question.category)), new Set(['technical', 'behavioural', 'company-fit']));
    assert.ok(calls >= 4);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
