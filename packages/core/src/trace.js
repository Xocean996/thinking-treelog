/**
 * @thinking-treelog/core/trace
 *
 * Answer the question `writing-plans` asks a human to answer by eye:
 * "can you point to a task that implements each requirement?"
 *
 * Matching is lexical (CJK bigrams + latin words), so it is a *review aid*, not a
 * verdict. The output is deliberately conservative: it names the best candidate
 * task for each spec decision, and flags the ones with no plausible candidate at
 * all. A low score means "look at this yourself", not "this is missing".
 */

import { buildGraph } from './index.js';

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '而', '及', '或',
  '一个', '这个', '那个', '我们', '你们', '他们', '它', '这', '那', '对于',
  '可以', '需要', '应该', '如果', '因为', '所以', '但是', '而且', '然后',
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'was', 'were',
  'it', 'this', 'that', 'we', 'you', 'they', 'in', 'on', 'for', 'with',
  'be', 'will', 'should', 'must', 'can', 'may', 'as', 'at', 'by', 'from',
]);

/**
 * Tokenise text into CJK bigrams plus latin/digit words.
 * Bigrams keep Chinese matching useful without a segmentation dependency.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const source = String(text).toLowerCase();
  /** @type {Set<string>} */
  const tokens = new Set();

  for (const match of source.matchAll(/[a-z][a-z0-9_]{1,}/g)) {
    const word = match[0];
    if (!STOP_WORDS.has(word)) tokens.add(word);
  }

  const cjk = source.replace(/[^\u4e00-\u9fa5]+/g, '\u0000');
  for (const chunk of cjk.split('\u0000')) {
    if (chunk.length === 1) {
      if (!STOP_WORDS.has(chunk)) tokens.add(chunk);
      continue;
    }
    for (let i = 0; i + 1 < chunk.length; i += 1) {
      const bigram = chunk.slice(i, i + 2);
      if (!STOP_WORDS.has(bigram)) tokens.add(bigram);
    }
  }

  return tokens;
}

/**
 * Share of the query's tokens that also appear in the document.
 * Asymmetric on purpose: we ask "is this decision reflected in this task?",
 * not "are these two texts similar?".
 *
 * @param {Set<string>} query
 * @param {Set<string>} document
 */
export function coverageScore(query, document) {
  if (query.size === 0 || document.size === 0) return 0;
  let hits = 0;
  for (const token of query) {
    if (document.has(token)) hits += 1;
  }
  return hits / query.size;
}

function taskHaystack(task) {
  const produces = task.produces ?? [];
  const consumes = task.consumes ?? [];
  return [
    task.title,
    ...(task.steps ?? []).map((step) => step.text),
    ...(task.files?.create ?? []),
    ...(task.files?.modify ?? []),
    ...(task.files?.test ?? []),
    ...produces.map((iface) => iface.signature),
    ...consumes.map((iface) => iface.signature),
    // A task that declares interfaces is the task that deals with interfaces;
    // this keeps a spec decision about "the interface graph" from matching nowhere.
    ...(produces.length ? ['produces'] : []),
    ...(consumes.length ? ['consumes'] : []),
  ].join(' ');
}

function nodeHaystack(node) {
  return [node.label, node.text, ...(node.tags ?? [])].join(' ');
}

/**
 * @typedef {Object} TraceEntry
 * @property {import('./index.js').ThoughtNode} node
 * @property {number|null} taskId
 * @property {string} taskTitle
 * @property {number} score
 * @property {boolean} matched
 */

/**
 * @typedef {Object} TraceResult
 * @property {TraceEntry[]} entries
 * @property {TraceEntry[]} matched
 * @property {TraceEntry[]} unmatched
 * @property {{id: number, title: string}[]} unreferencedTasks
 * @property {number} threshold
 * @property {number} decisionCount
 */

/**
 * @param {import('./index.js').ThoughtNode[]} specNodes
 * @param {import('./plan.js').PlanTask[]} planTasks
 * @param {{ threshold?: number, includeTypes?: string[] }} [options]
 * @returns {TraceResult}
 */
export function traceCoverage(specNodes, planTasks, options = {}) {
  const threshold = options.threshold ?? 0.12;
  const includeTypes = options.includeTypes ?? ['conclusion', 'claim', 'action', 'constraint'];

  // Prefer the document's own Decision section: a spec's Context and
  // Consequences list background and fallout, not things to implement.
  let candidates = [];
  const section = specNodes.find(
    (node) => node.isSection && /(decision|决定|决策)/i.test(node.text),
  );

  if (section) {
    const graph = buildGraph(specNodes);
    const collect = (id) => {
      for (const childId of graph.childrenOf.get(id) ?? []) {
        const child = graph.nodeMap.get(childId);
        if (child && !child.isSection) candidates.push(child);
        collect(childId);
      }
    };
    collect(section.id);
  }

  if (!candidates.length) {
    candidates = specNodes.filter(
      (node) => !node.isSection && includeTypes.includes(node.type),
    );
  }

  const decisions = candidates;

  const documents = planTasks.map((task) => ({
    task,
    tokens: tokenize(taskHaystack(task)),
  }));

  /** @type {TraceEntry[]} */
  const entries = decisions.map((node) => {
    const query = tokenize(nodeHaystack(node));
    let best = null;
    let bestScore = 0;

    for (const document of documents) {
      const score = coverageScore(query, document.tokens);
      if (score > bestScore) {
        bestScore = score;
        best = document.task;
      }
    }

    return {
      node,
      taskId: best ? best.id : null,
      taskTitle: best ? best.title : '',
      score: Number(bestScore.toFixed(3)),
      matched: bestScore >= threshold,
    };
  });

  const matched = entries.filter((entry) => entry.matched);
  const unmatched = entries.filter((entry) => !entry.matched);

  const referenced = new Set(matched.map((entry) => entry.taskId));
  const unreferencedTasks = planTasks
    .filter((task) => !referenced.has(task.id))
    .map((task) => ({ id: task.id, title: task.title }));

  return {
    entries,
    matched,
    unmatched,
    unreferencedTasks,
    threshold,
    decisionCount: decisions.length,
  };
}

function shorten(node, max = 48) {
  const text = String(node.text || node.label || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * @param {TraceResult} result
 * @param {{ specTitle?: string, planTitle?: string, locale?: 'en'|'zh' }} [context]
 */
export function formatTrace(result, context = {}) {
  const zh = context.locale === 'zh';
  const lines = [];

  lines.push(
    `${context.specTitle ?? 'spec'} → ${context.planTitle ?? 'plan'}`,
  );
  lines.push(
    zh
      ? `  ${result.decisionCount} 个决策 · 阈值 ${result.threshold}`
      : `  ${result.decisionCount} decisions · threshold ${result.threshold}`,
  );
  lines.push('');

  if (result.matched.length) {
    lines.push(zh ? '有对应任务：' : 'matched:');
    for (const entry of result.matched) {
      lines.push(
        `  ✔ ${shorten(entry.node)}  →  Task ${entry.taskId}: ${entry.taskTitle}  (${entry.score})`,
      );
    }
    lines.push('');
  }

  if (result.unmatched.length) {
    lines.push(zh ? '没有明显对应的任务（请人工确认）：' : 'no plausible task (check by hand):');
    for (const entry of result.unmatched) {
      const near = entry.taskId
        ? `  最近: Task ${entry.taskId} (${entry.score})`
        : '';
      lines.push(`  ✖ ${shorten(entry.node)}${near}`);
    }
    lines.push('');
  }

  if (result.unreferencedTasks.length) {
    lines.push(zh ? '计划里有、但 spec 没提的任务：' : 'tasks the spec never mentions:');
    for (const task of result.unreferencedTasks) {
      lines.push(`  ? Task ${task.id}: ${task.title}`);
    }
    lines.push('');
  }

  const summary = zh
    ? `${result.matched.length}/${result.decisionCount} 个决策找到了对应任务，${result.unmatched.length} 个需要人工确认`
    : `${result.matched.length}/${result.decisionCount} decisions point at a task, ${result.unmatched.length} need a human look`;
  lines.push(summary);

  return lines.join('\n');
}
