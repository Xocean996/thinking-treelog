import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeRhythm,
  formatRhythm,
  rhythmToTree,
  themeOf,
} from '../packages/core/src/rhythm.js';
import { rhythmReport } from '../packages/cli/lib/commands.mjs';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 23, 12);

const COMMITS = [
  { hash: 'a', timestamp: NOW - 1 * DAY, subject: 'feat: 加面板导航' },
  { hash: 'b', timestamp: NOW - 1 * DAY, subject: 'fix: 修按钮颜色' },
  { hash: 'c', timestamp: NOW - 5 * DAY, subject: 'docs: 写使用说明' },
  { hash: 'd', timestamp: NOW - 20 * DAY, subject: 'feat: 初始化项目' },
];

const STALE = [
  { hash: 'x', timestamp: NOW - 10 * DAY, subject: 'feat: 很久以前' },
  { hash: 'y', timestamp: NOW - 12 * DAY, subject: 'fix: 更久以前' },
];

test('themeOf classifies commit subjects', () => {
  assert.equal(themeOf('feat: add thing'), 'feature');
  assert.equal(themeOf('修复登录'), 'fix');
  assert.equal(themeOf('docs: readme'), 'docs');
  assert.equal(themeOf('refactor: split module'), 'refactor');
  assert.equal(themeOf('whatever'), 'other');
});

test('analyzeRhythm counts active days, span and cadence', () => {
  const a = analyzeRhythm('/tmp/x', { commits: COMMITS, now: NOW });

  assert.equal(a.commits.length, 4);
  assert.equal(a.activeDays, 3);
  assert.equal(a.spanDays, 19);
  assert.equal(a.lastAgoDays, 1);
  assert.equal(a.stalled, false);
  assert.equal(a.source, 'git');
  assert.ok(a.cadencePerDay > 0);
});

test('analyzeRhythm splits phases at gaps over two days', () => {
  const a = analyzeRhythm('/tmp/x', { commits: COMMITS, now: NOW });
  // day-1 pair, day-5 alone, day-20 alone
  assert.equal(a.phases.length, 3);
  assert.equal(a.phases[0].count, 1, 'oldest event starts the first phase');
  assert.equal(a.phases[2].count, 2, 'the two commits one day ago close the last phase');
});

test('analyzeRhythm flags a stalled project', () => {
  const a = analyzeRhythm('/tmp/x', { commits: STALE, now: NOW });
  assert.equal(a.stalled, true);
  assert.equal(a.lastAgoDays, 10);
});

test('analyzeRhythm counts themes', () => {
  const a = analyzeRhythm('/tmp/x', { commits: COMMITS, now: NOW });
  assert.equal(a.themes.feature, 2);
  assert.equal(a.themes.fix, 1);
  assert.equal(a.themes.docs, 1);
});

test('rhythmToTree builds a rooted, well-parented tree', () => {
  const a = analyzeRhythm('/tmp/x', { commits: COMMITS, now: NOW });
  const nodes = rhythmToTree(a);

  const roots = nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1);
  assert.match(roots[0].label, /项目节奏/);

  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    if (node.parentId !== null) assert.ok(ids.has(node.parentId));
  }

  assert.ok(nodes.some((n) => n.type === 'constraint') === false, 'not stalled, so no constraint');
  assert.ok(nodes.some((n) => /阶段/.test(n.label)));
  assert.ok(nodes.some((n) => /主线分布/.test(n.label)));
});

test('formatRhythm reports a pickup suggestion', () => {
  const a = analyzeRhythm('/tmp/x', { commits: COMMITS, now: NOW });
  const text = formatRhythm(a, { locale: 'zh' });

  assert.match(text, /项目节奏/);
  assert.match(text, /阶段/);
  assert.match(text, /建议/);
  assert.match(text, /加面板导航/);
});

test('formatRhythm warns when the project has stalled', () => {
  const a = analyzeRhythm('/tmp/x', { commits: STALE, now: NOW });
  const text = formatRhythm(a, { locale: 'zh' });
  assert.match(text, /停滞 10 天/);
  assert.match(text, /断档/);
});

test('rhythmReport renders text, json and tree', async () => {
  const text = await rhythmReport('/tmp/x', { commits: COMMITS, now: NOW });
  assert.match(text.text, /项目节奏/);
  assert.ok(Array.isArray(text.tree) && text.tree.length > 3);

  const json = await rhythmReport('/tmp/x', { commits: COMMITS, now: NOW, format: 'json' });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.activeDays, 3);
  assert.equal(parsed.stalled, false);
  assert.equal(parsed.phases.length, 3);

  const tree = await rhythmReport('/tmp/x', { commits: COMMITS, now: NOW, format: 'tree' });
  assert.match(tree.text, /├──|└──/);
});

test('analyzeRhythm degrades gracefully with no history', () => {
  const a = analyzeRhythm('/definitely/not/a/real/path', { commits: [], now: NOW });
  assert.equal(a.commits.length, 0);
  assert.ok(a.message);
  const text = formatRhythm(a, { locale: 'en' });
  assert.match(text, /No git history/i);
});
