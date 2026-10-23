/**
 * @thinking-treelog/core/engineering
 *
 * The "can this go in a CI pipeline" half of the engine:
 *
 *   parseMarkdown   design docs / ADRs / RFCs  -> thought tree
 *   lintTree        tree -> findings (reasoning gaps you can fail a build on)
 *   toSarif         findings -> SARIF 2.1.0 (GitHub Code Scanning)
 *   toAdr           tree -> Architecture Decision Record
 *   diffTrees       decision drift between two revisions
 *
 * Nothing here touches the filesystem or the network: file-existence checks are
 * the CLI's job, which keeps this module pure and testable.
 */

import {
  buildGraph,
  classifySentence,
  descendantsOf,
  extractTags,
  makeLabel,
  normalizeNodes,
  pathTo,
} from './index.js';

export const NODE_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded'];

/** @typedef {'error'|'warning'|'info'} Severity */

/**
 * @typedef {Object} Finding
 * @property {string} rule
 * @property {Severity} severity
 * @property {string} message
 * @property {string} [hint]
 * @property {string|null} [nodeId]
 * @property {string} [nodeLabel]
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * Markdown -> tree
 * ------------------------------------------------------------------ */

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const QUOTE_RE = /^>\s?(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const DECISION_RE = /(决定|决策|结论|decision|we will|we decided|chosen approach)\s*[:：]\s*(.+)$/i;
const BOLD_LEAD_RE = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/;

/**
 * Parse a Markdown design document into a thought tree.
 *
 * Structure comes from headings (h1 -> h2 -> h3) and list nesting. A line that
 * reads like an explicit decision (`Decision: ...`, `我们决定：...`) becomes a
 * conclusion node and anchors the list items that follow it.
 *
 * Heading nodes are marked `isSection` so lint can tell document structure from
 * actual claims.
 *
 * @param {string} markdown
 * @param {{ title?: string, maxNodes?: number }} [options]
 * @returns {import('./index.js').ThoughtNode[]}
 */
export function parseMarkdown(markdown, options = {}) {
  const maxNodes = options.maxNodes ?? 400;
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');

  /** @type {{depth: number, id: string}[]} */
  const headingStack = [];
  /** @type {{indent: number, id: string}[]} */
  const listStack = [];
  /** @type {import('./index.js').ThoughtNode[]} */
  const nodes = [];
  const now = Date.now();

  let inFence = false;
  let index = 0;
  /** The node bare list items attach to when the list stack is empty. */
  let contentAnchor = null;

  const push = (parentId, rawText, kindHint, isSection = false) => {
    const text = rawText.trim();
    if (!text || text.length < 2) return null;
    if (nodes.length >= maxNodes) return null;

    index += 1;
    const type = kindHint || classifySentence(text);
    const node = {
      id: `md${index}`,
      parentId,
      label: makeLabel(text, 28),
      text,
      type,
      confidence: type === 'conclusion' ? 0.7 : 0.62,
      branchId: 'main',
      createdAt: now + index,
      tags: extractTags(text),
      ...(isSection ? { isSection: true } : {}),
    };
    nodes.push(node);
    return node;
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      const depth = heading[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].depth >= depth) {
        headingStack.pop();
      }
      const parentId = headingStack.length ? headingStack[headingStack.length - 1].id : null;
      const node = push(parentId, heading[2], depth === 1 ? 'claim' : undefined, true);
      if (node) {
        headingStack.push({ depth, id: node.id });
        contentAnchor = node.id;
      }
      listStack.length = 0;
      continue;
    }

    const decision = line.match(DECISION_RE);
    if (decision) {
      const indent = (line.match(/^(\s*)/)?.[1] ?? '').replace(/\t/g, '    ').length;
      const parentId = listStack.length
        ? listStack[listStack.length - 1].id
        : headingStack.length
          ? headingStack[headingStack.length - 1].id
          : contentAnchor;
      const node = push(parentId, decision[2], 'conclusion');
      if (node) {
        contentAnchor = node.id;
        listStack.push({ indent, id: node.id });
      }
      continue;
    }

    const listItem = line.match(LIST_RE);
    if (listItem) {
      const indent = listItem[1].replace(/\t/g, '    ').length;
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) {
        listStack.pop();
      }
      const parentId = listStack.length
        ? listStack[listStack.length - 1].id
        : contentAnchor ??
          (headingStack.length ? headingStack[headingStack.length - 1].id : null);

      let body = listItem[2];
      const bold = body.match(BOLD_LEAD_RE);
      if (bold) body = `${bold[1]}${bold[2] ? `：${bold[2]}` : ''}`;

      const node = push(parentId, body, undefined);
      if (node) listStack.push({ indent, id: node.id });
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      // A blockquote is usually supporting evidence for the section it sits in,
      // not for the last bullet, so prefer the section anchor.
      const parentId =
        contentAnchor ?? (listStack.length ? listStack[listStack.length - 1].id : null) ??
        (headingStack.length ? headingStack[headingStack.length - 1].id : null);
      push(parentId, quote[1], 'evidence');
      continue;
    }

    // Plain paragraph: attach to the deepest list item, else the anchor.
    const parentId = listStack.length
      ? listStack[listStack.length - 1].id
      : contentAnchor ?? (headingStack.length ? headingStack[headingStack.length - 1].id : null);
    push(parentId, line, undefined);
  }

  return normalizeNodes(nodes.map((n) => ({ ...n, status: 'proposed' })));
}

/* ------------------------------------------------------------------ *
 * Lint
 * ------------------------------------------------------------------ */

/**
 * Reasoning-gap rules. Each one catches a failure mode that shows up in real
 * design docs: a decision nobody justified, an assumption nobody tested, a
 * "rejected" option that still has live children.
 */
export const LINT_RULES = {
  'conclusion-without-evidence': {
    severity: 'error',
    description: '结论没有任何论据支撑',
  },
  'claim-unsupported': {
    severity: 'info',
    description: '主张是叶子节点，既没有论据也没有下一步',
    defaultOff: true,
  },
  'assumption-unverified': {
    severity: 'warning',
    description: '假设没有被验证，也没有对应的行动',
  },
  'rejected-with-descendants': {
    severity: 'warning',
    description: '已否决的方案仍在承载子节点，容易造成误读',
  },
  'superseded-without-reference': {
    severity: 'info',
    description: '被取代的决策没有记录取代它的引用',
  },
  'low-confidence-conclusion': {
    severity: 'warning',
    description: '结论的置信度偏低',
  },
  'depth-exceeds': {
    severity: 'warning',
    description: '决策链过深，读者难以跟上',
  },
  'single-child-chain': {
    severity: 'info',
    description: '连续三层单子节点，可以合并成一步',
    defaultOff: true,
  },
  'orphan-node': {
    severity: 'error',
    description: '节点无法从任何根节点到达',
  },
};

const hasDescendantOfType = (graph, id, types) => {
  const wanted = new Set(types);
  return descendantsOf(graph, id).some((childId) => wanted.has(graph.nodeMap.get(childId)?.type));
};

/**
 * @param {import('./index.js').ThoughtTree|import('./index.js').ThoughtNode[]} treeOrNodes
 * @param {{ maxDepth?: number, minConclusionConfidence?: number, rules?: Record<string, boolean> }} [options]
 * @returns {Finding[]}
 */
export function lintTree(treeOrNodes, options = {}) {
  const nodes = Array.isArray(treeOrNodes) ? treeOrNodes : treeOrNodes.nodes;
  const maxDepth = options.maxDepth ?? 8;
  const minConclusionConfidence = options.minConclusionConfidence ?? 0.5;
  const enabled = options.rules ?? {};

  /** @type {Finding[]} */
  const findings = [];
  const graph = buildGraph(nodes);
  const reachable = new Set(graph.order);

  const add = (rule, nodeId, message, hint) => {
    if (enabled[rule] === false) return;
    const meta = LINT_RULES[rule];
    // Some rules are noise on structured documents and stay off unless asked for.
    if (meta?.defaultOff && enabled[rule] !== true) return;
    findings.push({
      rule,
      severity: meta?.severity ?? 'warning',
      message,
      hint,
      nodeId: nodeId ?? null,
      nodeLabel: nodeId ? graph.nodeMap.get(nodeId)?.label ?? '' : '',
    });
  };

  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      add('orphan-node', node.id, `节点「${node.label}」无法从根节点到达`);
    }

    if (node.type === 'conclusion' && !hasDescendantOfType(graph, node.id, ['evidence'])) {
      add(
        'conclusion-without-evidence',
        node.id,
        `结论「${node.label}」没有任何论据节点`,
        '给它补一个 evidence 子节点，或者把它降级成 claim',
      );
    }

    if (node.type === 'assumption' && !hasDescendantOfType(graph, node.id, ['evidence', 'action'])) {
      add(
        'assumption-unverified',
        node.id,
        `假设「${node.label}」没有验证动作`,
        '补一个 action 节点说明怎么验证它',
      );
    }

    if (node.type === 'claim' && !node.isSection && !(graph.childrenOf.get(node.id) ?? []).length) {
      add('claim-unsupported', node.id, `主张「${node.label}」是孤立叶子`);
    }

    if (node.status === 'rejected' && (graph.childrenOf.get(node.id) ?? []).length > 0) {
      add(
        'rejected-with-descendants',
        node.id,
        `已否决的「${node.label}」仍有 ${graph.childrenOf.get(node.id).length} 个子节点`,
        '把这些子节点挂到仍然有效的方案下',
      );
    }

    if (node.status === 'superseded' && !(node.refs ?? []).length) {
      add(
        'superseded-without-reference',
        node.id,
        `被取代的「${node.label}」没有记录取代者`,
        '在 refs 里写入取代它的节点 id 或文档链接',
      );
    }

    if (node.type === 'conclusion' && node.confidence < minConclusionConfidence) {
      add(
        'low-confidence-conclusion',
        node.id,
        `结论「${node.label}」置信度只有 ${Math.round(node.confidence * 100)}%`,
      );
    }

    const depth = pathTo(graph, node.id).length - 1;
    if (depth > maxDepth) {
      add('depth-exceeds', node.id, `决策链深度 ${depth} 超过上限 ${maxDepth}`);
    }

    // Three consecutive single-child hops: the chain can be collapsed.
    let cursor = node.id;
    let chain = 0;
    for (let step = 0; step < 3; step += 1) {
      const kids = graph.childrenOf.get(cursor) ?? [];
      if (kids.length !== 1) break;
      chain += 1;
      cursor = kids[0];
    }
    if (chain === 3) {
      add('single-child-chain', node.id, `从「${node.label}」开始连续三层只有一个子节点`);
    }
  }

  return findings;
}

/**
 * @param {Finding[]} findings
 * @param {{ toolName?: string, toolVersion?: string, file?: string, rootDir?: string }} [options]
 */
export function toSarif(findings, options = {}) {
  const toolName = options.toolName ?? 'thinking-treelog';
  const toolVersion = options.toolVersion ?? '0.1.0';
  const file = options.file ?? 'thought-tree';

  const rules = Object.entries(LINT_RULES).map(([id, meta]) => ({
    id,
    shortDescription: { text: meta.description },
    defaultConfiguration: { level: meta.severity },
  }));

  const results = findings.map((finding) => ({
    ruleId: finding.rule,
    level: finding.severity,
    message: {
      text: finding.hint ? `${finding.message}（${finding.hint}）` : finding.message,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: file },
          region: { startLine: 1, startColumn: 1 },
        },
        logicalLocations: finding.nodeId
          ? [{ name: finding.nodeLabel || finding.nodeId, fullyQualifiedName: `${file}#${finding.nodeId}` }]
          : [],
      },
    ],
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: toolVersion,
            informationUri: 'https://github.com/thinking-treelog/thinking-treelog',
            rules,
          },
        },
        results,
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * ADR export
 * ------------------------------------------------------------------ */

/**
 * Render a tree as an Architecture Decision Record.
 *
 * When the tree came from a Markdown document, the ADR sections are mapped onto
 * the document's own headings (Context / Decision / Consequences) instead of
 * guessing from node types. That keeps the export faithful to what the author
 * actually wrote.
 *
 * @param {import('./index.js').ThoughtTree} tree
 * @param {{ id?: string, date?: string, status?: string, deciders?: string[] }} [options]
 */
export function toAdr(tree, options = {}) {
  const graph = buildGraph(tree.nodes);
  const nodes = tree.nodes;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const id = options.id ?? '0001';
  const status = options.status ?? 'Proposed';

  const rootHeading = nodes.find((n) => n.isSection && n.parentId === null);
  const title = rootHeading
    ? rootHeading.text.replace(/^ADR[-\s]*\d+[.:：]?\s*/i, '').trim()
    : tree.title;

  const sectionNodes = (matcher) => {
    const head = nodes.find((n) => n.isSection && matcher.test(n.text));
    if (!head) return null;
    return descendantsOf(graph, head.id)
      .map((childId) => graph.nodeMap.get(childId))
      .filter(Boolean);
  };

  const context =
    sectionNodes(/(context|背景|上下文)/i) ??
    nodes.filter((n) => !n.isSection && ['question', 'assumption', 'constraint'].includes(n.type));
  const decision =
    sectionNodes(/(decision|决定|决策)/i) ??
    nodes.filter((n) => !n.isSection && n.type === 'conclusion');
  const consequences =
    sectionNodes(/(consequence|后果|影响|结果)/i) ??
    nodes.filter((n) => !n.isSection && n.type === 'action');

  const format = (list) =>
    list.map(
      (n) => `- ${n.text}${n.type === 'conclusion' && n.confidence < 0.6 ? ' _(低置信度)_' : ''}`,
    );

  const section = (heading, items, empty) =>
    [`## ${heading}`, '', ...(items.length ? format(items) : [empty]), ''].join('\n');

  return [
    `# ${id}. ${title}`,
    '',
    `- **Status:** ${status}`,
    `- **Date:** ${date}`,
    options.deciders?.length ? `- **Deciders:** ${options.deciders.join(', ')}` : null,
    '',
    section('Context', context, '_没有识别到背景或约束节点。_'),
    section('Decision', decision, '_没有识别到结论节点。_'),
    section('Consequences', consequences, '_没有识别到后果或行动节点。_'),
    '## Metadata',
    '',
    `- Nodes: ${tree.nodes.length}`,
    `- Extractor: ${tree.extractor ?? 'rule'}`,
    '- Generated by Thinking TreeLog',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * Tree diff
 * ------------------------------------------------------------------ */

/**
 * Compare two revisions of a decision tree.
 *
 * Nodes are matched by id first, then by normalised label, which survives
 * re-extraction better than positional matching.
 *
 * @param {import('./index.js').ThoughtNode[]} before
 * @param {import('./index.js').ThoughtNode[]} after
 */
export function diffTrees(before, after) {
  const key = (node) => node.id;
  const labelKey = (node) => String(node.label).replace(/\s+/g, '').toLowerCase();

  const beforeMap = new Map(before.map((n) => [key(n), n]));
  const afterMap = new Map(after.map((n) => [key(n), n]));
  const beforeByLabel = new Map(before.map((n) => [labelKey(n), n]));
  const afterByLabel = new Map(after.map((n) => [labelKey(n), n]));

  const added = after.filter((n) => !beforeMap.has(key(n)) && !beforeByLabel.has(labelKey(n)));

  const removed = [];
  const kept = [];
  for (const node of before) {
    const match = afterMap.get(key(node)) ?? afterByLabel.get(labelKey(node));
    if (match) kept.push({ before: node, after: match });
    else removed.push(node);
  }

  const modified = kept.filter(
    ({ before: b, after: a }) =>
      b.type !== a.type ||
      b.text !== a.text ||
      b.status !== a.status ||
      Math.abs((b.confidence ?? 0) - (a.confidence ?? 0)) > 0.15,
  );

  const moved = kept.filter(({ before: b, after: a }) => b.parentId !== a.parentId);

  return {
    added,
    removed,
    modified: modified.map(({ before: b, after: a }) => ({
      id: a.id,
      label: a.label,
      changes: {
        type: b.type !== a.type ? [b.type, a.type] : undefined,
        status: b.status !== a.status ? [b.status, a.status] : undefined,
        confidence:
          Math.abs((b.confidence ?? 0) - (a.confidence ?? 0)) > 0.15
            ? [b.confidence, a.confidence]
            : undefined,
        text: b.text !== a.text,
      },
    })),
    moved: moved.map(({ before: b, after: a }) => ({
      id: a.id,
      label: a.label,
      from: b.parentId,
      to: a.parentId,
    })),
    summary: {
      before: before.length,
      after: after.length,
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      moved: moved.length,
    },
  };
}

/**
 * Count findings by severity.
 * @param {Finding[]} findings
 */
export function summarizeFindings(findings) {
  const summary = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

export { clamp };
