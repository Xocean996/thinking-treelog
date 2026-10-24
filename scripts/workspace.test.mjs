import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  analyzeConversation,
  decodeSession,
  formatPulse,
  formatRetro,
  pickSession,
  reviewQuestion,
  scoreQuestion,
  stageOf,
  suggestNext,
  threadOf,
} from '../packages/core/src/workspace.js';

const frame = (record) => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`));

function makeSessionFile(records) {
  const dir = mkdtempSync(join(tmpdir(), 'ttl-session-'));
  mkdirSync(join(dir, 'ws', 'session-test'), { recursive: true });
  const file = join(dir, 'ws', 'session-test', 'session.v4.jsonl.zstd');
  writeFileSync(file, Buffer.concat(records.map(frame)));
  return file;
}

const RECORDS = [
  {
    type: 'session',
    version: 4,
    id: 'session-test',
    createdAt: Date.now() - 3600000,
    cwd: 'C:\\work\\demo',
  },
  { type: 'session/title', seq: 15, time: Date.now() - 3500000, data: { title: '演示项目' } },
  {
    type: 'user/message',
    seq: 9,
    time: Date.now() - 3400000,
    data: { content: [{ type: 'text', text: '帮我看看这个插件的结构' }] },
  },
  {
    type: 'user/message',
    seq: 10,
    time: Date.now() - 3300000,
    data: { content: [{ type: 'text', text: '<system-reminder>injected noise</system-reminder>' }] },
  },
  {
    type: 'assistant/message',
    seq: 11,
    time: Date.now() - 3200000,
    data: { message: { content: [{ type: 'text', text: '好的，我先读一下入口文件。' }] } },
  },
  { type: 'tool/call', seq: 12, time: Date.now() - 3100000, data: { name: 'read' } },
  { type: 'tool/call', seq: 13, time: Date.now() - 3000000, data: { name: 'read' } },
  { type: 'tool/call', seq: 14, time: Date.now() - 2900000, data: { name: 'edit' } },
  {
    type: 'todo/write',
    seq: 16,
    time: Date.now() - 2800000,
    data: {
      todos: [
        { content: '补上入口守卫', status: 'pending' },
        { content: '读入口文件', status: 'completed' },
      ],
    },
  },
  { type: 'turn/start', seq: 5, time: Date.now() - 3450000, data: { turn: 3 } },
];

test('decodeSession splits on zstd frame magic and recovers every record', () => {
  const file = makeSessionFile(RECORDS);
  const records = decodeSession(file, { maxFrames: 100, headFrames: 3 });

  assert.equal(records.length, RECORDS.length);
  assert.equal(records[0].type, 'session');
  assert.ok(records.some((r) => r.type === 'todo/write'));
});

test('analyzeConversation extracts title, messages, tools, todos and turns', () => {
  const file = makeSessionFile(RECORDS);
  const analysis = analyzeConversation(decodeSession(file));

  assert.equal(analysis.title, '演示项目');
  assert.equal(analysis.cwd, 'C:\\work\\demo');
  assert.equal(analysis.turns, 3);
  assert.equal(analysis.toolCalls, 3);
  assert.deepEqual(analysis.tools, { read: 2, edit: 1 });
  assert.equal(analysis.todos.length, 2);
  assert.equal(analysis.messages.length, 2, 'the injected reminder is filtered out');
  assert.equal(analysis.userMessages.length, 1);
  assert.match(analysis.userMessages[0].text, /看看这个插件的结构/);
});

test('threadOf renders the recent questions', () => {
  const analysis = analyzeConversation(decodeSession(makeSessionFile(RECORDS)));
  const thread = threadOf(analysis);
  assert.equal(thread.length, 1);
  assert.match(thread[0].summary, /插件的结构/);
});

test('suggestNext names an unfinished todo first', () => {
  const analysis = analyzeConversation(decodeSession(makeSessionFile(RECORDS)));
  const suggestions = suggestNext(analysis, { now: Date.now() });

  assert.equal(suggestions[0].move, 'executing-plans');
  assert.match(suggestions[0].title, /补上入口守卫/);
  assert.ok(suggestions.some((s) => s.kind === 'treelog'));
});

test('suggestNext asks for a plan when there are turns but no todos', () => {
  const analysis = {
    turns: 5,
    todos: [],
    toolCalls: 2,
    lastAt: Date.now(),
    userMessages: [],
  };
  const suggestions = suggestNext(analysis, { now: Date.now() });
  assert.ok(suggestions.some((s) => s.move === 'writing-plans'));
});

test('suggestNext flags a long idle gap', () => {
  const analysis = {
    turns: 3,
    todos: [],
    toolCalls: 1,
    lastAt: Date.now() - 6 * 86400000,
    userMessages: [],
  };
  const suggestions = suggestNext(analysis, { now: Date.now() });
  assert.ok(suggestions.some((s) => /停了 6 天/.test(s.title)));
});

test('formatPulse assembles the report', () => {
  const analysis = analyzeConversation(decodeSession(makeSessionFile(RECORDS)));
  const text = formatPulse(analysis, suggestNext(analysis, { now: Date.now() }), {
    thread: threadOf(analysis),
  });

  assert.match(text, /工作区脉络 · 演示项目/);
  assert.match(text, /3 轮/);
  assert.match(text, /在做什么/);
  assert.match(text, /还没做完/);
  assert.match(text, /［superpowers］/);
  assert.match(text, /［treelog］/);
});

test('pickSession matches a workspace by cwd', () => {
  const file = makeSessionFile(RECORDS);
  const workspaces = [
    { workspace: 'other', sessions: [{ id: 'x', file: '/nope', mtime: 2, size: 1 }], mtime: 2 },
    { workspace: 'demo', sessions: [{ id: 'session-test', file, mtime: 1, size: 1 }], mtime: 1 },
  ];
  const picked = pickSession(workspaces, { cwd: 'C:\\work\\demo' });
  assert.equal(picked.workspace, 'demo');
  assert.equal(picked.session.id, 'session-test');
});

test('pickSession falls back to the newest workspace', () => {
  const workspaces = [
    { workspace: 'newest', sessions: [{ id: 'a', file: '/nope', mtime: 9, size: 1 }], mtime: 9 },
    { workspace: 'older', sessions: [{ id: 'b', file: '/nope', mtime: 1, size: 1 }], mtime: 1 },
  ];
  const picked = pickSession(workspaces, { cwd: '/different' });
  assert.equal(picked.workspace, 'newest');
});

test('scoreQuestion rewards acceptance lines and punishes stacked goals', () => {
  const vague = scoreQuestion('这个再优化一下');
  const stacked = scoreQuestion('顺手把注册、找回密码、手机绑定也做一下吧，还有监控');
  const precise = scoreQuestion(
    'QPS 200 时丢 0.3%，想 5 秒内重试 3 次。不要动下游幂等，验收：压测 1000 次零丢失。',
  );

  assert.ok(precise > 70, `precise should score high, got ${precise}`);
  assert.ok(stacked < vague, 'stacked goals should score below a merely vague ask');
  assert.ok(vague < 50);
});

test('stageOf maps questions to work stages', () => {
  assert.equal(stageOf('报错了，走不通'), 'debug');
  assert.equal(stageOf('跑一下测试验证'), 'verify');
  assert.equal(stageOf('出个计划拆成任务'), 'plan');
  assert.equal(stageOf('帮我实现这个函数'), 'build');
  assert.equal(stageOf('审查一下这段代码'), 'review');
  assert.equal(stageOf('我想做个新东西'), 'design');
});

test('reviewQuestion names what is missing and offers a rewrite', () => {
  const review = reviewQuestion('这个再优化一下');
  assert.ok(review.cons.some((item) => item.includes('验收标准')));
  assert.ok(review.cons.some((item) => item.includes('信息量')));
  assert.match(review.rewrite, /验收：/);
  assert.match(review.rewrite, /约束：/);
});

test('formatRetro writes a pasteable Markdown retro', () => {
  const analysis = analyzeConversation(decodeSession(makeSessionFile(RECORDS)));
  const text = formatRetro(analysis, { now: Date.UTC(2026, 9, 24, 12) });

  assert.match(text, /^# 复盘 · 演示项目/);
  assert.match(text, /## 做了什么/);
  assert.match(text, /## 完成情况/);
  assert.match(text, /- \[x\] 读入口文件/);
  assert.match(text, /- \[ \] 补上入口守卫/);
  assert.match(text, /## 提问质量/);
  assert.match(text, /\| 1 \| \d+ \|/);
  assert.match(text, /## 下次注意/);
  assert.match(text, /生成于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});
