import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  classifyStage,
  decodeSession,
  listWorkspaces,
  pulseToTree,
  readSessionHeader,
  reviewOf,
  sessionsRoot,
  suggestNext,
} from '../packages/dsh-plugin/index.js';
import { reviewQuestion, stageOf } from '../packages/core/src/workspace.js';
import { normalizeNodes } from '../packages/core/src/index.js';

const SAMPLE = [
  '这个再优化一下',
  'QPS 200 时丢 0.3%，想 5 秒内重试 3 次。不要动下游幂等，验收：压测 1000 次零丢失。',
  '顺手把注册、找回密码、手机绑定也做一下吧',
  '报错了，走不通',
  '跑一下测试验证',
  '出个计划拆成任务',
];

test('classifyStage maps a question to one of six stages', () => {
  assert.equal(classifyStage('报错了，走不通').stage, 'debug');
  assert.equal(classifyStage('跑一下测试验证').stage, 'verify');
  assert.equal(classifyStage('出个计划拆成任务').stage, 'plan');
  assert.equal(classifyStage('帮我实现这个函数').stage, 'build');
  assert.equal(classifyStage('审查一下这段代码').stage, 'review');
  assert.equal(classifyStage('我想做个新东西').stage, 'design');
});

test('classifyStage names the superpowers skill for the stage', () => {
  assert.equal(classifyStage('报错了').skill, 'systematic-debugging');
  assert.equal(classifyStage('出个计划').skill, 'writing-plans');
  assert.equal(classifyStage('帮我实现').skill, 'executing-plans');
  assert.equal(classifyStage('我想做个新东西').skill, 'brainstorming');
});

test('reviewOf returns pros, cons, next, score and a rewrite', () => {
  const review = reviewOf('这个再优化一下', 'design');
  assert.ok(Array.isArray(review.pros) && review.pros.length);
  assert.ok(Array.isArray(review.cons) && review.cons.length);
  assert.ok(Array.isArray(review.next) && review.next.length);
  assert.equal(typeof review.score, 'number');
  assert.match(review.rewrite, /验收：/);
});

test('reviewOf rewards a precise ask and punishes stacked goals', () => {
  const precise = reviewOf(SAMPLE[1], 'design').score;
  const stacked = reviewOf(SAMPLE[2], 'build').score;
  assert.ok(precise > 70, `precise scored ${precise}`);
  assert.ok(stacked < precise - 25, `stacked ${stacked} should trail precise ${precise}`);
});

// The Host keeps its own copy of the review rules (it cannot import the core
// package inside the bundled plugin). This is the test that stops the two from
// drifting apart silently.
test('host review and core review agree on the same question', () => {
  for (const text of SAMPLE) {
    const host = reviewOf(text, classifyStage(text).stage);
    const core = reviewQuestion(text);

    assert.equal(host.score, core.score, `score drift for "${text.slice(0, 16)}"`);
    assert.deepEqual(host.cons, core.cons, `cons drift for "${text.slice(0, 16)}"`);
  }
});

test('host stage strings match core stage strings', () => {
  for (const text of SAMPLE) {
    assert.equal(classifyStage(text).stage, stageOf(text), `stage drift for "${text.slice(0, 16)}"`);
  }
});

test('analyze extracts title, turns, tools and todos from records', () => {
  const analysis = analyze([
    { type: 'session', id: 's1', createdAt: 1000, cwd: '/w' },
    { type: 'session/title', time: 1100, data: { title: '演示' } },
    { type: 'user/message', seq: 1, time: 1200, data: { content: [{ type: 'text', text: '帮我看看' }] } },
    { type: 'user/message', seq: 2, time: 1300, data: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } },
    { type: 'tool/call', time: 1400, data: { name: 'read' } },
    { type: 'tool/call', time: 1500, data: { name: 'read' } },
    { type: 'todo/write', time: 1600, data: { todos: [{ content: 'a', status: 'pending' }] } },
  ]);

  assert.equal(analysis.title, '演示');
  assert.equal(analysis.cwd, '/w');
  assert.equal(analysis.userMessages.length, 1, 'injected reminder is filtered');
  assert.deepEqual(analysis.tools, { read: 2 });
  assert.equal(analysis.todos.length, 1);
});

test('pulseToTree builds a rooted tree with skills and reviews', () => {
  const analysis = analyze([
    { type: 'session', id: 's1', createdAt: 1000, cwd: '/w' },
    { type: 'user/message', seq: 1, time: 1200, data: { content: [{ type: 'text', text: '出个计划拆成任务' }] } },
  ]);
  const suggestions = suggestNext(analysis);
  const nodes = pulseToTree(analysis, suggestions);

  const roots = nodes.filter((node) => node.parentId === null);
  assert.equal(roots.length, 1);

  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (node.parentId !== null) assert.ok(ids.has(node.parentId), 'every parent exists');
  }

  const threadNode = nodes.find((node) => node.skill);
  assert.ok(threadNode, 'thread nodes carry a skill');
  assert.ok(threadNode.review, 'thread nodes carry a review');
  assert.equal(typeof threadNode.seq, 'number');

  assert.ok(nodes.some((node) => node.virtual), 'innovations become virtual children');
});

test('sessionsRoot lives under the dsh home', () => {
  assert.match(sessionsRoot(), /\.dsh[\\/]sessions$/);
});

test('normalizeNodes preserves the link back to the conversation', () => {
  // Dropping seq/messageText here is what made double-click do nothing.
  const [node] = normalizeNodes([
    {
      id: 'a',
      parentId: null,
      label: 'x',
      text: 'y',
      type: 'claim',
      seq: 9,
      messageText: '原文',
      skill: 'brainstorming',
      virtual: true,
      review: { pros: ['p'], cons: ['c'], next: ['n'], score: 62, rewrite: 'r' },
    },
  ]);

  assert.equal(node.seq, 9);
  assert.equal(node.messageText, '原文');
  assert.equal(node.skill, 'brainstorming');
  assert.equal(node.virtual, true);
  assert.equal(node.review.score, 62);
  assert.equal(node.review.rewrite, 'r');
});

test('listWorkspaces returns an array, never throws on a missing root', () => {
  assert.ok(Array.isArray(listWorkspaces('/definitely/not/here')));
  assert.equal(listWorkspaces('/definitely/not/here').length, 0);
});

test('decodeSession resolves to an empty array for a non-session file', async () => {
  const junk = fileURLToPath(new URL('../package.json', import.meta.url));
  const records = await decodeSession(junk, 4, 2);
  assert.ok(Array.isArray(records));
});

test('readSessionHeader returns null instead of throwing on junk', async () => {
  const junk = fileURLToPath(new URL('../package.json', import.meta.url));
  const header = await readSessionHeader(junk);
  assert.equal(header, null);
});
