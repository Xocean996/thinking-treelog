/**
 * @thinking-treelog/core/engineering
 *
 * The "can this go in a CI pipeline" half of the engine:
 *
 *   parseMarkdown   design docs / ADRs / RFCs  -> thought tree (with line numbers)
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
  extractTags,
  makeLabel,
  normalizeNodes,
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
 * @property {number} [line]
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * Localisation
 * ------------------------------------------------------------------ */

/**
 * Rule messages are localised at render time, so a report can be produced in the
 * reviewer's language without changing the parser or the rule engine.
 */
export const L10N = {
  en: {
    'conclusion-without-evidence': (v) => `Conclusion "${v.label}" has no supporting evidence`,
    'assumption-unverified': (v) => `Assumption "${v.label}" is never validated`,
    'rejected-with-descendants': (v) => `Rejected option "${v.label}" still has ${v.count} child node(s)`,
    'superseded-without-reference': (v) => `Superseded decision "${v.label}" does not say what replaced it`,
    'low-confidence-conclusion': (v) => `Conclusion "${v.label}" has only ${v.percent}% confidence`,
    'depth-exceeds': (v) => `Decision chain reaches depth ${v.depth}, above the limit of ${v.max}`,
    'orphan-node': (v) => `Node "${v.label}" is not reachable from any root`,
    'unresolved-question': (v) => `Question "${v.label}" has no follow-up`,
    'evidence-without-source': (v) => `Evidence "${v.label}" records no source`,
  },
  zh: {
    'conclusion-without-evidence': (v) => `结论「${v.label}」没有任何论据节点`,
    'assumption-unverified': (v) => `假设「${v.label}」没有验证动作`,
    'rejected-with-descendants': (v) => `已否决的「${v.label}」仍有 ${v.count} 个子节点`,
    'superseded-without-reference': (v) => `被取代的「${v.label}」没有记录取代者`,
    'low-confidence-conclusion': (v) => `结论「${v.label}」置信度只有 ${v.percent}%`,
    'depth-exceeds': (v) => `决策链深度 ${v.depth} 超过上限 ${v.max}`,
    'orphan-node': (v) => `节点「${v.label}」无法从根节点到达`,
    'unresolved-question': (v) => `问题「${v.label}」没有后续`,
    'evidence-without-source': (v) => `论据「${v.label}」没有记录来源`,
  },
};

export const HINTS = {
  en: {
    'conclusion-without-evidence': 'Add an evidence child, or demote it to a claim',
    'assumption-unverified': 'Add an action node describing how to validate it',
    'rejected-with-descendants': 'Move those children under the option that is still alive',
    'superseded-without-reference': 'Record the replacement in refs (node id or document link)',
    'unresolved-question': 'Answer it, or record why it is deferred',
    'evidence-without-source': 'Add the link or file it came from to refs',
  },
  zh: {
    'conclusion-without-evidence': '给它补一个 evidence 子节点，或者把它降级成 claim',
    'assumption-unverified': '补一个 action 节点说明怎么验证它',
    'rejected-with-descendants': '把这些子节点挂到仍然有效的方案下',
    'superseded-without-reference': '在 refs 里写入取代它的节点 id 或文档链接',
    'unresolved-question': '回答它，或者记录为什么暂时搁置',
    'evidence-without-source': '在 refs 里补上引用来源',
  },
};

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
 * actual claims. Every node records its 1-based source line, which is what makes
 * SARIF and inline CI annotations point at the right place.
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

  const push = (parentId, rawText, kindHint, isSection, line) => {
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
      line,
      tags: extractTags(text),
      ...(isSection ? { isSection: true } : {}),
    };
    nodes.push(node);
    return node;
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    const sourceLine = lineNo + 1;

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
      const node = push(parentId, heading[2], depth === 1 ? 'claim' : undefined, true, sourceLine);
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
        : (headingStack.length
            ? headingStack[headingStack.length - 1].id
            : contentAnchor);
      const node = push(parentId, decision[2], 'conclusion', false, sourceLine);
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
        : (contentAnchor ??
          (headingStack.length ? headingStack[headingStack.length - 1].id : null));

      let body = listItem[2];
      const bold = body.match(BOLD_LEAD_RE);
      if (bold) body = `${bold[1]}${bold[2] ? `：${bold[2]}` : ''}`;

      const node = push(parentId, body, undefined, false, sourceLine);
      if (node) listStack.push({ indent, id: node.id });
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      const parentId =
        contentAnchor ??
        (listStack.length ? listStack[listStack.length - 1].id : null) ??
        (headingStack.length ? headingStack[headingStack.length - 1].id : null);
      push(parentId, quote[1], 'evidence', false, sourceLine);
      continue;
    }

    const parentId = listStack.length
      ? listStack[listStack.length - 1].id
      : (contentAnchor ?? (headingStack.length ? headingStack[headingStack.length - 1].id : null));
    push(parentId, line, undefined, false, sourceLine);
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
 *
 * `defaultOff` rules stay silent unless explicitly enabled: they are useful in
 * strict mode but noisy on ordinary prose.
 */
export const LINT_RULES = {
  'conclusion-without-evidence': { severity: 'error', description: 'A conclusion with no supporting evidence' },
  'assumption-unverified': { severity: 'warning', description: 'An assumption with no validation step' },
  'rejected-with-descendants': { severity: 'warning', description: 'A rejected option that still carries children' },
  'superseded-without-reference': { severity: 'warning', description: 'A replaced decision that names no replacement' },
  'low-confidence-conclusion': { severity: 'warning', description: 'A conclusion with weak support' },
  'depth-exceeds': { severity: 'warning', description: 'A decision chain too deep to follow' },
  'orphan-node': { severity: 'error', description: 'Structure that does not connect to any root' },
  'unresolved-question': { severity: 'warning', description: 'A question with no follow-up', defaultOff: true },
  'evidence-without-source': { severity: 'info', description: 'Evidence with no recorded source', defaultOff: true },
};

/** Presets let a repo pick a posture instead of listing every rule. */
export const PRESETS = {
  recommended: {},
  strict: {
    'unresolved-question': true,
    'evidence-without-source': true,
    'claim-unsupported': true,
    'single-child-chain': true,
  },
  relaxed: {
    'conclusion-without-evidence': 'warning',
    'assumption-unverified': false,
    'rejected-with-descendants': false,
    'low-confidence-conclusion': false,
    'depth-exceeds': false,
  },
};

/**
 * @param {import('./index.js').ThoughtTree|import('./index.js').ThoughtNode[]} treeOrNodes
 * @param {{
 *   locale?: 'en'|'zh',
 *   maxDepth?: number,
 *   minConclusionConfidence?: number,
 *   rules?: Record<string, boolean|string>,
 * }} [options]
 * @returns {Finding[]}
 */
export function lintTree(treeOrNodes, options = {}) {
  const nodes = Array.isArray(treeOrNodes) ? treeOrNodes : treeOrNodes.nodes;
  const locale = options.locale === 'zh' ? 'zh' : 'en';
  const messages = L10N[locale];
  const hints = HINTS[locale];
  const maxDepth = options.maxDepth ?? 8;
  const minConclusionConfidence = options.minConclusionConfidence ?? 0.5;
  const enabled = options.rules ?? {};

  /** @type {Finding[]} */
  const findings = [];
  if (!nodes.length) return findings;

  const graph = buildGraph(nodes);

  // Post-order pass: O(n) instead of walking each subtree per node.
  const hasEvidence = new Map();
  const hasValidation = new Map();
  const depthOf = new Map();

  const visit = (id, depth) => {
    depthOf.set(id, depth);
    let evidence = false;
    let validation = false;
    for (const childId of graph.childrenOf.get(id) ?? []) {
      visit(childId, depth + 1);
      if (hasEvidence.get(childId)) evidence = true;
      if (hasValidation.get(childId)) validation = true;
    }
    const node = graph.nodeMap.get(id);
    if (node?.type === 'evidence') {
      evidence = true;
      validation = true;
    }
    if (node?.type === 'action') validation = true;
    hasEvidence.set(id, evidence);
    hasValidation.set(id, validation);
  };
  graph.roots.forEach((rootId) => visit(rootId, 0));
  // Unreachable nodes (cycles) still need a depth entry.
  nodes.forEach((n) => {
    if (!depthOf.has(n.id)) depthOf.set(n.id, 0);
  });

  const reachable = new Set(graph.order);

  const resolveSeverity = (rule) => {
    const override = enabled[rule];
    if (override === 'error' || override === 'warning' || override === 'info') return override;
    return LINT_RULES[rule]?.severity ?? 'warning';
  };

  const add = (rule, nodeId, vars = {}) => {
    const override = enabled[rule];
    if (override === false || override === 'off') return;
    const meta = LINT_RULES[rule];
    if (meta?.defaultOff && override !== true && override === undefined) return;

    const node = nodeId ? graph.nodeMap.get(nodeId) : null;
    const label = node?.label ?? '';
    findings.push({
      rule,
      severity: resolveSeverity(rule),
      message: messages[rule]({ ...vars, label }),
      hint: hints[rule],
      nodeId: nodeId ?? null,
      nodeLabel: label,
      ...(Number.isFinite(node?.line) ? { line: node.line } : {}),
    });
  };

  for (const node of nodes) {
    const kids = graph.childrenOf.get(node.id) ?? [];

    if (!reachable.has(node.id)) add('orphan-node', node.id);

    if (node.type === 'conclusion' && !hasEvidence.get(node.id)) {
      add('conclusion-without-evidence', node.id);
    }

    if (node.type === 'assumption' && !hasValidation.get(node.id)) {
      add('assumption-unverified', node.id);
    }

    if (node.status === 'rejected' && kids.length > 0) {
      add('rejected-with-descendants', node.id, { count: kids.length });
    }

    if (node.status === 'superseded' && !(node.refs ?? []).length) {
      add('superseded-without-reference', node.id);
    }

    if (node.type === 'conclusion' && node.confidence < minConclusionConfidence) {
      add('low-confidence-conclusion', node.id, { percent: Math.round(node.confidence * 100) });
    }

    const depth = depthOf.get(node.id) ?? 0;
    if (depth > maxDepth) {
      add('depth-exceeds', node.id, { depth, max: maxDepth });
    }

    if (node.type === 'question' && kids.length === 0) {
      add('unresolved-question', node.id);
    }

    if (node.type === 'evidence' && !(node.refs ?? []).length) {
      add('evidence-without-source', node.id);
    }
  }

  return findings;
}

/**
 * @param {Finding[]} findings
 * @param {{ toolName?: string, toolVersion?: string, file?: string }} [options]
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

  const results = findings.map((finding) => {
    // A single SARIF run can cover many files; each finding may name its own.
    const uri = finding.file ?? file;
    return {
      ruleId: finding.rule,
      level: finding.severity,
      message: {
        text: finding.hint ? `${finding.message} (${finding.hint})` : finding.message,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: {
              startLine: Number.isFinite(finding.line) && finding.line > 0 ? finding.line : 1,
              startColumn: 1,
            },
          },
          logicalLocations: finding.nodeId
            ? [
                {
                  name: finding.nodeLabel || finding.nodeId,
                  fullyQualifiedName: `${uri}#${finding.nodeId}`,
                },
              ]
            : [],
        },
      ],
    };
  });

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
    const out = [];
    const walk = (id) => {
      for (const childId of graph.childrenOf.get(id) ?? []) {
        const child = graph.nodeMap.get(childId);
        if (child) out.push(child);
        walk(childId);
      }
    };
    walk(head.id);
    return out;
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
      (n) => `- ${n.text}${n.type === 'conclusion' && n.confidence < 0.6 ? ' _(low confidence)_' : ''}`,
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
    section('Context', context, '_No context or constraint nodes found._'),
    section('Decision', decision, '_No conclusion nodes found._'),
    section('Consequences', consequences, '_No consequence or action nodes found._'),
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
  const labelKey = (node) => String(node.label).replace(/\s+/g, '').toLowerCase();

  const beforeMap = new Map(before.map((n) => [n.id, n]));
  const afterMap = new Map(after.map((n) => [n.id, n]));
  const beforeByLabel = new Map(before.map((n) => [labelKey(n), n]));
  const afterByLabel = new Map(after.map((n) => [labelKey(n), n]));

  const added = after.filter((n) => !beforeMap.has(n.id) && !beforeByLabel.has(labelKey(n)));

  const removed = [];
  const kept = [];
  for (const node of before) {
    const match = afterMap.get(node.id) ?? afterByLabel.get(labelKey(node));
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

/**
 * Stable identity for a finding, used by baselines and inline suppressions.
 * Label-based so it survives re-extraction (ids are positional).
 * @param {Finding & {file?: string}} finding
 */
export function fingerprint(finding) {
  const where = finding.file ?? '';
  const label = String(finding.nodeLabel ?? '').replace(/\s+/g, ' ').trim();
  return `${finding.rule}|${where}|${label}`;
}

export { clamp };
