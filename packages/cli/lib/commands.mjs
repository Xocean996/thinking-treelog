/**
 * Command implementations shared by the `treelog` binary and the test suite.
 *
 * The filesystem reader is injectable so these functions can be tested without
 * spawning a child process (the sandbox forbids piped stdio spawns).
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, basename, dirname, join, resolve } from 'node:path';

import {
  analyzeTree,
  buildGraph,
  extractWithRules,
  normalizeNodes,
  toMarkdown,
  toMermaid,
} from '@thinking-treelog/core';
import {
  PRESETS,
  diffTrees,
  fingerprint,
  lintTree,
  parseMarkdown,
  summarizeFindings,
  toAdr,
  toSarif,
} from '@thinking-treelog/core/engineering';
import { lintPlan, parsePlan, planToTree } from '@thinking-treelog/core/plan';
import { analyzeRhythm, formatRhythm, rhythmToTree } from '@thinking-treelog/core/rhythm';
import { formatTrace, traceCoverage } from '@thinking-treelog/core/trace';

export const EXIT_CODES = { ok: 0, findings: 1, usage: 2 };

const defaultReadFile = (path) => fsReadFile(path, 'utf8');

/** Effective defaults when no config file is present. */
export const DEFAULT_CONFIG = {
  locale: 'en',
  preset: 'recommended',
  rules: {},
  maxDepth: 8,
  minConclusionConfidence: 0.5,
  ignore: [],
  baseline: null,
  failOn: 'error',
};

const CONFIG_FILENAMES = ['treelog.config.json', '.treelogrc.json'];

/* ------------------------------------------------------------------ *
 * Config discovery
 * ------------------------------------------------------------------ */

/**
 * Walk up from `cwd` looking for a config file, then merge it over the defaults.
 * Presets expand first; explicit `rules` win over both.
 *
 * @param {{ cwd?: string, configPath?: string, readFile?: Function, exists?: Function }} [options]
 */
export async function loadConfig(options = {}) {
  const read = options.readFile ?? defaultReadFile;
  const exists = options.exists ?? existsSync;
  const start = resolve(options.cwd ?? process.cwd());

  let configPath = options.configPath ?? null;
  if (!configPath) {
    let dir = start;
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = CONFIG_FILENAMES.map((name) => join(dir, name)).find((p) => exists(p));
      if (candidate) {
        configPath = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  let fileConfig = {};
  if (configPath && exists(configPath)) {
    try {
      fileConfig = JSON.parse(await read(configPath));
    } catch (error) {
      throw new Error(`配置文件不是合法 JSON：${configPath}（${error.message}）`);
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...fileConfig };
  merged.rules = {
    ...(PRESETS[merged.preset] ?? {}),
    ...(fileConfig.rules ?? {}),
  };
  merged.configPath = configPath;
  merged.dir = configPath ? dirname(configPath) : start;
  return merged;
}

/* ------------------------------------------------------------------ *
 * Ignore patterns and inline suppressions
 * ------------------------------------------------------------------ */

export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function isIgnored(file, patterns = []) {
  const normalized = String(file).replace(/\\/g, '/');
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern);
    return re.test(normalized) || re.test(`/${normalized}`);
  });
}

const SUPPRESS_RE = /<!--\s*treelog-ignore((?:\s+[\w-]+(?:,\s*[\w-]+)*)?)\s*-->/gi;

/**
 * Read file-level suppressions:
 *   <!-- treelog-ignore -->                      silence everything in this file
 *   <!-- treelog-ignore rule-a, rule-b -->       silence named rules
 *
 * @param {string} source
 * @returns {{ all: boolean, rules: Set<string> }}
 */
export function parseSuppressions(source) {
  const rules = new Set();
  let all = false;
  for (const match of String(source).matchAll(SUPPRESS_RE)) {
    const list = (match[1] ?? '').trim();
    if (!list) all = true;
    else list.split(',').map((r) => r.trim()).filter(Boolean).forEach((r) => rules.add(r));
  }
  return { all, rules };
}

/* ------------------------------------------------------------------ *
 * Loading trees
 * ------------------------------------------------------------------ */

/**
 * Load a thought tree from a file, choosing the parser by extension.
 * `-` reads stdin as plain text.
 *
 * @param {string} path
 * @param {{ readFile?: Function, stdin?: () => Promise<string> }} [io]
 * @returns {Promise<{title: string, nodes: import('@thinking-treelog/core').ThoughtNode[], source: 'json'|'markdown'|'text', raw: string}>}
 */
export async function loadTree(path, io = {}) {
  const read = io.readFile ?? defaultReadFile;
  const isStdin = path === '-';
  const raw = isStdin ? await (io.stdin ?? readStdin)() : await read(path);
  const ext = isStdin ? '.txt' : extname(path).toLowerCase();
  const title = isStdin ? 'stdin' : basename(path).replace(/\.[^.]+$/, '');

  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    const nodes = normalizeNodes(Array.isArray(parsed) ? parsed : parsed.nodes);
    return { title: parsed.title ?? title, nodes, source: 'json', raw };
  }

  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    const nodes = parseMarkdown(raw);
    return { title, nodes, source: 'markdown', raw };
  }

  const nodes = normalizeNodes(extractWithRules(raw));
  return { title, nodes, source: 'text', raw };
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolvePromise(data));
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
    const where = Number.isFinite(node.line) ? ` :${node.line}` : '';
    lines.push(`${prefix}${connector}${node.label} (${node.type}${status})${where}`);
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

function xmlEscape(value) {
  return String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
}

export function toJunit(findings, context = {}) {
  const suite = context.suite ?? 'treelog';
  const failures = findings.filter((f) => f.severity === 'error').length;
  const cases = findings.length
    ? findings
        .map((finding) => {
          const where = finding.file ?? '';
          const name = `${finding.rule} — ${finding.nodeLabel || 'document'}`;
          return [
            `    <testcase classname="${xmlEscape(where)}" name="${xmlEscape(name)}">`,
            `      <failure type="${xmlEscape(finding.severity)}" message="${xmlEscape(finding.message)}">${xmlEscape(
              `${finding.message}${finding.hint ? `\n${finding.hint}` : ''}`,
            )}</failure>`,
            '    </testcase>',
          ].join('\n');
        })
        .join('\n')
    : '    <testcase classname="treelog" name="no findings"/>';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(suite)}" tests="${Math.max(1, findings.length)}" failures="${failures}">`,
    cases,
    '</testsuite>',
  ].join('\n');
}

export function toGithubAnnotations(findings) {
  return findings
    .map((finding) => {
      const level = finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'notice';
      const line = Number.isFinite(finding.line) && finding.line > 0 ? finding.line : 1;
      const file = finding.file ?? '';
      const message = String(finding.message).replace(/\r?\n/g, ' ');
      return `::${level} file=${file},line=${line},title=${finding.rule}::${message}`;
    })
    .join('\n');
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

  if (format === 'github') return toGithubAnnotations(findings);
  if (format === 'junit') return toJunit(findings, { suite: context.suite ?? 'treelog' });

  const useColor = context.color === true;
  const lines = [];
  if (context.file) lines.push(context.file);

  for (const finding of findings) {
    const where = finding.nodeLabel ? ` 「${finding.nodeLabel}」` : '';
    const at = Number.isFinite(finding.line) ? `:${finding.line}` : '';
    lines.push(
      `  ${colorize(`${SEVERITY_ICON[finding.severity]} ${finding.rule}`, finding.severity, useColor)}${at}${where} — ${finding.message}`,
    );
    if (finding.hint) lines.push(`      ↳ ${finding.hint}`);
  }

  const summary = summarizeFindings(findings);
  if (findings.length === 0) {
    lines.push('  ✔ no findings');
  } else {
    lines.push(
      `  ${findings.length} problem(s) — ${summary.error} error, ${summary.warning} warning, ${summary.info} info`,
    );
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Baseline
 * ------------------------------------------------------------------ */

/**
 * @param {string} path
 * @param {{ readFile?: Function }} [io]
 * @returns {Promise<Set<string>>}
 */
export async function loadBaseline(path, io = {}) {
  const read = io.readFile ?? defaultReadFile;
  try {
    const parsed = JSON.parse(await read(path));
    return new Set(Array.isArray(parsed.fingerprints) ? parsed.fingerprints : []);
  } catch {
    return new Set();
  }
}

export function baselineDocument(findings) {
  return JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      note: 'Accepted findings. Delete entries to make them fail the build again.',
      fingerprints: [...new Set(findings.map((f) => fingerprint(f)))].sort(),
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * @param {string[]} paths
 * @param {{
 *   format?: string, color?: boolean, version?: string,
 *   config?: object, locale?: string, maxDepth?: number,
 *   minConclusionConfidence?: number, readFile?: Function, exists?: Function,
 *   baseline?: Set<string>, suppressions?: boolean,
 * }} options
 */
export async function lintPaths(paths, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const locale = options.locale ?? config.locale ?? 'en';
  const maxDepth = options.maxDepth ?? config.maxDepth;
  const minConfidence = options.minConclusionConfidence ?? config.minConclusionConfidence;
  const format = options.format ?? 'text';
  const useSuppressions = options.suppressions !== false;

  const perFile = [];
  const all = [];

  for (const path of paths) {
    if (path !== '-' && isIgnored(path, config.ignore)) continue;
    if (path !== '-' && !existsSync(path) && !options.readFile) {
      throw new Error(`file not found: ${path}`);
    }

    const tree = await loadTree(path, { readFile: options.readFile });
    const suppressions = useSuppressions ? parseSuppressions(tree.raw ?? '') : { all: false, rules: new Set() };

    let findings = lintTree(tree, {
      locale,
      maxDepth,
      minConclusionConfidence: minConfidence,
      rules: config.rules,
    });

    if (suppressions.all) findings = [];
    else if (suppressions.rules.size) {
      findings = findings.filter((f) => !suppressions.rules.has(f.rule));
    }

    // Normalise separators so reports are identical on Windows and CI.
    for (const finding of findings) finding.file = path.replace(/\\/g, '/');
    perFile.push({ path, title: tree.title, findings });
    all.push(...findings);
  }

  const accepted = options.baseline ?? new Set();
  const fresh = all.filter((finding) => !accepted.has(fingerprint(finding)));
  const suppressed = all.length - fresh.length;

  let text;
  if (format === 'sarif' || format === 'github' || format === 'junit') {
    text = formatFindings(fresh, format, { suite: 'treelog', version: options.version });
  } else if (format === 'json') {
    text = formatFindings(fresh, 'json', {});
  } else {
    text = perFile
      .map((entry) =>
        formatFindings(
          entry.findings.filter((f) => !accepted.has(fingerprint(f))),
          'text',
          { file: entry.title, color: options.color },
        ),
      )
      .join('\n\n');
    if (suppressed > 0) text += `\n\n  ${suppressed} finding(s) accepted by baseline`;
  }

  const summary = summarizeFindings(fresh);
  return {
    text,
    findings: fresh,
    allFindings: all,
    summary,
    suppressed,
    exitCode: summary.error > 0 ? EXIT_CODES.findings : EXIT_CODES.ok,
  };
}

/**
 * Lint a structured implementation plan (superpowers `writing-plans` format).
 *
 * @param {string} path
 * @param {{ readFile?: Function, format?: string, locale?: string, rules?: object, color?: boolean, version?: string }} [options]
 */
export async function lintPlanFile(path, options = {}) {
  const read = options.readFile ?? defaultReadFile;
  const raw = await read(path);
  const plan = parsePlan(raw);
  const findings = lintPlan(plan, { locale: options.locale, rules: options.rules });

  const file = path.replace(/\\/g, '/');
  for (const finding of findings) finding.file = file;

  const summary = summarizeFindings(findings);
  return {
    plan,
    findings,
    summary,
    text: formatFindings(findings, options.format ?? 'text', {
      file: plan.title || file,
      color: options.color,
      suite: 'treelog-plan',
      version: options.version,
    }),
    exitCode: summary.error > 0 ? EXIT_CODES.findings : EXIT_CODES.ok,
  };
}

/**
 * Render a plan as an ASCII tree.
 * @param {string} path
 * @param {{ readFile?: Function }} [options]
 */
export async function planTreeText(path, options = {}) {
  const read = options.readFile ?? defaultReadFile;
  const plan = parsePlan(await read(path));
  return { plan, text: renderAsciiTree(planToTree(plan)) };
}

/**
 * Trace spec decisions against plan tasks.
 *
 * @param {string} specPath
 * @param {string} planPath
 * @param {{ readFile?: Function, threshold?: number, format?: string, locale?: string }} [options]
 */
export async function tracePaths(specPath, planPath, options = {}) {
  const read = options.readFile ?? defaultReadFile;
  const specRaw = await read(specPath);
  const planRaw = await read(planPath);

  const specNodes = parseMarkdown(specRaw);
  const plan = parsePlan(planRaw);
  const result = traceCoverage(specNodes, plan.tasks, { threshold: options.threshold });

  const proportion = {
    specLines: specRaw.split('\n').length,
    planLines: planRaw.split('\n').length,
  };

  const text =
    options.format === 'json'
      ? JSON.stringify(
          {
            spec: basename(specPath),
            plan: basename(planPath),
            threshold: result.threshold,
            summary: {
              decisions: result.decisionCount,
              matched: result.matched.length,
              unmatched: result.unmatched.length,
              unreferencedTasks: result.unreferencedTasks.length,
            },
            proportion: {
              ...proportion,
              ratio: Number((proportion.planLines / Math.max(1, proportion.specLines)).toFixed(2)),
            },
            entries: result.entries.map((entry) => ({
              label: entry.node.label,
              type: entry.node.type,
              taskId: entry.taskId,
              taskTitle: entry.taskTitle,
              score: entry.score,
              matched: entry.matched,
            })),
            unreferencedTasks: result.unreferencedTasks,
          },
          null,
          2,
        )
      : formatTrace(result, {
          specTitle: basename(specPath),
          planTitle: basename(planPath),
          locale: options.locale,
          proportion,
        });

  return { result, text, exitCode: result.unmatched.length > 0 ? EXIT_CODES.findings : EXIT_CODES.ok };
}

/**
 * Read a project's rhythm from git history (or file mtimes when there is no repo).
 *
 * @param {string} dir
 * @param {{ limit?: number, format?: string, locale?: string }} [options]
 */
export async function rhythmReport(dir, options = {}) {
  const analysis = analyzeRhythm(dir, {
    limit: options.limit,
    commits: options.commits,
    now: options.now,
  });
  const tree = rhythmToTree(analysis);

  const text =
    options.format === 'json'
      ? JSON.stringify(
          {
            project: analysis.project,
            source: analysis.source,
            activeDays: analysis.activeDays,
            spanDays: analysis.spanDays,
            cadencePerDay: analysis.cadencePerDay,
            lastAgoDays: analysis.lastAgoDays,
            stalled: analysis.stalled,
            streakDays: analysis.streakDays,
            themes: analysis.themes,
            phases: analysis.phases.map((phase) => ({
              start: new Date(phase.start).toISOString().slice(0, 10),
              end: new Date(phase.end).toISOString().slice(0, 10),
              count: phase.count,
              themes: phase.themes,
            })),
            recent: analysis.commits.slice(0, 10).map((c) => c.subject),
          },
          null,
          2,
        )
      : options.format === 'tree'
        ? renderAsciiTree(tree)
        : formatRhythm(analysis, { locale: options.locale });

  return { analysis, tree, text };
}

/**
 * @param {string} path
 * @param {{ format?: string, readFile?: Function, adr?: object }} options
 */
export async function exportTree(path, options = {}) {
  const tree = await loadTree(path, { readFile: options.readFile });
  const format = options.format ?? 'md';

  switch (format) {
    case 'md':
      return toMarkdown({ ...tree });
    case 'mermaid':
      return toMermaid({ ...tree });
    case 'adr':
      return toAdr({ ...tree, extractor: 'rule' }, options.adr);
    case 'json':
      return JSON.stringify({ title: tree.title, extractor: 'rule', nodes: tree.nodes }, null, 2);
    case 'stats':
      return JSON.stringify(analyzeTree({ ...tree }), null, 2);
    default:
      throw new Error(`unknown export format: ${format} (md | mermaid | adr | json | stats)`);
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
    `  nodes: ${diff.summary.before} → ${diff.summary.after}`,
    '',
  ];

  if (diff.added.length) {
    lines.push('added:');
    for (const node of diff.added) lines.push(`  + ${node.label} (${node.type})`);
  }
  if (diff.removed.length) {
    lines.push('removed:');
    for (const node of diff.removed) lines.push(`  - ${node.label} (${node.type})`);
  }
  if (diff.modified.length) {
    lines.push('modified:');
    for (const change of diff.modified) lines.push(`  ~ ${change.label}`);
  }
  if (diff.moved.length) {
    lines.push('moved:');
    for (const move of diff.moved) lines.push(`  → ${move.label} (${move.from ?? 'root'} → ${move.to ?? 'root'})`);
  }
  if (!diff.added.length && !diff.removed.length && !diff.modified.length && !diff.moved.length) {
    lines.push('  no structural changes');
  }

  return { text: lines.join('\n'), diff };
}
