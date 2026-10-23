/**
 * @thinking-treelog/core
 *
 * Host-agnostic thought-tree engine. No DOM, no React, no network: everything
 * here is pure and testable, which is what lets the dsh Client half, the MCP
 * server, and any future adapter share one contract.
 *
 * A "thought tree" is a flat node list; parentId carries the structure. Keeping
 * it flat makes persistence and JSON round-trips boring, which is what you want.
 *
 * @typedef {'question'|'claim'|'assumption'|'evidence'|'constraint'|'conclusion'|'action'} ThoughtType
 *
 * @typedef {Object} ThoughtNode
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} label
 * @property {string} text
 * @property {ThoughtType} type
 * @property {number} confidence
 * @property {string} branchId
 * @property {number} createdAt
 * @property {string[]} tags
 *
 * @typedef {Object} ThoughtTree
 * @property {string} title
 * @property {string} [source]
 * @property {ThoughtNode[]} nodes
 * @property {'rule'|'llm'} [extractor]
 * @property {number} [createdAt]
 */

export const NODE_W = 208;
export const NODE_H = 58;
export const COL_W = 272;
export const ROW_H = 86;
export const PAD = 44;

export const DEFAULT_BRANCH = 'main';

/** @type {ThoughtType[]} */
export const TYPE_ORDER = [
  'question',
  'claim',
  'assumption',
  'evidence',
  'constraint',
  'conclusion',
  'action',
];

export const TYPE_META = {
  question: { label: '问题', color: '#5c7cfa' },
  claim: { label: '主张', color: '#2f6feb' },
  assumption: { label: '假设', color: '#d9822b' },
  evidence: { label: '论据', color: '#0ca678' },
  constraint: { label: '约束', color: '#e8590c' },
  conclusion: { label: '结论', color: '#9c36b5' },
  action: { label: '行动', color: '#c2255c' },
};

const TYPE_CUES = [
  { type: 'conclusion', re: /因此|所以|因而|于是|由此可见|综上|得出结论|可见|这说明|这意味着|\b(thus|therefore|hence|so|consequently|this means)\b/i },
  { type: 'evidence', re: /因为|由于|理由是|原因是|数据显示|研究表明|报告显示|例如|比如|据统计|\b(because|since|for example|e\.g\.|data shows|research shows)\b/i },
  { type: 'assumption', re: /假设|假定|假如|倘若|如果|前提是|设想|\b(suppose|assuming|given that)\b/i },
  { type: 'constraint', re: /必须|只能|不得不|限于|约束|受到.{0,8}限制|在.{0,12}条件下|不可|禁止|\b(must|only|cannot|can't|restricted to|constraint|limited to)\b/i },
  { type: 'action', re: /应该|建议|下一步|接下来|需要做|实施方案|落地|着手|采取|我打算|\b(should|recommend|next step|we need to|let's)\b/i },
  { type: 'question', re: /[?？]|是否|如何|为什么|怎么办|能否|哪一个|\b(whether|how|why|what if|which one)\b/i },
  { type: 'claim', re: /我认为|我觉得|我们认为|本质上|核心是|关键在于|我的判断|\b(i think|i believe|in my view|the key is|essentially)\b/i },
];

const TURN_RE = /^(但是|但|然而|不过|另一方面|相反|反之|与此同时|另外|此外|同时|however|but|on the other hand|meanwhile)/i;
const LIST_RE = /^(首先|第一|其一|其次|第二|其二|最后|第三|finally|first|second|third)/i;
const HEDGE_RE = /可能|也许|大概|或许|似乎|应该|maybe|perhaps|probably|might|could be/i;
const STRONG_RE = /数据|统计|研究|报告|实验|调查|\d+(\.\d+)?%|\d{2,}/;

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '而', '及', '或',
  '一个', '这个', '那个', '我们', '你们', '他们', '它', '这', '那', '对于',
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'was', 'were',
  'it', 'this', 'that', 'we', 'you', 'they', 'in', 'on', 'for', 'with',
]);

/** Decision lifecycle states carried through normalisation for lint/ADR use. */
const NODE_STATUS_SET = new Set(['proposed', 'accepted', 'rejected', 'superseded']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Split text into sentence-ish chunks, keeping the terminator.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/**
 * @param {string} sentence
 * @returns {ThoughtType}
 */
export function classifySentence(sentence) {
  const trimmed = String(sentence).trim();
  // Explicit questions win over any connective cue: "是否应该…？" is a question,
  // not an action, even though it contains 应该.
  if (/[?？]\s*$/.test(trimmed)) return 'question';
  if (/^(是否|能否|如何|为什么|怎么办|哪一个|哪种|哪一)/.test(trimmed)) return 'question';
  if (/^(what|how|why|whether|which)\b/i.test(trimmed)) return 'question';

  for (const rule of TYPE_CUES) {
    if (rule.re.test(trimmed)) return rule.type;
  }
  return 'claim';
}

/**
 * @param {string} sentence
 * @returns {number}
 */
export function estimateConfidence(sentence) {
  let score = 0.62;
  if (STRONG_RE.test(sentence)) score += 0.16;
  if (HEDGE_RE.test(sentence)) score -= 0.2;
  if (/必须|一定|必然|肯定|definitely|certainly/i.test(sentence)) score += 0.06;
  return clamp(Number(score.toFixed(2)), 0.2, 0.97);
}

/**
 * @param {string} sentence
 * @param {number} [limit]
 * @returns {string[]}
 */
export function extractTags(sentence, limit = 3) {
  const words = String(sentence)
    .split(/[\s，。；、,.:：;!?！？()（）[\]【】"'“”‘’—\-/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && w.length <= 12 && !STOP_WORDS.has(w.toLowerCase()));
  return [...new Set(words)].slice(0, limit);
}

/**
 * @param {string} sentence
 * @param {number} [max]
 * @returns {string}
 */
export function makeLabel(sentence, max = 22) {
  const cleaned = String(sentence)
    .replace(/^(但是|但|然而|不过|另一方面|相反|同时|此外|另外|因此|所以|因为|由于|首先|其次|最后)[，,、]?/, '')
    .replace(/[。！？!?；;]+$/, '')
    .trim();
  const base = cleaned || String(sentence);
  return base.length > max ? `${base.slice(0, max)}…` : base;
}

/**
 * Offline extractor: connectives → types, and turn/list cues → shape.
 *
 * @param {string} source
 * @param {{ maxNodes?: number }} [options]
 * @returns {ThoughtNode[]}
 */
export function extractWithRules(source, options = {}) {
  const cap = options.maxNodes ?? 60;
  const sentences = splitSentences(source).slice(0, cap);
  const now = Date.now();
  /** @type {ThoughtNode[]} */
  const nodes = [];

  let previousId = null;
  let beforePreviousId = null;
  let branchCounter = 0;
  let branchId = DEFAULT_BRANCH;
  let listAnchorId = null;

  sentences.forEach((sentence, index) => {
    let parentId = previousId;
    const isTurn = TURN_RE.test(sentence);
    const isList = LIST_RE.test(sentence);

    if (index === 0) {
      parentId = null;
    } else if (isTurn && beforePreviousId) {
      parentId = beforePreviousId;
      branchCounter += 1;
      branchId = `branch_${branchCounter}`;
    } else if (isList) {
      if (!listAnchorId) listAnchorId = previousId;
      parentId = listAnchorId;
    } else {
      listAnchorId = null;
    }

    nodes.push({
      id: `n${index + 1}`,
      parentId,
      label: makeLabel(sentence),
      text: sentence,
      type: classifySentence(sentence),
      confidence: estimateConfidence(sentence),
      branchId,
      createdAt: now + index,
      tags: extractTags(sentence),
    });

    beforePreviousId = previousId;
    previousId = nodes[nodes.length - 1].id;
  });

  return nodes;
}

/**
 * @param {unknown} value
 * @returns {value is ThoughtType}
 */
export function isThoughtType(value) {
  return typeof value === 'string' && TYPE_ORDER.includes(/** @type {ThoughtType} */ (value));
}

/**
 * Repair untrusted node data (model output, imported JSON, old storage).
 * Handles missing/duplicate ids, dangling parents, cycles, bad types, and
 * out-of-range confidence.
 *
 * @param {unknown} raw
 * @returns {ThoughtNode[]}
 */
export function normalizeNodes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  const usedIds = new Set();
  /** @type {ThoughtNode[]} */
  const staged = [];

  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = /** @type {Record<string, unknown>} */ (item);

    let id = String(record.id || '').trim() || `n${index + 1}`;
    while (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);

    const text = String(record.text || record.label || '').trim();
    if (!text) return;

    // Engineering metadata is optional but must survive a round-trip, because
    // lint rules and ADR export depend on it.
    const extra = {};
    if (typeof record.status === 'string' && NODE_STATUS_SET.has(record.status)) {
      extra.status = record.status;
    }
    if (typeof record.owner === 'string' && record.owner.trim()) {
      extra.owner = record.owner.trim();
    }
    if (record.isSection === true) {
      extra.isSection = true;
    }
    if (Number.isFinite(Number(record.line)) && Number(record.line) > 0) {
      extra.line = Number(record.line);
    }
    if (Array.isArray(record.refs)) {
      const refs = record.refs
        .filter((r) => typeof r === 'string' && r.trim())
        .map((r) => r.trim())
        .slice(0, 10);
      if (refs.length) extra.refs = refs;
    }

    staged.push({
      id,
      parentId:
        record.parentId === null || record.parentId === undefined || record.parentId === ''
          ? null
          : String(record.parentId),
      label: String(record.label || '').trim() || makeLabel(text),
      text,
      type: isThoughtType(record.type) ? record.type : 'claim',
      confidence: clamp(Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 0.7, 0, 1),
      branchId:
        typeof record.branchId === 'string' && record.branchId ? record.branchId : DEFAULT_BRANCH,
      createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : now + index,
      tags: Array.isArray(record.tags)
        ? record.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 3)
        : extractTags(text),
      ...extra,
    });
  });

  const ids = new Set(staged.map((n) => n.id));
  /** @type {Map<string, string|null>} */
  const parentOf = new Map();

  for (const node of staged) {
    if (node.parentId === null || node.parentId === node.id || !ids.has(node.parentId)) {
      parentOf.set(node.id, null);
    } else {
      parentOf.set(node.id, node.parentId);
    }
  }

  for (const node of staged) {
    let cursor = parentOf.get(node.id) ?? null;
    let steps = 0;
    while (cursor !== null && steps <= staged.length) {
      if (cursor === node.id) {
        parentOf.set(node.id, null);
        break;
      }
      cursor = parentOf.get(cursor) ?? null;
      steps += 1;
    }
  }

  if (staged.length > 0 && !staged.some((n) => (parentOf.get(n.id) ?? null) === null)) {
    parentOf.set(staged[0].id, null);
  }

  return staged.map((node) => ({ ...node, parentId: parentOf.get(node.id) ?? null }));
}

/**
 * @typedef {Object} TreeGraph
 * @property {Map<string, ThoughtNode>} nodeMap
 * @property {Map<string, string[]>} childrenOf
 * @property {string[]} roots
 * @property {string[]} order
 */

/**
 * @param {ThoughtNode[]} nodes
 * @returns {TreeGraph}
 */
export function buildGraph(nodes) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  const roots = [];
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));

  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId === null || !nodeMap.has(parentId)) {
      roots.push(node.id);
      continue;
    }
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(node.id);
  }

  roots.sort((a, b) => /** @type {number} */ (indexOf.get(a)) - /** @type {number} */ (indexOf.get(b)));
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => /** @type {number} */ (indexOf.get(a)) - /** @type {number} */ (indexOf.get(b)));
  }

  /** @type {string[]} */
  const order = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  roots.forEach(walk);
  nodes.forEach((n) => walk(n.id));

  return { nodeMap, childrenOf, roots, order };
}

/**
 * Root → node path, inclusive.
 * @param {TreeGraph} graph
 * @param {string} id
 * @returns {ThoughtNode[]}
 */
export function pathTo(graph, id) {
  /** @type {ThoughtNode[]} */
  const path = [];
  let cursor = /** @type {string|null} */ (id);
  let guard = 0;
  while (cursor !== null && guard <= graph.nodeMap.size) {
    const node = graph.nodeMap.get(cursor);
    if (!node) break;
    path.unshift(node);
    cursor = node.parentId;
    guard += 1;
  }
  return path;
}

/**
 * @param {TreeGraph} graph
 * @param {string} id
 * @returns {string[]}
 */
export function descendantsOf(graph, id) {
  /** @type {string[]} */
  const out = [];
  const walk = (current) => {
    for (const child of graph.childrenOf.get(current) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

/**
 * Tidy left-to-right layout: leaves consume one row, parents centre on children.
 *
 * @param {ThoughtNode[]} nodes
 * @returns {{
 *   nodes: {node: ThoughtNode, depth: number, x: number, y: number}[],
 *   links: {id: string, source: any, target: any, d: string}[],
 *   width: number, height: number, graph: TreeGraph
 * }}
 */
export function computeLayout(nodes) {
  if (!nodes.length) {
    return { nodes: [], links: [], width: 0, height: 0, graph: { nodeMap: new Map(), childrenOf: new Map(), roots: [], order: [] } };
  }

  const graph = buildGraph(nodes);
  /** @type {Map<string, {depth: number, row: number}>} */
  const pos = new Map();
  let row = 0;

  const place = (id, depth) => {
    const kids = graph.childrenOf.get(id) ?? [];
    if (!kids.length) {
      pos.set(id, { depth, row });
      row += 1;
      return pos.get(id);
    }
    const childPositions = kids.map((kid) => place(kid, depth + 1));
    const first = childPositions[0];
    const last = childPositions[childPositions.length - 1];
    const self = { depth, row: (first.row + last.row) / 2 };
    pos.set(id, self);
    return self;
  };

  graph.roots.forEach((rootId) => place(rootId, 0));
  for (const node of nodes) {
    if (!pos.has(node.id)) {
      pos.set(node.id, { depth: 0, row });
      row += 1;
    }
  }

  const placed = [];
  for (const node of nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    placed.push({ node, depth: p.depth, x: p.depth * COL_W + PAD, y: p.row * ROW_H + PAD });
  }

  const byId = new Map(placed.map((p) => [p.node.id, p]));
  const links = [];
  for (const p of placed) {
    const parentId = p.node.parentId;
    if (!parentId || !byId.has(parentId)) continue;
    const source = byId.get(parentId);
    const sx = source.x + NODE_W;
    const sy = source.y + NODE_H / 2;
    const tx = p.x;
    const ty = p.y + NODE_H / 2;
    const mid = (sx + tx) / 2;
    links.push({
      id: `${source.node.id}->${p.node.id}`,
      source,
      target: p,
      d: `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`,
    });
  }

  const width = Math.max(...placed.map((p) => p.x)) + NODE_W + PAD;
  const height = Math.max(...placed.map((p) => p.y)) + NODE_H + PAD;

  return { nodes: placed, links, width, height, graph };
}

/**
 * @param {ThoughtTree} tree
 * @returns {string}
 */
export function toMarkdown(tree) {
  const graph = buildGraph(tree.nodes);
  const lines = [`# ${tree.title}`, ''];

  const emit = (id, depth) => {
    const node = graph.nodeMap.get(id);
    if (!node) return;
    const meta = TYPE_META[node.type] ?? TYPE_META.claim;
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- **${node.label}**（${meta.label} · ${Math.round(node.confidence * 100)}%）`);
    lines.push(`${indent}  ${node.text.replace(/\n+/g, ' ')}`);
    if (node.tags?.length) lines.push(`${indent}  \`${node.tags.join('` `')}\``);
    for (const child of graph.childrenOf.get(id) ?? []) emit(child, depth + 1);
  };

  graph.roots.forEach((rootId) => emit(rootId, 0));
  lines.push('', '---', `节点数：${tree.nodes.length} · 导出：Thinking TreeLog`);
  return lines.join('\n');
}

/**
 * @param {ThoughtTree} tree
 * @returns {string}
 */
export function toMermaid(tree) {
  const graph = buildGraph(tree.nodes);
  const esc = (s) => String(s).replace(/"/g, "'").replace(/[\n\r]+/g, ' ');
  const lines = ['flowchart LR'];

  for (const node of tree.nodes) {
    const meta = TYPE_META[node.type] ?? TYPE_META.claim;
    const label = node.label.length > 16 ? `${node.label.slice(0, 16)}…` : node.label;
    lines.push(`  ${node.id}["${esc(label)}<br/><small>${meta.label}</small>"]`);
  }
  for (const node of tree.nodes) {
    if (node.parentId && graph.nodeMap.has(node.parentId)) {
      lines.push(`  ${node.parentId} --> ${node.id}`);
    }
  }
  lines.push('  classDef question fill:#e8efff,stroke:#2f6feb,color:#12305e');
  lines.push('  classDef claim fill:#eef4ff,stroke:#2f6feb,color:#12305e');
  lines.push('  classDef assumption fill:#fff3e2,stroke:#d9822b,color:#5c3a10');
  lines.push('  classDef evidence fill:#e6f7f1,stroke:#0ca678,color:#0b4a37');
  lines.push('  classDef constraint fill:#ffece2,stroke:#e8590c,color:#5c2408');
  lines.push('  classDef conclusion fill:#f4e9fb,stroke:#9c36b5,color:#3f1550');
  lines.push('  classDef action fill:#ffe8ef,stroke:#c2255c,color:#5e0f2b');
  for (const type of TYPE_ORDER) {
    const ids = tree.nodes.filter((n) => n.type === type).map((n) => n.id);
    if (ids.length) lines.push(`  class ${ids.join(',')} ${type}`);
  }
  return lines.join('\n');
}

/**
 * @typedef {Object} TreeAnalysis
 * @property {number} nodeCount
 * @property {number} depth
 * @property {Record<string, number>} byType
 * @property {number} branchCount
 * @property {string[]} rootLabels
 * @property {number} averageConfidence
 * @property {string[]} lowConfidence
 * @property {number} orphanCount
 */

/**
 * @param {ThoughtTree} tree
 * @returns {TreeAnalysis}
 */
export function analyzeTree(tree) {
  const graph = buildGraph(tree.nodes);
  const byType = {};
  for (const node of tree.nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;

  let depth = 0;
  for (const node of tree.nodes) depth = Math.max(depth, pathTo(graph, node.id).length - 1);

  const branches = new Set(tree.nodes.map((n) => n.branchId || DEFAULT_BRANCH));
  const confidences = tree.nodes.map((n) => n.confidence);
  const averageConfidence = confidences.length
    ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3))
    : 0;

  return {
    nodeCount: tree.nodes.length,
    depth,
    byType,
    branchCount: branches.size,
    rootLabels: graph.roots.map((id) => graph.nodeMap.get(id)?.label ?? id),
    averageConfidence,
    lowConfidence: tree.nodes
      .filter((n) => n.confidence < 0.45)
      .map((n) => n.label)
      .slice(0, 5),
    orphanCount: 0,
  };
}
