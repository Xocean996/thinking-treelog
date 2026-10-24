import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatWeekly,
  isSourcePath,
  isTestPath,
  weeklyFacts,
} from '../packages/core/src/rhythm.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 24, 12);
/**
 * A local wall-clock time `daysAgo` days back.
 *
 * Anchored on local midnight, not on NOW: anchoring on NOW shifted every hour by
 * +12, which silently moved the 23:00 sample into the next day and made the
 * late-night assertion wrong.
 */
const at = (daysAgo, hour) => {
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() - daysAgo * DAY + (hour || 0) * 3600000;
};

const COMMITS = [
  { hash: 'a1', timestamp: at(1, 10), subject: 'feat: add retry' },
  { hash: 'a2', timestamp: at(1, 11), subject: 'fix: handle null' },
  { hash: 'a3', timestamp: at(2, 23), subject: 'feat: dead letter queue' },
  { hash: 'a4', timestamp: at(3, 9), subject: 'test: cover retry' },
];

const FILES = new Map([
  ['a1', { files: [{ path: 'src/retry.js', added: 40, deleted: 2 }] }],
  ['a2', { files: [{ path: 'src/retry.test.js', added: 12, deleted: 0 }] }],
  ['a3', { files: [{ path: 'src/dlq.js', added: 90, deleted: 0 }] }],
  ['a4', { files: [{ path: 'src/retry.test.js', added: 8, deleted: 1 }] }],
]);

test('isTestPath recognises the usual test locations', () => {
  assert.equal(isTestPath('src/retry.test.js'), true);
  assert.equal(isTestPath('test/a.js'), true);
  assert.equal(isTestPath('__tests__/x.ts'), true);
  assert.equal(isTestPath('src/spec/thing.py'), true);
  assert.equal(isTestPath('src/retry.js'), false);
});

test('isSourcePath excludes docs and build output', () => {
  assert.equal(isSourcePath('src/retry.js'), true);
  assert.equal(isSourcePath('src/main.ts'), true);
  assert.equal(isSourcePath('README.md'), false);
  assert.equal(isSourcePath('package.json'), false);
  assert.equal(isSourcePath('dist/bundle.js'), false);
  assert.equal(isSourcePath('node_modules/x/index.js'), false);
});

test('weeklyFacts counts commits, lines and themes in the window', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: COMMITS, fileMap: FILES });

  assert.equal(facts.commitCount, 4);
  assert.equal(facts.totalAdded, 40 + 12 + 90 + 8);
  assert.equal(facts.totalDeleted, 2 + 0 + 0 + 1);
  assert.equal(facts.themes.feature, 2);
  assert.equal(facts.themes.fix, 1);
  assert.equal(facts.themes.test, 1);
  assert.equal(facts.activeDays.length, 3);
});

test('weeklyFacts ignores commits outside the window', () => {
  const old = [{ hash: 'z', timestamp: at(30, 10), subject: 'feat: ancient' }];
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: old, fileMap: new Map() });
  assert.equal(facts.commitCount, 0);
});

test('weeklyFacts flags a source change that shipped without a test', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: COMMITS, fileMap: FILES });

  // a1 and a3 changed source only; a2 and a4 touched a test file.
  assert.equal(facts.untestedCount, 2);
  assert.deepEqual(
    facts.untested.map((item) => item.hash).sort(),
    ['a1', 'a3'],
  );
});

test('weeklyFacts counts late-night commits', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: COMMITS, fileMap: FILES });
  assert.equal(facts.lateNight, 1, 'a3 landed at 23:00');
});

test('weeklyFacts ranks files by how often they were touched', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: COMMITS, fileMap: FILES });
  assert.equal(facts.files[0].path, 'src/retry.test.js');
  assert.equal(facts.files[0].touched, 2);
});

test('formatWeekly puts the totals first and names one next action', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: COMMITS, fileMap: FILES });
  const text = formatWeekly(facts);

  assert.match(text, /^# 周报 · /);
  assert.match(text, /4 次提交/);
  assert.match(text, /## 交付了什么/);
  assert.match(text, /## 精力花在哪/);
  assert.match(text, /## 需要说明的/);
  assert.match(text, /2 次改动只动了源码/);
  assert.match(text, /## 下周只改一件事/);
  // Exactly one action item, never a list of ten.
  const actionBlock = text.split('## 下周只改一件事')[1] || '';
  assert.equal((actionBlock.match(/^- /gm) || []).length, 1);
});

test('formatWeekly handles an empty week without crashing', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: [], fileMap: new Map() });
  const text = formatWeekly(facts);
  assert.match(text, /没有提交记录/);
});

test('formatWeekly writes English when asked', () => {
  const facts = weeklyFacts('.', { now: NOW, days: 7, commits: COMMITS, fileMap: FILES });
  const text = formatWeekly(facts, { locale: 'en' });
  assert.match(text, /^# Weekly · /);
  assert.match(text, /## What shipped/);
});
