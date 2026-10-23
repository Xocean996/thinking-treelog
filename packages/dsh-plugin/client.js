/**
 * Thinking TreeLog — dsh Client half.
 *
 * Turns any pasted conversation into a navigable thought tree, with time-travel
 * reveal, branch experiments, search, and export. Self-contained: it needs no
 * build step and no runtime dependency beyond the baseline `react` module.
 */

window.__ModuleLoader__.load({
  id: '@thinking-treelog/dsh-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const NODE_W = 208;
    const NODE_H = 58;
    const COL_W = 272;
    const ROW_H = 86;
    const PAD = 44;

    const DEFAULT_BRANCH = 'main';

    /** Decision lifecycle states carried through normalisation for lint/ADR use. */
    const STATUS_SET = new Set(['proposed', 'accepted', 'rejected', 'superseded']);

    const TYPE_ORDER = [
      'question',
      'claim',
      'assumption',
      'evidence',
      'constraint',
      'conclusion',
      'action',
    ];

    const TYPE_META = {
      question: { label: '问题', color: '#5c7cfa' },
      claim: { label: '主张', color: '#2f6feb' },
      assumption: { label: '假设', color: '#d9822b' },
      evidence: { label: '论据', color: '#0ca678' },
      constraint: { label: '约束', color: '#e8590c' },
      conclusion: { label: '结论', color: '#9c36b5' },
      action: { label: '行动', color: '#c2255c' },
    };

    const BRANCH_PALETTE = ['#2f6feb', '#e8590c', '#0ca678', '#9c36b5', '#c2255c', '#5c7cfa'];
    const MAIN_BRANCH_COLOR = '#6b7280';

    const STATUS_LABELS = {
      proposed: '提议中',
      accepted: '已采纳',
      rejected: '已否决',
      superseded: '已被取代',
    };

    const TREES_KEY = 'ttl.trees.v1';
    const SETTINGS_KEY = 'ttl.settings.v1';

    const SAMPLE_TEXT = `我们应该把思维树做成 dsh 插件，而不是独立网站。
因为用户不会为了复盘一次对话专门打开一个新网站，而插件可以出现在他们已经在工作的地方。
但是，插件的受众只有 dsh 用户，独立网站的传播面更大。
如果目标是先验证需求，那么插件形态的反馈速度更快。
因此，第一版应该先做插件，把提取质量和树可视化打磨好。
下一步需要决定：LLM 提取和本地规则提取，哪一个作为默认。`;

    /* ------------------------------------------------------------------ *
     * Small utilities
     * ------------------------------------------------------------------ */

    const cx = (...parts) => parts.filter(Boolean).join(' ');
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function uid(prefix) {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }

    function truncate(text, max) {
      const s = String(text || '');
      return s.length > max ? `${s.slice(0, max)}…` : s;
    }

    function download(filename, content, mime) {
      const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* ------------------------------------------------------------------ *
     * Rule extraction (offline, deterministic)
     * ------------------------------------------------------------------ */

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

    function splitSentences(text) {
      return String(text)
        .replace(/\r\n/g, '\n')
        .split(/(?<=[。！？!?；;\n])/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4);
    }

    function classifySentence(sentence) {
      const trimmed = String(sentence).trim();
      // Explicit questions win over connective cues: "是否应该…？" is a question,
      // not an action, even though it contains 应该.
      if (/[?？]\s*$/.test(trimmed)) return 'question';
      if (/^(是否|能否|如何|为什么|怎么办|哪一个|哪种|哪一)/.test(trimmed)) return 'question';
      if (/^(what|how|why|whether|which)\b/i.test(trimmed)) return 'question';

      for (const rule of TYPE_CUES) {
        if (rule.re.test(trimmed)) return rule.type;
      }
      return 'claim';
    }

    function estimateConfidence(sentence) {
      let score = 0.62;
      if (STRONG_RE.test(sentence)) score += 0.16;
      if (HEDGE_RE.test(sentence)) score -= 0.2;
      if (/必须|一定|必然|肯定|definitely|certainly/i.test(sentence)) score += 0.06;
      return clamp(Number(score.toFixed(2)), 0.2, 0.97);
    }

    function extractTags(sentence, limit) {
      const max = limit || 3;
      const words = String(sentence)
        .split(/[\s，。；、,.:：;!?！？()（）[\]【】"'“”‘’—\-/]+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2 && w.length <= 12 && !STOP_WORDS.has(w.toLowerCase()));
      return [...new Set(words)].slice(0, max);
    }

    function makeLabel(sentence, max) {
      const limit = max || 22;
      const cleaned = String(sentence)
        .replace(/^(但是|但|然而|不过|另一方面|相反|同时|此外|另外|因此|所以|因为|由于|首先|其次|最后)[，,、]?/, '')
        .replace(/[。！？!?；;]+$/, '')
        .trim();
      const base = cleaned || String(sentence);
      return truncate(base, limit);
    }

    function extractWithRules(source, maxNodes) {
      const cap = maxNodes || 60;
      const sentences = splitSentences(source).slice(0, cap);
      const now = Date.now();
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

        const node = {
          id: `n${index + 1}`,
          parentId,
          label: makeLabel(sentence),
          text: sentence,
          type: classifySentence(sentence),
          confidence: estimateConfidence(sentence),
          branchId,
          createdAt: now + index,
          tags: extractTags(sentence),
        };
        nodes.push(node);
        beforePreviousId = previousId;
        previousId = node.id;
      });

      return nodes;
    }

    /* ------------------------------------------------------------------ *
     * Normalisation — repairs whatever we get, from the model or storage
     * ------------------------------------------------------------------ */

    function isThoughtType(value) {
      return typeof value === 'string' && TYPE_ORDER.indexOf(value) >= 0;
    }

    function normalizeNodes(raw) {
      const list = Array.isArray(raw) ? raw : [];
      const now = Date.now();
      const usedIds = new Set();
      const staged = [];

      list.forEach((item, index) => {
        if (!item || typeof item !== 'object') return;

        let id = String(item.id || '').trim() || `n${index + 1}`;
        while (usedIds.has(id)) id = `${id}_${index + 1}`;
        usedIds.add(id);

        const text = String(item.text || item.label || '').trim();
        if (!text) return;

        const branchRaw = typeof item.branchId === 'string' && item.branchId ? item.branchId : DEFAULT_BRANCH;

        // Engineering metadata survives a round-trip so lint/ADR export work.
        const extra = {};
        if (typeof item.status === 'string' && STATUS_SET.has(item.status)) extra.status = item.status;
        if (typeof item.owner === 'string' && item.owner.trim()) extra.owner = item.owner.trim();
        if (item.isSection === true) extra.isSection = true;
        if (Number.isFinite(Number(item.line)) && Number(item.line) > 0) extra.line = Number(item.line);
        if (Array.isArray(item.refs)) {
          const refs = item.refs
            .filter((r) => typeof r === 'string' && r.trim())
            .map((r) => r.trim())
            .slice(0, 10);
          if (refs.length) extra.refs = refs;
        }

        staged.push({
          id,
          parentId:
            item.parentId === null || item.parentId === undefined || item.parentId === ''
              ? null
              : String(item.parentId),
          label: String(item.label || '').trim() || makeLabel(text),
          text,
          type: isThoughtType(item.type) ? item.type : 'claim',
          confidence: clamp(Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.7, 0, 1),
          branchId: branchRaw,
          createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : now + index,
          tags: Array.isArray(item.tags)
            ? item.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 3)
            : extractTags(text),
          ...extra,
        });
      });

      const ids = new Set(staged.map((n) => n.id));
      const parentOf = new Map();

      staged.forEach((node) => {
        if (node.parentId === null || node.parentId === node.id || !ids.has(node.parentId)) {
          parentOf.set(node.id, null);
        } else {
          parentOf.set(node.id, node.parentId);
        }
      });

      // Break cycles.
      staged.forEach((node) => {
        let cursor = parentOf.get(node.id);
        let steps = 0;
        while (cursor !== null && cursor !== undefined && steps <= staged.length) {
          if (cursor === node.id) {
            parentOf.set(node.id, null);
            break;
          }
          cursor = parentOf.get(cursor);
          steps += 1;
        }
      });

      if (staged.length > 0 && !staged.some((n) => parentOf.get(n.id) === null)) {
        parentOf.set(staged[0].id, null);
      }

      return staged.map((node) => ({ ...node, parentId: parentOf.get(node.id) ?? null }));
    }

    /* ------------------------------------------------------------------ *
     * Graph + layout
     * ------------------------------------------------------------------ */

    function buildGraph(nodes) {
      const nodeMap = new Map();
      nodes.forEach((n) => nodeMap.set(n.id, n));

      const childrenOf = new Map();
      const roots = [];
      const indexOf = new Map();
      nodes.forEach((n, i) => indexOf.set(n.id, i));

      nodes.forEach((node) => {
        const parentId = node.parentId;
        if (parentId === null || !nodeMap.has(parentId)) {
          roots.push(node.id);
          return;
        }
        if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
        childrenOf.get(parentId).push(node.id);
      });

      roots.sort((a, b) => indexOf.get(a) - indexOf.get(b));
      childrenOf.forEach((bucket) => bucket.sort((a, b) => indexOf.get(a) - indexOf.get(b)));

      const order = [];
      const seen = new Set();
      const walk = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        order.push(id);
        (childrenOf.get(id) || []).forEach(walk);
      };
      roots.forEach(walk);
      nodes.forEach((n) => walk(n.id));

      return { nodeMap, childrenOf, roots, order };
    }

    function pathTo(graph, id) {
      const path = [];
      let cursor = id;
      let guard = 0;
      while (cursor !== null && cursor !== undefined && guard <= graph.nodeMap.size) {
        const node = graph.nodeMap.get(cursor);
        if (!node) break;
        path.unshift(node);
        cursor = node.parentId;
        guard += 1;
      }
      return path;
    }

    function descendantsOf(graph, id) {
      const out = [];
      const walk = (current) => {
        (graph.childrenOf.get(current) || []).forEach((child) => {
          out.push(child);
          walk(child);
        });
      };
      walk(id);
      return out;
    }

    /**
     * Tidy left-to-right layout: leaves consume one row each, parents centre on
     * their children. Works for multiple roots without a synthetic node.
     */
    function computeLayout(nodes) {
      if (!nodes.length) return { nodes: [], links: [], width: 0, height: 0 };

      const graph = buildGraph(nodes);
      const pos = new Map();
      let row = 0;

      const place = (id, depth) => {
        const kids = graph.childrenOf.get(id) || [];
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
      // Any node unreachable from a root (cycle leftovers) still needs a slot.
      nodes.forEach((node) => {
        if (!pos.has(node.id)) {
          pos.set(node.id, { depth: 0, row });
          row += 1;
        }
      });

      const placed = [];
      nodes.forEach((node) => {
        const p = pos.get(node.id);
        if (!p) return;
        placed.push({
          node,
          depth: p.depth,
          x: p.depth * COL_W + PAD,
          y: p.row * ROW_H + PAD,
        });
      });

      const byId = new Map(placed.map((p) => [p.node.id, p]));
      const links = [];
      placed.forEach((p) => {
        const parentId = p.node.parentId;
        if (!parentId || !byId.has(parentId)) return;
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
      });

      const maxX = Math.max(...placed.map((p) => p.x)) + NODE_W + PAD;
      const maxY = Math.max(...placed.map((p) => p.y)) + NODE_H + PAD;

      return { nodes: placed, links, width: maxX, height: maxY, graph };
    }

    /* ------------------------------------------------------------------ *
     * LLM extraction (OpenAI-compatible)
     * ------------------------------------------------------------------ */

    const SYSTEM_PROMPT = [
      '你是思维结构分析器。把一段对话或思考文本解析成一棵"思维树"。',
      '规则：',
      '1. 抽取 3-20 个关键思维步骤。合并重复与寒暄，保留推理骨架，不要逐句照抄。',
      '2. 每个节点字段：id（如 n1）、parentId（根为 null）、label（≤20字）、text（完整意思）、',
      '   type（question|claim|assumption|evidence|constraint|conclusion|action）、',
      '   confidence（0-1）、tags（1-3个关键词）。',
      '3. 结构：根节点是核心问题或总主张；"因为/数据表明"是 evidence，挂在被支持的结论下；',
      '   "但是/然而"是对某个节点的反驳，parentId 指向被反驳的节点；"如果/假设"是 assumption；',
      '   并列选项共享同一父节点。',
      '4. 只输出 JSON，不要代码围栏，不要解释。格式：',
      '{"title":"不超过15字","nodes":[{"id":"n1","parentId":null,"label":"...","text":"...","type":"question","confidence":0.8,"tags":["..."]}]}',
    ].join('\n');

    function endpointFor(baseUrl) {
      const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (/\/chat\/completions$/.test(trimmed)) return trimmed;
      return `${trimmed}/chat/completions`;
    }

    function parseModelJson(raw) {
      const fenced = String(raw).match(/```(?:json)?\s*([\s\S]*?)```/i);
      const text = (fenced ? fenced[1] : String(raw)).trim();
      try {
        return JSON.parse(text);
      } catch (e) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
        throw new Error('模型没有返回可解析的 JSON');
      }
    }

    async function extractWithLlm(text, settings, signal) {
      if (!settings || !String(settings.apiKey || '').trim()) throw new Error('未配置 API Key');
      if (!String(settings.model || '').trim()) throw new Error('未配置模型名称');

      const response = await fetch(endpointFor(settings.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${String(settings.apiKey).trim()}`,
        },
        body: JSON.stringify({
          model: String(settings.model).trim(),
          temperature: 0.2,
          max_tokens: 2400,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `请解析下面的文本：\n\n<<<\n${text.slice(0, 12000)}\n>>>` },
          ],
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`请求失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 180)}` : ''}`);
      }

      const payload = await response.json();
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
        ? payload.choices[0].message.content
        : '';
      if (!content) throw new Error('模型返回内容为空');

      const parsed = parseModelJson(content);
      const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      if (!rawNodes.length) throw new Error('模型没有识别出任何思维节点');

      return {
        title: typeof parsed.title === 'string' ? parsed.title.slice(0, 30) : '',
        nodes: normalizeNodes(rawNodes),
      };
    }

    /* ------------------------------------------------------------------ *
     * Export
     * ------------------------------------------------------------------ */

    function treeToMarkdown(tree) {
      const graph = buildGraph(tree.nodes);
      const lines = [`# ${tree.title}`, ''];

      const emit = (id, depth) => {
        const node = graph.nodeMap.get(id);
        if (!node) return;
        const meta = TYPE_META[node.type] || TYPE_META.claim;
        const indent = '  '.repeat(depth);
        lines.push(`${indent}- **${node.label}**（${meta.label} · ${Math.round(node.confidence * 100)}%）`);
        lines.push(`${indent}  ${node.text.replace(/\n+/g, ' ')}`);
        if (node.tags && node.tags.length) lines.push(`${indent}  \`${node.tags.join('` `')}\``);
        (graph.childrenOf.get(id) || []).forEach((child) => emit(child, depth + 1));
      };

      graph.roots.forEach((rootId) => emit(rootId, 0));
      lines.push('', '---', `节点数：${tree.nodes.length} · 导出：Thinking TreeLog`);
      return lines.join('\n');
    }

    function treeToMermaid(tree) {
      const graph = buildGraph(tree.nodes);
      const esc = (s) => String(s).replace(/"/g, "'").replace(/[\n\r]+/g, ' ');
      const lines = ['flowchart LR'];

      tree.nodes.forEach((node) => {
        const meta = TYPE_META[node.type] || TYPE_META.claim;
        lines.push(`  ${node.id}["${esc(truncate(node.label, 16))}<br/><small>${meta.label}</small>"]`);
      });
      tree.nodes.forEach((node) => {
        if (node.parentId && graph.nodeMap.has(node.parentId)) {
          lines.push(`  ${node.parentId} --> ${node.id}`);
        }
      });
      lines.push('  classDef question fill:#e8efff,stroke:#2f6feb,color:#12305e');
      lines.push('  classDef claim fill:#eef4ff,stroke:#2f6feb,color:#12305e');
      lines.push('  classDef assumption fill:#fff3e2,stroke:#d9822b,color:#5c3a10');
      lines.push('  classDef evidence fill:#e6f7f1,stroke:#0ca678,color:#0b4a37');
      lines.push('  classDef constraint fill:#ffece2,stroke:#e8590c,color:#5c2408');
      lines.push('  classDef conclusion fill:#f4e9fb,stroke:#9c36b5,color:#3f1550');
      lines.push('  classDef action fill:#ffe8ef,stroke:#c2255c,color:#5e0f2b');
      TYPE_ORDER.forEach((type) => {
        const ids = tree.nodes.filter((n) => n.type === type).map((n) => n.id);
        if (ids.length) lines.push(`  class ${ids.join(',')} ${type}`);
      });
      return lines.join('\n');
    }

    /* ------------------------------------------------------------------ *
     * Reasoning lint (mirror of @thinking-treelog/core/engineering)
     * ------------------------------------------------------------------ */

    const LINT_RULES = {
      'conclusion-without-evidence': { severity: 'error', text: '结论没有任何论据支撑' },
      'assumption-unverified': { severity: 'warning', text: '假设没有被验证，也没有对应的行动' },
      'rejected-with-descendants': { severity: 'warning', text: '已否决的方案仍在承载子节点' },
      'superseded-without-reference': { severity: 'info', text: '被取代的决策没有记录取代者' },
      'low-confidence-conclusion': { severity: 'warning', text: '结论的置信度偏低' },
      'depth-exceeds': { severity: 'warning', text: '决策链过深' },
      'orphan-node': { severity: 'error', text: '节点无法从任何根节点到达' },
    };

    function hasDescendantOfType(graph, id, types) {
      const wanted = new Set(types);
      return descendantsOf(graph, id).some((childId) => wanted.has((graph.nodeMap.get(childId) || {}).type));
    }

    function lintTree(nodes, options) {
      const opts = options || {};
      const maxDepth = opts.maxDepth == null ? 8 : opts.maxDepth;
      const minConfidence = opts.minConclusionConfidence == null ? 0.5 : opts.minConclusionConfidence;
      const findings = [];
      if (!nodes.length) return findings;

      const graph = buildGraph(nodes);
      const reachable = new Set(graph.order);

      const add = (rule, nodeId, message, hint) => {
        const meta = LINT_RULES[rule];
        findings.push({
          rule,
          severity: meta.severity,
          message,
          hint,
          nodeId: nodeId || null,
          nodeLabel: nodeId && graph.nodeMap.get(nodeId) ? graph.nodeMap.get(nodeId).label : '',
        });
      };

      nodes.forEach((node) => {
        const kids = graph.childrenOf.get(node.id) || [];

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
          add('assumption-unverified', node.id, `假设「${node.label}」没有验证动作`, '补一个 action 节点说明怎么验证它');
        }

        if (node.status === 'rejected' && kids.length > 0) {
          add(
            'rejected-with-descendants',
            node.id,
            `已否决的「${node.label}」仍有 ${kids.length} 个子节点`,
            '把这些子节点挂到仍然有效的方案下',
          );
        }

        if (node.status === 'superseded' && !(node.refs || []).length) {
          add(
            'superseded-without-reference',
            node.id,
            `被取代的「${node.label}」没有记录取代者`,
            '在 refs 里写入取代它的节点 id 或文档链接',
          );
        }

        if (node.type === 'conclusion' && node.confidence < minConfidence) {
          add('low-confidence-conclusion', node.id, `结论「${node.label}」置信度只有 ${Math.round(node.confidence * 100)}%`);
        }

        const depth = pathTo(graph, node.id).length - 1;
        if (depth > maxDepth) {
          add('depth-exceeds', node.id, `决策链深度 ${depth} 超过上限 ${maxDepth}`);
        }
      });

      return findings;
    }

    function treeToAdr(tree) {
      const graph = buildGraph(tree.nodes);
      const nodes = tree.nodes;
      const context = nodes.filter((n) => !n.isSection && ['question', 'assumption', 'constraint'].indexOf(n.type) >= 0);
      const decision = nodes.filter((n) => !n.isSection && n.type === 'conclusion');
      const consequences = nodes.filter((n) => !n.isSection && n.type === 'action');
      const section = (heading, items, empty) =>
        [`## ${heading}`, '', ...(items.length ? items.map((n) => `- ${n.text}`) : [empty]), ''].join('\n');

      return [
        `# 0001. ${tree.title}`,
        '',
        '- **Status:** Proposed',
        `- **Date:** ${new Date().toISOString().slice(0, 10)}`,
        '',
        section('Context', context, '_没有识别到背景或约束节点。_'),
        section('Decision', decision, '_没有识别到结论节点。_'),
        section('Consequences', consequences, '_没有识别到后果或行动节点。_'),
        `- Generated by Thinking TreeLog (${graph.roots.length} roots, ${nodes.length} nodes)`,
      ].join('\n');
    }

    /* ------------------------------------------------------------------ *
     * Persistence
     * ------------------------------------------------------------------ */

    function readJson(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    function writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    }

    function loadTrees() {
      const parsed = readJson(TREES_KEY);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t) => t && typeof t.id === 'string' && Array.isArray(t.nodes))
        .map((t) => ({ ...t, nodes: normalizeNodes(t.nodes) }));
    }

    function loadSettings() {
      const parsed = readJson(SETTINGS_KEY) || {};
      const llm = parsed.llm || {};
      return {
        llm: {
          baseUrl: typeof llm.baseUrl === 'string' ? llm.baseUrl : 'https://api.openai.com/v1',
          apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : '',
          model: typeof llm.model === 'string' ? llm.model : 'gpt-4o-mini',
        },
        mode: parsed.mode === 'rule' || parsed.mode === 'llm' ? parsed.mode : 'auto',
      };
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
      .ttl-root {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-label-primary, #1a1a1a);
        font-size: 13px;
      }
      .ttl-bar {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
        background: var(--dsw-alias-bg-layer-1, #fafafa); flex: none;
      }
      .ttl-title { font-weight: 600; font-size: 14px; margin-right: 4px; }
      .ttl-sub { color: var(--dsw-alias-label-secondary, #666); font-size: 11px; }
      .ttl-spacer { flex: 1; }
      .ttl-btn {
        display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid var(--dsw-alias-border-l1, #d9dbe0); border-radius: 7px;
        background: var(--dsw-alias-bg-layer-1, #fff); color: inherit;
        padding: 5px 10px; font-size: 12px; cursor: pointer; line-height: 1.4;
      }
      .ttl-btn:hover { border-color: var(--dsw-alias-border-l2, #b9bdc6); }
      .ttl-btn:disabled { opacity: .45; cursor: not-allowed; }
      .ttl-btn.primary {
        background: var(--dsw-alias-brand-primary, #2f6feb); border-color: transparent; color: #fff;
      }
      .ttl-btn.primary:hover { filter: brightness(1.06); }
      .ttl-btn.ghost { background: transparent; border-color: transparent; }
      .ttl-input, .ttl-select, .ttl-textarea {
        border: 1px solid var(--dsw-alias-border-l1, #d9dbe0); border-radius: 7px;
        background: var(--dsw-alias-bg-base, #fff); color: inherit;
        padding: 6px 8px; font-size: 12px; font-family: inherit;
      }
      .ttl-textarea { resize: vertical; line-height: 1.6; }
      .ttl-body { display: flex; flex: 1; min-height: 0; }
      .ttl-side {
        width: 316px; flex: none; display: flex; flex-direction: column; min-height: 0;
        border-right: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
        background: var(--dsw-alias-bg-layer-1, #fafafa);
      }
      .ttl-side-inner { padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
      .ttl-side h4 { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #777); }
      .ttl-tree-list { display: flex; flex-direction: column; gap: 4px; }
      .ttl-tree-item {
        display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px;
        cursor: pointer; border: 1px solid transparent;
      }
      .ttl-tree-item:hover { background: var(--dsw-alias-bg-layer-2, #f0f1f3); }
      .ttl-tree-item.active { border-color: var(--dsw-alias-brand-primary, #2f6feb); background: var(--dsw-alias-bg-base, #fff); }
      .ttl-tree-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ttl-tree-item .meta { font-size: 10px; color: var(--dsw-alias-label-secondary, #888); }
      .ttl-canvas { flex: 1; position: relative; min-width: 0; overflow: hidden; background: var(--dsw-alias-bg-base, #fff); }
      .ttl-canvas svg { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
      .ttl-canvas svg.dragging { cursor: grabbing; }
      .ttl-empty {
        position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
        align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #888);
        text-align: center; padding: 24px; pointer-events: none;
      }
      .ttl-empty strong { color: var(--dsw-alias-label-primary, #333); font-size: 14px; }
      .ttl-detail {
        width: 320px; flex: none; border-left: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
        background: var(--dsw-alias-bg-layer-1, #fafafa); overflow: auto; padding: 12px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .ttl-detail .row { display: flex; gap: 6px; }
      .ttl-detail .row > * { flex: 1; min-width: 0; }
      .ttl-badge {
        display: inline-flex; align-items: center; gap: 4px; border-radius: 999px;
        padding: 2px 8px; font-size: 10px; color: #fff; font-weight: 600;
      }
      .ttl-crumbs { font-size: 11px; color: var(--dsw-alias-label-secondary, #777); line-height: 1.7; word-break: break-word; }
      .ttl-crumbs b { color: var(--dsw-alias-label-primary, #333); font-weight: 500; }
      .ttl-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); line-height: 1.6; }
      .ttl-error { color: var(--dsw-alias-state-error-primary, #c92a2a); font-size: 12px; line-height: 1.5; }
      .ttl-notice { color: var(--dsw-alias-state-warn-primary, #b35c00); font-size: 11px; line-height: 1.5; }
      .ttl-slider { width: 130px; accent-color: var(--dsw-alias-brand-primary, #2f6feb); }
      .ttl-chips { display: flex; gap: 4px; flex-wrap: wrap; }
      .ttl-chip {
        border: 1px solid var(--dsw-alias-border-l1, #d9dbe0); background: transparent; color: inherit;
        border-radius: 999px; padding: 2px 8px; font-size: 10px; cursor: pointer;
      }
      .ttl-chip.on { background: var(--dsw-alias-brand-primary, #2f6feb); border-color: transparent; color: #fff; }
      .ttl-legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10px; color: var(--dsw-alias-label-secondary, #888); }
      .ttl-lints { display: flex; flex-direction: column; gap: 4px; }
      .ttl-lint {
        display: flex; flex-direction: column; gap: 1px; padding: 5px 7px;
        border-radius: 6px; border-left: 3px solid var(--dsw-alias-border-l2, #adb5bd);
        cursor: pointer; background: var(--dsw-alias-bg-base, #fff);
        font-size: 11px; line-height: 1.45;
      }
      .ttl-lint:hover { background: var(--dsw-alias-bg-layer-2, #f0f1f3); }
      .ttl-lint.error { border-left-color: var(--dsw-alias-state-error-primary, #e03131); }
      .ttl-lint.warning { border-left-color: var(--dsw-alias-state-warn-primary, #f08c00); }
      .ttl-lint.info { border-left-color: var(--dsw-alias-brand-primary, #1c7ed6); }
      .ttl-lint-rule { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9.5px; color: var(--dsw-alias-label-secondary, #888); }
      .ttl-lint-msg { color: var(--dsw-alias-label-primary, #333); }
      .ttl-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; }
      .ttl-settings { display: flex; flex-direction: column; gap: 8px; }
      .ttl-settings label { font-size: 11px; color: var(--dsw-alias-label-secondary, #777); }
      .ttl-settings input, .ttl-settings select { width: 100%; box-sizing: border-box; }
      @media (max-width: 980px) {
        .ttl-side { width: 250px; }
        .ttl-detail { position: absolute; right: 0; top: 0; bottom: 0; z-index: 4; width: 300px; box-shadow: -8px 0 24px rgba(0,0,0,.12); }
      }
    `;

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    function PanelIcon(props) {
      const size = props && props.size ? props.size : 18;
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M6 3.5v17' }),
        h('path', { d: 'M6 8h5' }),
        h('path', { d: 'M6 16h5' }),
        h('circle', { cx: 14.5, cy: 8, r: 2.2 }),
        h('circle', { cx: 14.5, cy: 16, r: 2.2 }),
        h('circle', { cx: 20.5, cy: 12, r: 1.6 }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Tree canvas
     * ------------------------------------------------------------------ */

    function TreeCanvas(props) {
      const {
        nodes, selectedId, onSelect, query, typeFilter, cutoff,
        onAddChild, layoutRef,
      } = props;

      const svgRef = useRef(null);
      const [view, setView] = useState({ x: 0, y: 0, w: 800, h: 600 });
      const [drag, setDrag] = useState(null);
      const fittedRef = useRef('');

      const layout = useMemo(() => computeLayout(nodes), [nodes]);

      useEffect(() => {
        if (layoutRef) layoutRef.current = layout;
      }, [layout, layoutRef]);

      // Fit whenever the topology changes shape.
      const signature = `${layout.width}x${layout.height}x${nodes.length}`;
      useEffect(() => {
        if (fittedRef.current === signature) return;
        fittedRef.current = signature;
        const el = svgRef.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        const availW = Math.max(200, box.width || 800);
        const availH = Math.max(200, box.height || 600);
        const scale = Math.min(availW / Math.max(1, layout.width), availH / Math.max(1, layout.height), 1.1);
        const w = availW / scale;
        const h = availH / scale;
        setView({
          x: layout.width / 2 - w / 2,
          y: layout.height / 2 - h / 2,
          w,
          h,
        });
      }, [signature, layout.width, layout.height]);

      const visibleIds = useMemo(() => {
        const sorted = [...nodes].sort((a, b) => a.createdAt - b.createdAt);
        return new Set(sorted.slice(0, cutoff).map((n) => n.id));
      }, [nodes, cutoff]);

      const highlightIds = useMemo(() => {
        if (!selectedId) return new Set();
        return new Set(pathTo(layout.graph, selectedId).map((n) => n.id));
      }, [layout.graph, selectedId]);

      const q = String(query || '').trim().toLowerCase();
      const matches = useCallback(
        (node) => {
          if (q) {
            const hay = `${node.label} ${node.text} ${(node.tags || []).join(' ')}`.toLowerCase();
            if (hay.indexOf(q) < 0) return false;
          }
          if (typeFilter && typeFilter !== 'all' && node.type !== typeFilter) return false;
          return true;
        },
        [q, typeFilter],
      );

      const onWheel = (event) => {
        event.preventDefault();
        const el = svgRef.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        const mx = (event.clientX - box.left) / Math.max(1, box.width);
        const my = (event.clientY - box.top) / Math.max(1, box.height);
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        setView((prev) => {
          const w = clamp(prev.w / factor, 220, layout.width * 2.6 + 400);
          const scaleChange = w / prev.w;
          const h = prev.h * scaleChange;
          const px = prev.x + mx * prev.w;
          const py = prev.y + my * prev.h;
          return { x: px - mx * w, y: py - my * h, w, h };
        });
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const el = svgRef.current;
        if (!el) return;
        el.setPointerCapture && el.setPointerCapture(event.pointerId);
        setDrag({ sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y, moved: false });
      };

      const onPointerMove = (event) => {
        if (!drag) return;
        const el = svgRef.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        const kx = view.w / Math.max(1, box.width);
        const ky = view.h / Math.max(1, box.height);
        const dx = (event.clientX - drag.sx) * kx;
        const dy = (event.clientY - drag.sy) * ky;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        setView((prev) => ({ ...prev, x: drag.vx - dx, y: drag.vy - dy }));
      };

      const onPointerUp = () => setDrag(null);

      const resetView = () => {
        fittedRef.current = '';
        setView({ x: 0, y: 0, w: Math.max(400, layout.width), h: Math.max(300, layout.height) });
      };

      return h(
        'div',
        { className: 'ttl-canvas' },
        h(
          'svg',
          {
            ref: svgRef,
            viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
            className: drag && drag.moved ? 'dragging' : '',
            onWheel,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
          },
          // Links first so nodes paint on top.
          h(
            'g',
            null,
            layout.links.map((link) => {
              const onPath = highlightIds.has(link.target.node.id) && highlightIds.has(link.source.node.id);
              const dim = !visibleIds.has(link.target.node.id) || !matches(link.target.node);
              return h('path', {
                key: link.id,
                d: link.d,
                fill: 'none',
                stroke: onPath ? '#2f6feb' : 'var(--dsw-alias-border-l2, #c6cad2)',
                strokeWidth: onPath ? 2.4 : 1.4,
                strokeDasharray: dim ? '4 5' : undefined,
                opacity: dim ? 0.35 : 0.9,
              });
            }),
          ),
          h(
            'g',
            null,
            layout.nodes.map((entry) => {
              const node = entry.node;
              const meta = TYPE_META[node.type] || TYPE_META.claim;
              const selected = node.id === selectedId;
              const onPath = highlightIds.has(node.id);
              const visible = visibleIds.has(node.id);
              const hit = matches(node);
              const rejected = node.status === 'rejected';
              const accepted = node.status === 'accepted';

              const fill = rejected
                ? 'var(--dsw-alias-bg-layer-2, #e9ebef)'
                : visible
                  ? meta.color
                  : 'var(--dsw-alias-bg-layer-2, #e9ebef)';
              const textColor = rejected || !visible ? 'var(--dsw-alias-label-secondary, #888)' : '#fff';

              return h(
                'g',
                {
                  key: node.id,
                  transform: `translate(${entry.x}, ${entry.y})`,
                  style: { cursor: 'pointer', opacity: hit ? 1 : 0.28, transition: 'opacity .18s' },
                  onClick: (event) => {
                    if (drag && drag.moved) return;
                    event.stopPropagation();
                    onSelect(node.id);
                  },
                  onDoubleClick: (event) => {
                    event.stopPropagation();
                    if (onAddChild) onAddChild(node.id);
                  },
                },
                h('rect', {
                  width: NODE_W,
                  height: NODE_H,
                  rx: 9,
                  fill,
                  stroke: selected
                    ? '#111'
                    : rejected
                      ? '#e03131'
                      : accepted
                        ? '#0ca678'
                        : onPath
                          ? 'rgba(47,111,235,.85)'
                          : 'transparent',
                  strokeWidth: selected ? 2.4 : rejected || accepted ? 1.8 : onPath ? 1.6 : 0,
                  strokeDasharray: rejected ? '5 4' : undefined,
                  opacity: visible ? 1 : 0.85,
                }),
                h(
                  'text',
                  {
                    x: 12, y: 24, fill: textColor,
                    fontSize: 12.5, fontWeight: 600,
                    style: { pointerEvents: 'none' },
                  },
                  truncate(node.label, 13),
                ),
                h(
                  'text',
                  {
                    x: 12, y: 43, fill: textColor, opacity: visible ? 0.85 : 0.7,
                    fontSize: 10.5, style: { pointerEvents: 'none' },
                  },
                  `${meta.label} · ${Math.round(node.confidence * 100)}%`,
                ),
                node.branchId && node.branchId !== DEFAULT_BRANCH
                  ? h('circle', {
                      cx: NODE_W - 10, cy: 10, r: 4,
                      fill: BRANCH_PALETTE[Math.abs(hashCode(node.branchId)) % BRANCH_PALETTE.length],
                    })
                  : null,
              );
            }),
          ),
          h(
            'g',
            { transform: `translate(${view.x + view.w - 104}, ${view.y + view.h - 40})` },
            h(
              'g',
              { onClick: resetView, style: { cursor: 'pointer' } },
              h('rect', {
                width: 88, height: 28, rx: 6,
                fill: 'var(--dsw-alias-bg-layer-1, #fff)',
                stroke: 'var(--dsw-alias-border-l1, #d9dbe0)',
              }),
              h(
                'text',
                {
                  x: 44, y: 18, textAnchor: 'middle', fontSize: 11,
                  fill: 'var(--dsw-alias-label-secondary, #666)',
                  style: { pointerEvents: 'none' },
                },
                '适应画布',
              ),
            ),
          ),
        ),
        layout.nodes.length === 0
          ? h(
              'div',
              { className: 'ttl-empty' },
              h('strong', null, '还没有思维树'),
              h('div', null, '在左侧粘贴一段对话，点击「解析成思维树」'),
            )
          : null,
      );
    }

    function hashCode(value) {
      let hash = 0;
      const s = String(value);
      for (let i = 0; i < s.length; i += 1) {
        hash = (hash * 31 + s.charCodeAt(i)) | 0;
      }
      return hash;
    }

    /* ------------------------------------------------------------------ *
     * Node detail
     * ------------------------------------------------------------------ */

    function NodeDetail(props) {
      const { node, graph, onUpdate, onBranch, onAddChild, onDelete, onClose } = props;
      const meta = TYPE_META[node.type] || TYPE_META.claim;
      const path = pathTo(graph, node.id);

      return h(
        'aside',
        { className: 'ttl-detail' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'ttl-badge', style: { background: meta.color } }, meta.label),
          h('span', { className: 'ttl-hint' }, `置信度 ${Math.round(node.confidence * 100)}%`),
          h('span', { className: 'ttl-spacer', style: { flex: 1 } }),
          h('button', { className: 'ttl-btn ghost', onClick: onClose, title: '关闭' }, '✕'),
        ),

        h('div', { className: 'ttl-crumbs' },
          path.map((step, index) =>
            h('span', { key: step.id },
              index > 0 ? ' › ' : '',
              h('b', null, truncate(step.label, 14)),
            ),
          ),
        ),

        h('label', { className: 'ttl-hint' }, '标题'),
        h('input', {
          className: 'ttl-input',
          value: node.label,
          onChange: (e) => onUpdate(node.id, { label: e.target.value.slice(0, 40) }),
        }),

        h('label', { className: 'ttl-hint' }, '内容'),
        h('textarea', {
          className: 'ttl-textarea',
          rows: 6,
          value: node.text,
          onChange: (e) => onUpdate(node.id, { text: e.target.value }),
        }),

        h('div', { className: 'row' },
          h('div', null,
            h('label', { className: 'ttl-hint' }, '类型'),
            h('select', {
              className: 'ttl-select',
              value: node.type,
              onChange: (e) => onUpdate(node.id, { type: e.target.value }),
            }, TYPE_ORDER.map((type) => h('option', { key: type, value: type }, TYPE_META[type].label))),
          ),
          h('div', null,
            h('label', { className: 'ttl-hint' }, '置信度'),
            h('input', {
              className: 'ttl-input',
              type: 'number', min: 0, max: 1, step: 0.05,
              value: node.confidence,
              onChange: (e) => onUpdate(node.id, { confidence: clamp(Number(e.target.value) || 0, 0, 1) }),
            }),
          ),
        ),

        h('label', { className: 'ttl-hint' }, '决策状态'),
        h('select', {
          className: 'ttl-select',
          value: node.status || 'proposed',
          onChange: (e) => onUpdate(node.id, { status: e.target.value }),
        }, ['proposed', 'accepted', 'rejected', 'superseded'].map((status) =>
            h('option', { key: status, value: status }, STATUS_LABELS[status]))),

        node.tags && node.tags.length
          ? h('div', { className: 'ttl-chips' },
              node.tags.map((tag) => h('span', { key: tag, className: 'ttl-chip' }, tag)))
          : null,

        h('div', { className: 'row' },
          h('button', { className: 'ttl-btn', onClick: () => onAddChild(node.id) }, '＋ 子节点'),
          h('button', { className: 'ttl-btn', onClick: () => onBranch(node.id) }, '⑂ 分支实验'),
        ),
        h('div', { className: 'row' },
          h('button', {
            className: 'ttl-btn',
            style: { color: 'var(--dsw-alias-state-error-primary, #c92a2a)' },
            onClick: () => onDelete(node.id),
          }, '删除节点'),
        ),

        h('div', { className: 'ttl-hint' },
          '提示：双击画布节点可直接添加子节点；拖拽画布平移，滚轮缩放。'),
      );
    }

    /* ------------------------------------------------------------------ *
     * Settings
     * ------------------------------------------------------------------ */

    function SettingsPanel(props) {
      const { settings, onChange, onClose } = props;
      const llm = settings.llm;

      const patch = (next) => onChange({ ...settings, ...next });

      return h(
        'div',
        { className: 'ttl-settings' },
        h('div', { style: { display: 'flex', alignItems: 'center' } },
          h('strong', { style: { fontSize: 12 } }, 'AI 提取设置'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'ttl-btn ghost', onClick: onClose }, '✕'),
        ),
        h('div', { className: 'ttl-hint' },
          '留空 API Key 时自动使用本地规则提取，完全离线可用。填入任意 OpenAI 兼容端点即可获得更准的语义提取。'),
        h('label', null, 'Base URL'),
        h('input', {
          className: 'ttl-input',
          value: llm.baseUrl,
          placeholder: 'https://api.openai.com/v1',
          onChange: (e) => patch({ llm: { ...llm, baseUrl: e.target.value } }),
        }),
        h('label', null, 'API Key'),
        h('input', {
          className: 'ttl-input',
          type: 'password',
          value: llm.apiKey,
          placeholder: 'sk-...',
          onChange: (e) => patch({ llm: { ...llm, apiKey: e.target.value } }),
        }),
        h('label', null, '模型'),
        h('input', {
          className: 'ttl-input',
          value: llm.model,
          placeholder: 'gpt-4o-mini',
          onChange: (e) => patch({ llm: { ...llm, model: e.target.value } }),
        }),
        h('label', null, '提取方式'),
        h('select', {
          className: 'ttl-select',
          value: settings.mode,
          onChange: (e) => patch({ mode: e.target.value }),
        },
          h('option', { value: 'auto' }, '自动（有 Key 用 AI，失败回退规则）'),
          h('option', { value: 'llm' }, '仅 AI 提取'),
          h('option', { value: 'rule' }, '仅本地规则'),
        ),
        h('div', { className: 'ttl-hint' },
          'API Key 只保存在本机 localStorage，不会上传到除你填写的端点以外的任何地方。'),
      );
    }

    /* ------------------------------------------------------------------ *
     * Main panel
     * ------------------------------------------------------------------ */

    function Panel() {
      const [trees, setTrees] = useState(() => loadTrees());
      const [currentId, setCurrentId] = useState(() => {
        const loaded = loadTrees();
        return loaded.length ? loaded[0].id : '';
      });
      const [settings, setSettings] = useState(() => loadSettings());

      const [source, setSource] = useState(SAMPLE_TEXT);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [selectedId, setSelectedId] = useState('');
      const [query, setQuery] = useState('');
      const [typeFilter, setTypeFilter] = useState('all');
      const [cutoff, setCutoff] = useState(9999);
      const [showSettings, setShowSettings] = useState(false);
      const [showSidebar, setShowSidebar] = useState(true);

      const layoutRef = useRef(null);

      const current = useMemo(
        () => trees.find((t) => t.id === currentId) || null,
        [trees, currentId],
      );
      const nodes = current ? current.nodes : [];
      const graph = useMemo(() => buildGraph(nodes), [nodes]);
      const selected = selectedId ? graph.nodeMap.get(selectedId) : null;
      const findings = useMemo(() => (nodes.length ? lintTree(nodes) : []), [nodes]);
      const errorCount = findings.filter((f) => f.severity === 'error').length;

      useEffect(() => {
        writeJson(SETTINGS_KEY, settings);
      }, [settings]);

      useEffect(() => {
        if (currentId && !trees.some((t) => t.id === currentId)) {
          setCurrentId(trees.length ? trees[0].id : '');
        }
      }, [trees, currentId]);

      const persist = useCallback((next) => {
        setTrees(next);
        writeJson(TREES_KEY, next);
      }, []);

      const patchCurrent = useCallback(
        (patch) => {
          setTrees((prev) => {
            const next = prev.map((t) =>
              t.id === currentId ? { ...t, ...patch, updatedAt: Date.now() } : t,
            );
            writeJson(TREES_KEY, next);
            return next;
          });
        },
        [currentId],
      );

      const doExtract = async () => {
        const text = source.trim();
        if (!text) {
          setError('请先粘贴一段对话或思考文本');
          return;
        }
        setBusy(true);
        setError('');
        setNotice('');

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeout = setTimeout(() => {
          if (controller) controller.abort();
        }, 45000);

        try {
          const warnings = [];
          let extracted = null;
          let extractor = 'rule';

          const wantsLlm = settings.mode !== 'rule' && String(settings.llm.apiKey || '').trim();
          if (wantsLlm) {
            try {
              const result = await extractWithLlm(text, settings.llm, controller ? controller.signal : undefined);
              extracted = { title: result.title, nodes: result.nodes };
              extractor = 'llm';
            } catch (err) {
              const message = err && err.name === 'AbortError' ? 'AI 提取超时' : (err && err.message) || String(err);
              if (settings.mode === 'llm') throw new Error(message);
              warnings.push(`AI 提取失败，已回退到本地规则：${message}`);
            }
          } else if (settings.mode === 'llm') {
            throw new Error('请先在设置中填写 API Key');
          }

          if (!extracted) {
            const ruleNodes = extractWithRules(text);
            if (!ruleNodes.length) throw new Error('没能从这段文本中识别出思维步骤');
            if (ruleNodes.length >= 60) warnings.push('文本较长，已截取前 60 个思维步骤');
            extracted = { title: '', nodes: normalizeNodes(ruleNodes) };
            extractor = 'rule';
          }

          const now = Date.now();
          const tree = {
            id: uid('tree'),
            title: extracted.title || makeLabel(text.replace(/\s+/g, ' '), 24) || '未命名思维树',
            source: text,
            nodes: extracted.nodes,
            createdAt: now,
            updatedAt: now,
            extractor,
          };

          const next = [tree, ...trees].slice(0, 40);
          persist(next);
          setCurrentId(tree.id);
          setSelectedId('');
          setCutoff(tree.nodes.length);
          if (warnings.length) setNotice(warnings.join('；'));
        } catch (err) {
          setError((err && err.message) || String(err));
        } finally {
          clearTimeout(timeout);
          setBusy(false);
        }
      };

      const updateNode = (id, patch) => {
        patchCurrent({
          nodes: nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
        });
      };

      const addChild = (parentId) => {
        const now = Date.now();
        const child = {
          id: uid('n'),
          parentId,
          label: '新的思考',
          text: '在这里写下这一步推理…',
          type: 'claim',
          confidence: 0.7,
          branchId: (graph.nodeMap.get(parentId) || {}).branchId || DEFAULT_BRANCH,
          createdAt: now,
          tags: [],
        };
        patchCurrent({ nodes: [...nodes, child] });
        setSelectedId(child.id);
        setCutoff(nodes.length + 1);
      };

      const branchNode = (id) => {
        const origin = graph.nodeMap.get(id);
        if (!origin) return;
        const now = Date.now();
        const branchId = `branch_${now.toString(36)}`;
        const clone = {
          ...origin,
          id: uid('n'),
          branchId,
          label: `${origin.label}（分支）`,
          text: `${origin.text}\n\n[分支假设] 如果换一个前提，这里的推理会怎么变？`,
          createdAt: now,
        };
        patchCurrent({ nodes: [...nodes, clone] });
        setSelectedId(clone.id);
        setCutoff(nodes.length + 1);
        setNotice('已创建一条平行分支，编辑它的内容来对比不同假设。');
      };

      const deleteNode = (id) => {
        const children = graph.childrenOf.get(id) || [];
        const parentId = (graph.nodeMap.get(id) || {}).parentId || null;
        const remaining = nodes
          .filter((n) => n.id !== id)
          .map((n) => (children.indexOf(n.id) >= 0 ? { ...n, parentId } : n));
        patchCurrent({ nodes: remaining });
        setSelectedId('');
      };

      const deleteTree = (id) => {
        const next = trees.filter((t) => t.id !== id);
        persist(next);
        if (currentId === id) {
          setCurrentId(next.length ? next[0].id : '');
          setSelectedId('');
        }
      };

      const exportJson = () => {
        if (!current) return;
        download(
          `${current.title.replace(/[\\/:*?"<>|]/g, '_')}.json`,
          JSON.stringify(
            {
              title: current.title,
              source: current.source,
              extractor: current.extractor,
              createdAt: current.createdAt,
              nodes: current.nodes.map((n) => ({
                id: n.id, parentId: n.parentId, label: n.label, text: n.text,
                type: n.type, confidence: n.confidence, branchId: n.branchId, tags: n.tags,
              })),
            },
            null,
            2,
          ),
          'application/json',
        );
      };

      const exportMarkdown = () => {
        if (!current) return;
        download(`${current.title.replace(/[\\/:*?"<>|]/g, '_')}.md`, treeToMarkdown(current), 'text/markdown');
      };

      const exportMermaid = () => {
        if (!current) return;
        download(`${current.title.replace(/[\\/:*?"<>|]/g, '_')}.mmd`, treeToMermaid(current), 'text/plain');
      };

      const exportAdr = () => {
        if (!current) return;
        download(`${current.title.replace(/[\\/:*?"<>|]/g, '_')}.adr.md`, treeToAdr(current), 'text/markdown');
      };

      const copyMarkdown = async () => {
        if (!current) return;
        try {
          await navigator.clipboard.writeText(treeToMarkdown(current));
          setNotice('Markdown 已复制到剪贴板');
        } catch (e) {
          setNotice('复制失败，请使用导出按钮');
        }
      };

      const totalNodes = nodes.length;

      return h(
        'div',
        { className: 'ttl-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),

        // Toolbar
        h(
          'div',
          { className: 'ttl-bar' },
          h('span', { className: 'ttl-title' }, '思维树'),
          h('span', { className: 'ttl-sub' },
            current ? `${current.title} · ${totalNodes} 节点 · ${current.extractor === 'llm' ? 'AI 提取' : '规则提取'}` : '尚未选择'),
          h('span', { className: 'ttl-spacer' }),
          h('input', {
            className: 'ttl-input',
            placeholder: '搜索节点…',
            value: query,
            style: { width: 150 },
            onChange: (e) => setQuery(e.target.value),
          }),
          h('select', {
            className: 'ttl-select',
            value: typeFilter,
            onChange: (e) => setTypeFilter(e.target.value),
          },
            h('option', { value: 'all' }, '全部类型'),
            TYPE_ORDER.map((t) => h('option', { key: t, value: t }, TYPE_META[t].label)),
          ),
          h('label', { className: 'ttl-hint', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            '时间旅行',
            h('input', {
              className: 'ttl-slider',
              type: 'range',
              min: 0,
              max: Math.max(1, totalNodes),
              value: Math.min(cutoff, Math.max(1, totalNodes)),
              onChange: (e) => setCutoff(Number(e.target.value)),
              disabled: !totalNodes,
            }),
            h('span', { style: { minWidth: 42 } },
              `${Math.min(cutoff, totalNodes)}/${totalNodes}`),
          ),
          h('button', { className: 'ttl-btn', onClick: () => setCutoff(totalNodes), disabled: !totalNodes }, '全部'),
          h('button', { className: 'ttl-btn ghost', onClick: () => setShowSidebar((v) => !v) },
            showSidebar ? '收起输入' : '展开输入'),
          h('button', { className: 'ttl-btn ghost', onClick: () => setShowSettings((v) => !v) }, '设置'),
        ),

        h(
          'div',
          { className: 'ttl-body' },
          // Left column
          showSidebar
            ? h(
                'div',
                { className: 'ttl-side' },
                h(
                  'div',
                  { className: 'ttl-side-inner' },
                  h('h4', null, '从文本生成'),
                  h('textarea', {
                    className: 'ttl-textarea',
                    rows: 8,
                    value: source,
                    placeholder: '粘贴一段对话、一次方案讨论，或你自己的思考记录…',
                    onChange: (e) => setSource(e.target.value),
                  }),
                  h('div', { className: 'row', style: { display: 'flex', gap: 6 } },
                    h('button', {
                      className: 'ttl-btn primary',
                      style: { flex: 1, justifyContent: 'center' },
                      onClick: doExtract,
                      disabled: busy,
                    }, busy ? '解析中…' : '解析成思维树'),
                    h('button', {
                      className: 'ttl-btn',
                      onClick: () => setSource(SAMPLE_TEXT),
                      title: '载入示例',
                    }, '示例'),
                  ),
                  error ? h('div', { className: 'ttl-error' }, error) : null,
                  notice ? h('div', { className: 'ttl-notice' }, notice) : null,

                  showSettings
                    ? h(SettingsPanel, {
                        settings,
                        onChange: setSettings,
                        onClose: () => setShowSettings(false),
                      })
                    : null,

                  h('h4', { style: { marginTop: 4 } }, `已保存的思维树 (${trees.length})`),
                  trees.length === 0
                    ? h('div', { className: 'ttl-hint' }, '还没有思维树。')
                    : h('div', { className: 'ttl-tree-list' },
                        trees.map((tree) =>
                          h('div', {
                            key: tree.id,
                            className: cx('ttl-tree-item', tree.id === currentId && 'active'),
                            onClick: () => {
                              setCurrentId(tree.id);
                              setSelectedId('');
                              setCutoff(tree.nodes.length);
                              setError('');
                              setNotice('');
                            },
                          },
                            h('span', { className: 'name', title: tree.title }, tree.title),
                            h('span', { className: 'meta' }, `${tree.nodes.length}`),
                            h('button', {
                              className: 'ttl-btn ghost',
                              style: { padding: '0 4px' },
                              title: '删除',
                              onClick: (e) => { e.stopPropagation(); deleteTree(tree.id); },
                            }, '✕'),
                          ),
                        ),
                      ),

                  h('h4', null, `推理检查${findings.length ? ` · ${findings.length}` : ''}`),
                  findings.length === 0
                    ? h('div', { className: 'ttl-hint' }, nodes.length ? '✔ 没有发现推理缺口' : '生成思维树后自动检查')
                    : h('div', { className: 'ttl-lints' },
                        findings.slice(0, 8).map((finding) =>
                          h('div', {
                            key: `${finding.rule}:${finding.nodeId}`,
                            className: cx('ttl-lint', finding.severity),
                            title: finding.hint || '',
                            onClick: () => { if (finding.nodeId) setSelectedId(finding.nodeId); },
                          },
                            h('span', { className: 'ttl-lint-rule' }, finding.rule),
                            h('span', { className: 'ttl-lint-msg' }, finding.message),
                          ),
                        ),
                        findings.length > 8
                          ? h('div', { className: 'ttl-hint' }, `还有 ${findings.length - 8} 条…`)
                          : null,
                      ),

                  h('div', { className: 'ttl-legend' },
                    TYPE_ORDER.map((type) =>
                      h('span', { key: type },
                        h('i', { style: { background: TYPE_META[type].color } }),
                        TYPE_META[type].label,
                      ),
                    ),
                  ),
                  h('div', { className: 'ttl-hint' },
                    '导出：',
                    h('button', { className: 'ttl-btn', style: { margin: '0 4px' }, onClick: exportMarkdown, disabled: !current }, 'Markdown'),
                    h('button', { className: 'ttl-btn', style: { margin: '0 4px' }, onClick: exportMermaid, disabled: !current }, 'Mermaid'),
                    h('button', { className: 'ttl-btn', style: { margin: '0 4px' }, onClick: exportJson, disabled: !current }, 'JSON'),
                    h('button', { className: 'ttl-btn', style: { margin: '0 4px' }, onClick: exportAdr, disabled: !current }, 'ADR'),
                    h('button', { className: 'ttl-btn', style: { margin: '0 4px' }, onClick: copyMarkdown, disabled: !current }, '复制'),
                  ),
                ),
              )
            : null,

          // Canvas
          h(TreeCanvas, {
            nodes,
            selectedId,
            onSelect: setSelectedId,
            query,
            typeFilter,
            cutoff,
            onAddChild: addChild,
            layoutRef,
          }),

          // Detail
          selected
            ? h(NodeDetail, {
                node: selected,
                graph,
                onUpdate: updateNode,
                onBranch: branchNode,
                onAddChild: addChild,
                onDelete: deleteNode,
                onClose: () => setSelectedId(''),
              })
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    // Test hook: lets the workspace consistency test compare this browser copy
    // against @thinking-treelog/core without a browser. Never set in production.
    if (typeof globalThis !== 'undefined' && globalThis.__TTL_TEST__) {
      globalThis.__TTL_INTERNALS__ = {
        splitSentences,
        classifySentence,
        estimateConfidence,
        extractTags,
        makeLabel,
        extractWithRules,
        normalizeNodes,
        buildGraph,
        computeLayout,
        treeToMarkdown,
        treeToMermaid,
        lintTree,
        treeToAdr,
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'thinking-treelog',
              order: 20,
              label: () => '思维树',
            },
            PanelIcon,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'thinking-treelog' },
            Panel,
          ),
        );
      },
    };
  },
});
