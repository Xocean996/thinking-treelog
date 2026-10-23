/**
 * Command implementations shared by the `treelog` binary and the test suite.
 *
 * The filesystem reader is injectable so these functions can be tested without
 * spawning a child process (the sandbox forbids piped stdio spawns).
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, basename } from 'node:path';

import {
  analyzeTree,
  buildGraph,
  extractWithRules,
  normalizeNodes,
  toMarkdown,
  toMermaid,
} from '@thinking-treelog/core';
import {
  diffTrees,
  lintTree,
  parseMarkdown,
  summarizeFindings,
  toAdr,
  toSarif,
} from '@thinking-treelog/core/engineering';

export const EXIT_CODES = { ok: 0, findings: 1, usage: 2 };

const readFile = (path) => fsReadFile(path, 'utf8');

/**
 * Load a thought tree from a file, choosing the parser by extension.
 * `-` reads stdin as plain text.
 *
 * @param {string} path
 * @param {{ readFile?: (p: string) => Promise<string>, stdin?: () => Promise<string> }} [io]
 * @returns {Promise<{title: string, nodes: import('@thinking-treelog/core').ThoughtNode[], source: 'json'|'markdown'|'text'}>}
 */
export async function loadTree(path, io = {}) {
  const read = io.readFile ?? readFile;
  const isStdin = path === '-';
  const raw = isStdin ? await (io.stdin ?? readStdin)() : await read(path);
  const ext = isStdin ? '.txt' : extname(path).toLowerCase();
  const title = isStdin ? 'stdin' : basename(path).replace(/\.[^.]+$/, '');

  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    const nodes = normalizeNodes(Array.isArray(parsed) ? parsed : parsed.nodes);
    return { title: parsed.title ?? title, nodes, source: 'json' };
  }

  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    const nodes = parseMarkdown(raw);
    return { title, nodes, source: 'markdown' };
  }

  const nodes = normalizeNodes(extractWithRules(raw));
  return { title, nodes, source: 'text' };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

export function renderAsciiTree(nodes) {
  const graph = buildGraph(nodes);
  const lines = [];

  const walk = (id, prefix, isLast, isRoot) => {
    const node = graph.nodeMap.get(id);
    if (!node) return;
    const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
    const status = node.status && node.status !== 'proposed' ? ` [${node.status}]` : '';
    lines.push(`${prefix}${connector}${node.label} (${node.type}${status})`);
    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '    ' : '│   '}`;
    const kids = graph.childrenOf.get(id) ?? [];
    kids.forEach((kid, index) => walk(kid, childPrefix, index === kids.length - 1, false));
  };

  graph.roots.forEach((rootId, index) => {
    walk(rootId, '', index === graph.roots.length - 1, true);
  });

  return lines.join('\n');
}

const SEVERITY_ICON = { error: '✖', warning: '⚠', info: 'ℹ' };

function colorize(text, severity, useColor) {
  if (!useColor) return text;
  const codes = { error: '\u001b[31m', warning: '\u001b[33m', info: '\u001b[36m' };
  return `${codes[severity] ?? ''}${text}\u001b[0m`;
}

export function formatFindings(findings, format, context = {}) {
  if (format === 'json') {
    return JSON.stringify({ summary: summarizeFindings(findings), findings }, null, 2);
  }

  if (format === 'sarif') {
    return JSON.stringify(
      toSarif(findings, {
        file: context.file,
        toolName: 'treelog',
        toolVersion: context.version,
      }),
      null,
      2,
    );
  }

  const useColor = context.color === true;
  const lines = [];
  if (context.file) lines.push(context.file);

  for (const finding of findings) {
    const where = finding.nodeLabel ? ` 「${finding.nodeLabel}」` : '';
    lines.push(
      `  ${colorize(`${SEVERITY_ICON[finding.severity]} ${finding.rule}`, finding.severity, useColor)}${where} — ${finding.message}`,
    );
    if (finding.hint) lines.push(`      ↳ ${finding.hint}`);
  }

  const summary = summarizeFindings(findings);
  if (findings.length === 0) {
    lines.push('  ✔ 没有发现问题');
  } else {
    lines.push(
      `  ${findings.length} 个问题（${summary.error} error, ${summary.warning} warning, ${summary.info} info）`,
    );
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * @param {string[]} paths
 * @param {{ format?: string, maxDepth?: number, minConclusionConfidence?: number, readFile?: Function, color?: boolean, version?: string }} options
 */
export async function lintPaths(paths, options = {}) {
  const format = options.format ?? 'text';
  const outputs = [];
  const all = [];

  for (const path of paths) {
    if (path !== '-' && !existsSync(path) && !options.readFile) {
      throw new Error(`文件不存在：${path}`);
    }
    const tree = await loadTree(path, { readFile: options.readFile });
    const findings = lintTree(tree, {
      maxDepth: options.maxDepth,
      minConclusionConfidence: options.minConclusionConfidence,
    });
    for (const finding of findings) finding.file = path;
    all.push(...findings);

    if (format !== 'sarif') {
      outputs.push(
        formatFindings(findings, format, {
          file: tree.title,
          color: options.color,
          version: options.version,
        }),
      );
    }
  }

  if (format === 'sarif') {
    const merged = { ...toSarif(all, { toolName: 'treelog', toolVersion: options.version }) };
    outputs.push(JSON.stringify(merged, null, 2));
  }

  const summary = summarizeFindings(all);
  return {
    text: outputs.join('\n\n'),
    findings: all,
    summary,
    exitCode: summary.error > 0 ? EXIT_CODES.findings : EXIT_CODES.ok,
  };
}

/**
 * @param {string} path
 * @param {{ format?: string, readFile?: Function, adr?: {id?: string, status?: string, deciders?: string[]} }} options
 */
export async function exportTree(path, options = {}) {
  const tree = await loadTree(path, { readFile: options.readFile });
  const format = options.format ?? 'md';

  switch (format) {
    case 'md':
      return toMarkdown({ ...tree, extractor: tree.source === 'markdown' ? 'rule' : 'rule' });
    case 'mermaid':
      return toMermaid({ ...tree });
    case 'adr':
      return toAdr({ ...tree, extractor: 'rule' }, options.adr);
    case 'json':
      return JSON.stringify({ title: tree.title, extractor: 'rule', nodes: tree.nodes }, null, 2);
    case 'stats':
      return JSON.stringify(analyzeTree({ ...tree }), null, 2);
    default:
      throw new Error(`未知导出格式：${format}（可选 md | mermaid | adr | json | stats）`);
  }
}

/**
 * @param {string} beforePath
 * @param {string} afterPath
 * @param {{ format?: string, readFile?: Function }} options
 */
export async function diffPaths(beforePath, afterPath, options = {}) {
  const before = await loadTree(beforePath, { readFile: options.readFile });
  const after = await loadTree(afterPath, { readFile: options.readFile });
  const diff = diffTrees(before.nodes, after.nodes);

  if (options.format === 'json') {
    return { text: JSON.stringify(diff, null, 2), diff };
  }

  const lines = [
    `${before.title} → ${after.title}`,
    `  节点：${diff.summary.before} → ${diff.summary.after}`,
    '',
  ];

  if (diff.added.length) {
    lines.push('新增：');
    for (const node of diff.added) lines.push(`  + ${node.label} (${node.type})`);
  }
  if (diff.removed.length) {
    lines.push('移除：');
    for (const node of diff.removed) lines.push(`  - ${node.label} (${node.type})`);
  }
  if (diff.modified.length) {
    lines.push('修改：');
    for (const change of diff.modified) lines.push(`  ~ ${change.label}`);
  }
  if (diff.moved.length) {
    lines.push('移动：');
    for (const move of diff.moved) lines.push(`  → ${move.label}（${move.from ?? 'root'} → ${move.to ?? 'root'}）`);
  }
  if (!diff.added.length && !diff.removed.length && !diff.modified.length && !diff.moved.length) {
    lines.push('  两版决策结构一致');
  }

  return { text: lines.join('\n'), diff };
}
