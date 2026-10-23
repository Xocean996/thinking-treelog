import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph, normalizeNodes } from '../packages/core/src/index.js';
import {
  diffTrees,
  fingerprint,
  lintTree,
  parseMarkdown,
  summarizeFindings,
  toAdr,
  toSarif,
} from '../packages/core/src/engineering.js';
import {
  DEFAULT_CONFIG,
  baselineDocument,
  diffPaths,
  exportTree,
  isIgnored,
  lintPaths,
  loadBaseline,
  loadConfig,
  loadTree,
  parseSuppressions,
  renderAsciiTree,
  toGithubAnnotations,
  toJunit,
} from '../packages/cli/lib/commands.mjs';

const ADR = `# ADR-0007 采用插件形态

## Context

- 用户不会为了复盘专门打开一个新网站
- dsh 已经在用户的工作流里

> 数据显示 80% 的会话没有第二次打开

## Decision

我们决定：第一版先做 dsh 插件。

## Consequences

- 需要维护一个 Cordis bundle
- 传播面比独立网站窄

## 被否决的方案

决定：先做独立网站。
`;

function memoIO(files) {
  return {
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

test('parseMarkdown turns an ADR into a typed tree', () => {
  const nodes = parseMarkdown(ADR);
  assert.ok(nodes.length >= 6);

  const roots = nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1);
  assert.match(roots[0].text, /ADR-0007/);

  const conclusions = nodes.filter((n) => n.type === 'conclusion');
  assert.ok(conclusions.length >= 1, 'Decision: line should become a conclusion');
  assert.ok(nodes.some((n) => n.text.includes('独立网站')));

  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    if (node.parentId !== null) assert.ok(ids.has(node.parentId));
  }
});

test('parseMarkdown ignores fenced code blocks', () => {
  const nodes = parseMarkdown('# T\n\n```js\nconst x = 1;\n```\n\n- 真实条目\n');
  assert.ok(nodes.every((n) => !n.text.includes('const x')));
  assert.ok(nodes.some((n) => n.text.includes('真实条目')));
});

test('lint catches a conclusion with no evidence', () => {
  const nodes = normalizeNodes([
    { id: 'a', parentId: null, text: '采用微服务架构', type: 'conclusion', confidence: 0.9 },
  ]);
  const findings = lintTree(nodes, { rules: { 'single-child-chain': false } });
  assert.ok(findings.some((f) => f.rule === 'conclusion-without-evidence'));
  assert.equal(findings.find((f) => f.rule === 'conclusion-without-evidence').severity, 'error');
});

test('lint stays quiet when the evidence is present', () => {
  const nodes = normalizeNodes([
    { id: 'a', parentId: null, text: '采用微服务架构', type: 'conclusion', confidence: 0.9 },
    { id: 'b', parentId: 'a', text: '团队有拆分经验', type: 'evidence', confidence: 0.8 },
  ]);
  const findings = lintTree(nodes, { rules: { 'single-child-chain': false } });
  assert.equal(findings.filter((f) => f.rule === 'conclusion-without-evidence').length, 0);
});

test('lint flags unverified assumptions and rejected nodes with children', () => {
  const nodes = normalizeNodes([
    { id: 'a', parentId: null, text: '采用方案 A', type: 'claim' },
    { id: 'b', parentId: 'a', text: '假设流量翻倍', type: 'assumption' },
    { id: 'c', parentId: 'a', text: '旧方案 B', type: 'claim', status: 'rejected' },
    { id: 'd', parentId: 'c', text: '旧方案 B 的一个细节', type: 'claim' },
  ]);
  const findings = lintTree(nodes, { rules: { 'single-child-chain': false } });
  assert.ok(findings.some((f) => f.rule === 'assumption-unverified'));
  assert.ok(findings.some((f) => f.rule === 'rejected-with-descendants'));
});

test('lint respects maxDepth and rule switches', () => {
  const nodes = normalizeNodes([
    { id: 'a', parentId: null, text: 'root', type: 'claim' },
    { id: 'b', parentId: 'a', text: 'child', type: 'claim' },
    { id: 'c', parentId: 'b', text: 'grandchild', type: 'claim' },
  ]);
  const shallow = lintTree(nodes, { maxDepth: 0 });
  assert.ok(shallow.some((f) => f.rule === 'depth-exceeds'));

  const muted = lintTree(nodes, { maxDepth: 0, rules: { 'depth-exceeds': false } });
  assert.equal(muted.filter((f) => f.rule === 'depth-exceeds').length, 0);
});

test('toSarif produces a valid SARIF 2.1.0 document', () => {
  const findings = [
    { rule: 'conclusion-without-evidence', severity: 'error', message: '缺少论据', nodeId: 'a', nodeLabel: '结论' },
  ];
  const sarif = toSarif(findings, { file: 'docs/adr.md', toolVersion: '1.2.3' });

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].tool.driver.name, 'thinking-treelog');
  assert.equal(sarif.runs[0].tool.driver.version, '1.2.3');
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].ruleId, 'conclusion-without-evidence');
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'docs/adr.md');
});

test('toAdr renders the three required sections', () => {
  const nodes = parseMarkdown(ADR);
  const adr = toAdr({ title: '采用插件形态', nodes, extractor: 'rule' }, { id: '0007' });
  assert.match(adr, /^# 0007\. 采用插件形态/m);
  assert.match(adr, /## Context/);
  assert.match(adr, /## Decision/);
  assert.match(adr, /## Consequences/);
  assert.match(adr, /Status:/);
});

test('diffTrees reports additions, removals and moves', () => {
  const before = normalizeNodes([
    { id: 'a', parentId: null, text: '旧结论', type: 'conclusion' },
    { id: 'b', parentId: 'a', text: '旧论据', type: 'evidence' },
  ]);
  const after = normalizeNodes([
    { id: 'a', parentId: null, text: '新结论', type: 'conclusion' },
    { id: 'b', parentId: null, text: '旧论据', type: 'evidence' },
    { id: 'c', parentId: 'a', text: '新增论据', type: 'evidence' },
  ]);

  const diff = diffTrees(before, after);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.moved, 1);
  assert.ok(diff.modified.some((m) => m.id === 'a'));
});

test('loadTree picks the parser by extension', async () => {
  const io = memoIO({ 'a.md': ADR, 'a.json': JSON.stringify({ title: 'J', nodes: [{ id: 'x', text: 'hi' }] }), 'a.txt': '因为这样。因此那样。' });

  const md = await loadTree('a.md', io);
  assert.equal(md.source, 'markdown');
  assert.ok(md.nodes.length > 3);

  const json = await loadTree('a.json', io);
  assert.equal(json.source, 'json');
  assert.equal(json.title, 'J');

  const txt = await loadTree('a.txt', io);
  assert.equal(txt.source, 'text');
});

test('lintPaths aggregates findings and sets the exit code', async () => {
  const io = memoIO({ 'bad.md': '# T\n\n决定：直接上线。\n' });
  const result = await lintPaths(['bad.md'], { readFile: io.readFile });

  assert.ok(result.findings.length > 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /conclusion-without-evidence/);
});

test('lintPaths supports json and sarif output', async () => {
  const io = memoIO({ 'bad.md': '# T\n\n决定：直接上线。\n' });

  const json = await lintPaths(['bad.md'], { readFile: io.readFile, format: 'json' });
  const parsed = JSON.parse(json.text);
  assert.ok(Array.isArray(parsed.findings));

  const sarif = await lintPaths(['bad.md'], { readFile: io.readFile, format: 'sarif' });
  const doc = JSON.parse(sarif.text);
  assert.equal(doc.version, '2.1.0');
  assert.ok(doc.runs[0].results.length > 0);
});

test('exportTree renders every supported format', async () => {
  const io = memoIO({ 'a.md': ADR });

  assert.match(await exportTree('a.md', { readFile: io.readFile, format: 'md' }), /^# /m);
  assert.match(await exportTree('a.md', { readFile: io.readFile, format: 'mermaid' }), /^flowchart LR/m);
  assert.match(await exportTree('a.md', { readFile: io.readFile, format: 'adr' }), /## Decision/);

  const stats = JSON.parse(await exportTree('a.md', { readFile: io.readFile, format: 'stats' }));
  assert.ok(stats.nodeCount > 0);

  await assert.rejects(() => exportTree('a.md', { readFile: io.readFile, format: 'nope' }), /unknown export format/i);
});

test('diffPaths renders a readable summary', async () => {
  const io = memoIO({ 'v1.md': '# T\n\n决定：做插件。\n', 'v2.md': '# T\n\n决定：做插件。\n\n- 新增一条约束\n' });
  const result = await diffPaths('v1.md', 'v2.md', { readFile: io.readFile });
  assert.ok(result.diff.summary.after >= result.diff.summary.before);
  assert.ok(result.text.length > 0);
});

test('renderAsciiTree draws a tree with connectors', () => {
  const nodes = normalizeNodes([
    { id: 'a', parentId: null, text: 'root', type: 'claim' },
    { id: 'b', parentId: 'a', text: 'child one', type: 'evidence' },
    { id: 'c', parentId: 'a', text: 'child two', type: 'action' },
  ]);
  const text = renderAsciiTree(nodes);
  assert.match(text, /root/);
  assert.match(text, /├──|└──/);
  assert.equal(buildGraph(nodes).roots.length, 1);
});

test('summarizeFindings counts by severity', () => {
  const summary = summarizeFindings([
    { severity: 'error' },
    { severity: 'warning' },
    { severity: 'warning' },
    { severity: 'info' },
  ]);
  assert.deepEqual(summary, { error: 1, warning: 2, info: 1 });
});

/* ------------------------------------------------------------------ *
 * Enterprise plumbing: config, ignore, suppression, baseline, formats
 * ------------------------------------------------------------------ */

test('parseMarkdown records 1-based source lines', () => {
  const nodes = parseMarkdown('# Title\n\n- first\n- second\n');
  const first = nodes.find((n) => n.text === 'first');
  const second = nodes.find((n) => n.text === 'second');
  assert.equal(first.line, 3);
  assert.equal(second.line, 4);
});

test('SARIF points at the node line, not line 1', () => {
  const findings = lintTree(parseMarkdown('# T\n\n决定：直接上线。\n'));
  const sarif = toSarif(findings, { file: 'docs/a.md' });
  const line = sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine;
  assert.equal(line, 3);
});

test('loadConfig expands presets and lets explicit rules win', async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    configPath: 'treelog.config.json',
    exists: () => true,
    readFile: async () =>
      JSON.stringify({
        preset: 'strict',
        rules: { 'depth-exceeds': 'info', 'claim-unsupported': false },
        ignore: ['docs/archive/**'],
        locale: 'zh',
      }),
  });

  assert.equal(config.preset, 'strict');
  assert.equal(config.locale, 'zh');
  assert.equal(config.rules['unresolved-question'], true, 'preset should enable it');
  assert.equal(config.rules['depth-exceeds'], 'info', 'explicit rule should win');
  assert.equal(config.rules['claim-unsupported'], false);
  assert.deepEqual(config.ignore, ['docs/archive/**']);
});

test('loadConfig falls back to defaults when no file exists', async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    configPath: null,
    exists: () => false,
    readFile: async () => '{}',
  });
  assert.equal(config.preset, DEFAULT_CONFIG.preset);
  assert.equal(config.maxDepth, DEFAULT_CONFIG.maxDepth);
});

test('loadConfig rejects malformed JSON with a useful message', async () => {
  await assert.rejects(
    () =>
      loadConfig({
        cwd: process.cwd(),
        configPath: 'bad.json',
        exists: () => true,
        readFile: async () => '{ not json',
      }),
    /not valid JSON|不是合法 JSON/i,
  );
});

test('ignore patterns match nested paths', () => {
  assert.equal(isIgnored('docs/archive/old.md', ['docs/archive/**']), true);
  assert.equal(isIgnored('docs/archive/deep/old.md', ['docs/archive/**']), true);
  assert.equal(isIgnored('docs/live/current.md', ['docs/archive/**']), false);
  assert.equal(isIgnored('a/b/c.md', ['**/c.md']), true);
});

test('suppression comments work at file and rule scope', () => {
  assert.deepEqual(parseSuppressions('<!-- treelog-ignore -->'), { all: true, rules: new Set() });

  const scoped = parseSuppressions('<!-- treelog-ignore a-rule, b-rule -->');
  assert.equal(scoped.all, false);
  assert.deepEqual([...scoped.rules], ['a-rule', 'b-rule']);

  assert.deepEqual(parseSuppressions('no comment here'), { all: false, rules: new Set() });
});

test('lintPaths honours rule-scoped suppressions', async () => {
  const io = {
    readFile: async () =>
      '<!-- treelog-ignore conclusion-without-evidence -->\n# T\n\n决定：直接上线。\n',
  };
  const result = await lintPaths(['s.md'], { readFile: io.readFile });
  assert.equal(result.findings.length, 0);
  assert.equal(result.exitCode, 0);
});

test('lintPaths honours ignore patterns', async () => {
  const io = { readFile: async () => '# T\n\n决定：直接上线。\n' };
  const result = await lintPaths(['docs/archive/old.md'], {
    readFile: io.readFile,
    config: { ignore: ['docs/archive/**'] },
  });
  assert.equal(result.findings.length, 0);
});

test('baseline round-trip suppresses known findings and unblocks the build', async () => {
  const io = { readFile: async () => '# T\n\n决定：直接上线。\n' };

  const first = await lintPaths(['bad.md'], { readFile: io.readFile });
  assert.ok(first.findings.length > 0);
  assert.equal(first.exitCode, 1);

  const doc = baselineDocument(first.allFindings);
  const parsed = JSON.parse(doc);
  assert.ok(parsed.fingerprints.includes(fingerprint(first.allFindings[0])));

  const baseline = await loadBaseline('baseline.json', { readFile: async () => doc });
  const second = await lintPaths(['bad.md'], { readFile: io.readFile, baseline });

  assert.equal(second.findings.length, 0);
  assert.equal(second.suppressed, first.findings.length);
  assert.equal(second.exitCode, 0);
});

test('loadBaseline tolerates a missing file', async () => {
  const baseline = await loadBaseline('nope.json', {
    readFile: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(baseline.size, 0);
});

test('JUnit output is well-formed enough for CI parsers', () => {
  const xml = toJunit([
    { rule: 'r', severity: 'error', message: 'boom <&>', nodeLabel: 'L', file: 'a.md', line: 3 },
  ]);
  assert.match(xml, /^<\?xml version="1.0"/);
  assert.match(xml, /<testsuite name="treelog" tests="1" failures="1">/);
  assert.match(xml, /boom &lt;&amp;&gt;/);
});

test('GitHub annotations use the workflow command format', () => {
  const text = toGithubAnnotations([
    { rule: 'conclusion-without-evidence', severity: 'error', message: 'no evidence', file: 'a.md', line: 7 },
  ]);
  assert.equal(text, '::error file=a.md,line=7,title=conclusion-without-evidence::no evidence');
});

test('localised lint messages switch with locale', () => {
  const nodes = parseMarkdown('# T\n\n决定：直接上线。\n');
  const en = lintTree(nodes, { locale: 'en' })[0].message;
  const zh = lintTree(nodes, { locale: 'zh' })[0].message;
  assert.match(en, /has no supporting evidence/);
  assert.match(zh, /没有任何论据节点/);
});
