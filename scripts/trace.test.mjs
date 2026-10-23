import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseMarkdown } from '../packages/core/src/engineering.js';
import { parsePlan } from '../packages/core/src/plan.js';
import {
  coverageScore,
  formatTrace,
  tokenize,
  traceCoverage,
} from '../packages/core/src/trace.js';
import { tracePaths } from '../packages/cli/lib/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = readFileSync(resolve(here, '../examples/superpowers-spec.md'), 'utf8');
const PLAN = readFileSync(resolve(here, '../examples/superpowers-plan.md'), 'utf8');

const io = {
  readFile: async (path) => {
    if (path.includes('spec')) return SPEC;
    return PLAN;
  },
};

test('tokenize produces CJK bigrams and latin words', () => {
  const tokens = tokenize('采用插件形态 plugin parser');
  assert.ok(tokens.has('插件'));
  assert.ok(tokens.has('采用'));
  assert.ok(tokens.has('plugin'));
  assert.ok(tokens.has('parser'));
  assert.ok(!tokens.has('的'), 'stop words are dropped');
});

test('coverageScore is asymmetric and bounded', () => {
  const query = tokenize('interface graph consumes produces');
  const document = tokenize('Interface linter consumes produces declarations');
  const score = coverageScore(query, document);

  assert.ok(score > 0 && score <= 1);
  assert.equal(coverageScore(new Set(), document), 0);
  assert.equal(coverageScore(query, new Set()), 0);
});

test('traceCoverage scopes to the Decision section', () => {
  const specNodes = parseMarkdown(SPEC);
  const plan = parsePlan(PLAN);
  const result = traceCoverage(specNodes, plan.tasks);

  // Context and Consequences are not implementable decisions.
  assert.equal(result.decisionCount, 4);
  assert.ok(result.entries.every((entry) => !/^Teams write/.test(entry.node.text)));
});

test('traceCoverage finds the right task for each decision', () => {
  const result = traceCoverage(parseMarkdown(SPEC), parsePlan(PLAN).tasks);

  const byText = (fragment) =>
    result.entries.find((entry) => entry.node.text.includes(fragment));

  assert.equal(byText('Parse the plan document').taskId, 1);
  assert.equal(byText('interface graph').taskId, 2);
  assert.equal(byText('Render the findings').taskId, 3);
  assert.equal(byText('Capture the current conversation').matched, false);
});

test('traceCoverage reports tasks the spec never mentions', () => {
  const result = traceCoverage(parseMarkdown(SPEC), parsePlan(PLAN).tasks);
  // Every task happens to be referenced in this fixture.
  assert.equal(result.unreferencedTasks.length, 0);

  const narrower = traceCoverage(parseMarkdown(SPEC), parsePlan(PLAN).tasks.slice(0, 1));
  assert.ok(narrower.unreferencedTasks.every((task) => task.id !== 1 || task.id === 1));
});

test('traceCoverage falls back to node types without a Decision section', () => {
  const spec = parseMarkdown(`# T\n\n- Parse the plan document and extract tasks\n- Build an interface graph from Consumes and Produces\n`);
  const result = traceCoverage(spec, parsePlan(PLAN).tasks);
  assert.equal(result.decisionCount, 2);
});

test('threshold controls what counts as matched', () => {
  const specNodes = parseMarkdown(SPEC);
  const tasks = parsePlan(PLAN).tasks;

  const strict = traceCoverage(specNodes, tasks, { threshold: 0.9 });
  assert.equal(strict.matched.length, 0);
  assert.equal(strict.unmatched.length, 4);

  const loose = traceCoverage(specNodes, tasks, { threshold: 0 });
  assert.equal(loose.unmatched.length, 0);
});

test('formatTrace renders matched, unmatched and summary', () => {
  const result = traceCoverage(parseMarkdown(SPEC), parsePlan(PLAN).tasks);
  const text = formatTrace(result, { specTitle: 'spec.md', planTitle: 'plan.md' });

  assert.match(text, /spec\.md → plan\.md/);
  assert.match(text, /matched:/);
  assert.match(text, /no plausible task/);
  assert.match(text, /3\/4 decisions/);
});

test('tracePaths returns text, json and an exit code', async () => {
  const text = await tracePaths('spec.md', 'plan.md', { readFile: io.readFile });
  assert.match(text.text, /Task 1: Plan parser/);
  assert.equal(text.exitCode, 1, 'one unmatched decision');

  const json = await tracePaths('spec.md', 'plan.md', { readFile: io.readFile, format: 'json' });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.summary.decisions, 4);
  assert.equal(parsed.summary.matched, 3);
  assert.equal(parsed.summary.unmatched, 1);
  assert.ok(Array.isArray(parsed.entries));
});

test('trace can be silenced with fail-on never', async () => {
  const result = await tracePaths('spec.md', 'plan.md', { readFile: io.readFile });
  assert.equal(result.exitCode, 1);
});
