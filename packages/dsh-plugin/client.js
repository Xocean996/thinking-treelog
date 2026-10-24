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

    const NODE_W = 236;
    const NODE_H = 68;
    const COL_W = 304;
    const ROW_H = 80;
    const PAD = 48;

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
    // Bump on every change that must be visible in the UI. If the panel does not
    // show this marker, the browser is still running an older module.
    const BUILD = 'r8';
    const BACKUP_KEY = 'ttl.trees.backup.v1';
    const SETTINGS_KEY = 'ttl.settings.v1';
    const APIKEY_SESSION_KEY = 'ttl.llm.key';

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

    /** #rrggbb -> rgba() so node tints work in both themes. */
    function withAlpha(hex, alpha) {
      const value = String(hex).replace('#', '');
      if (value.length !== 6) return `rgba(120, 130, 150, ${alpha})`;
      const n = parseInt(value, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    function uid(prefix) {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }

    function truncate(text, max) {
      // Count code points: `slice` on a string cuts UTF-16 units and can split an
      // emoji into two lone surrogates, which renders as garbage.
      const chars = Array.from(String(text || ''));
      return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
    }

    function download(filename, content, mime) {
      // Windows caps a path at 260 chars; a long tree title used to fail the
      // save silently. Keep the stem short and keep the extension.
      const dot = filename.lastIndexOf('.');
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : '';
      // Code points again: slicing by units cuts an emoji in half.
      const safe = `${Array.from(stem).slice(0, 48).join('')}${ext}`;

      const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safe;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
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
        if (typeof item.annotation === 'string' && item.annotation.trim()) extra.annotation = item.annotation;
        if (typeof item.note === 'string' && item.note.trim()) extra.note = item.note;
        if (item.review && typeof item.review === 'object') {
          const pick = (value) =>
            Array.isArray(value) ? value.filter((x) => typeof x === 'string').slice(0, 4) : [];
          extra.review = {
            pros: pick(item.review.pros),
            cons: pick(item.review.cons),
            next: pick(item.review.next),
          };
          if (Number.isFinite(Number(item.review.score))) {
            extra.review.score = Number(item.review.score);
          }
          if (typeof item.review.rewrite === 'string' && item.review.rewrite.trim()) {
            extra.review.rewrite = item.review.rewrite;
          }
        }
        // These carry the link back to the conversation. Dropping them here is
        // what made double-click do nothing.
        if (Number.isFinite(Number(item.seq))) extra.seq = Number(item.seq);
        if (typeof item.messageText === 'string' && item.messageText.trim()) {
          extra.messageText = item.messageText;
        }
        if (typeof item.skill === 'string' && item.skill.trim()) extra.skill = item.skill;
        if (item.virtual === true) extra.virtual = true;
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
     * Structured plan auditing (superpowers writing-plans output)
     * ------------------------------------------------------------------ */

    const PLAN_RULES = {
      'undefined-consume': { severity: 'error', text: '消费了没有 Task 生产的符号' },
      'signature-mismatch': { severity: 'error', text: '同一个符号有两种签名' },
      'task-without-verification': { severity: 'warning', text: 'Task 没有可执行的验证步骤' },
      'task-without-files': { severity: 'warning', text: 'Task 没有列出文件' },
      'review-focus-empty': { severity: 'warning', text: '多任务计划缺少 Review Focus' },
      'code-block-heavy': { severity: 'info', text: '代码块占计划比例过高' },
    };

    function looksLikePlan(text) {
      return /^###\s+Task\s+\d+\s*[:：]/m.test(String(text));
    }

    function parseIfaceClient(raw) {
      const text = String(raw).trim();
      const code = text.match(/`([^`]+)`/);
      const body = (code ? code[1] : text).trim();
      const name = body.match(/^([A-Za-z_$][\w$]*)/);
      const from = text.match(/from\s+Task\s+(\d+)/i);
      return {
        symbol: name ? name[1] : String(body).split(/[\s(]/)[0],
        signature: body,
        fromTask: from ? Number(from[1]) : null,
      };
    }

    function parsePlanClient(markdown) {
      const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
      const plan = { title: '', tasks: [], reviewCount: 0, totalLines: lines.length, fenceLines: 0 };
      let task = null;
      let currentStep = null;
      let inFence = false;
      let inReview = false;

      const pushTask = () => { if (task) plan.tasks.push(task); };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineNo = i + 1;

        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          plan.fenceLines += 1;
          continue;
        }
        if (inFence) {
          plan.fenceLines += 1;
          continue;
        }

        if (!plan.title) {
          const h1 = line.match(/^#\s+(.+?)\s*$/);
          if (h1) { plan.title = h1[1]; continue; }
        }

        const taskMatch = line.match(/^###\s+Task\s+(\d+)\s*[:：]\s*(.+?)\s*$/i);
        if (taskMatch) {
          pushTask();
          task = {
            id: Number(taskMatch[1]),
            title: taskMatch[2],
            line: lineNo,
            fileCount: 0,
            consumes: [],
            produces: [],
            steps: [],
          };
          inReview = false;
          currentStep = null;
          continue;
        }

        if (/^##\s+/.test(line)) {
          inReview = /review\s*focus/i.test(line);
          continue;
        }

        if (inReview) {
          if (/^\s*[-*]\s+\S/.test(line)) plan.reviewCount += 1;
          continue;
        }

        if (!task) continue;

        if (/^\s*-\s*(Create|Modify|Test)\s*[:：]/i.test(line)) {
          task.fileCount += 1;
          continue;
        }

        const iface = line.match(/^\s*-\s*(Consumes|Produces)\s*[:：]\s*(.+)$/i);
        if (iface) {
          const parsed = parseIfaceClient(iface[2]);
          if (/consumes/i.test(iface[1])) task.consumes.push(parsed);
          else task.produces.push(parsed);
          continue;
        }

        const step = line.match(/^\s*-\s*\[([ xX])\]\s*(?:\*\*)?Step\s+(\d+)\s*[:：]?\s*(?:\*\*)?\s*(.*)$/);
        if (step) {
          currentStep = {
            index: Number(step[2]),
            text: step[3].replace(/\*+\s*$/, '').trim(),
            line: lineNo,
            detail: '',
          };
          task.steps.push(currentStep);
          continue;
        }

        // Body lines under a step carry the Run:/Expected: pair.
        if (currentStep && line.trim() && !/^\s*-\s*\[/.test(line)) {
          currentStep.detail += `${line}\n`;
        }
      }

      pushTask();
      return plan;
    }

    function isVerificationStep(step) {
      const haystack = typeof step === 'string' ? step : `${step.text || ''} ${step.detail || ''}`;
      return /(^|\b)(run|execute|verify|运行|验证)\b|expected\s*:|verify it (passes|fails)|should (pass|fail)/i.test(
        haystack,
      );
    }

    function lintPlanClient(plan) {
      const findings = [];
      if (!plan.tasks.length) return findings;

      const producers = new Map();
      plan.tasks.forEach((task) => {
        task.produces.forEach((iface) => {
          if (!producers.has(iface.symbol)) producers.set(iface.symbol, []);
          producers.get(iface.symbol).push({ taskId: task.id, signature: iface.signature });
        });
      });

      const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

      const add = (rule, task, message, hint) => {
        findings.push({
          rule,
          severity: PLAN_RULES[rule].severity,
          message,
          hint,
          taskId: task ? task.id : null,
          nodeLabel: task ? `Task ${task.id}` : '',
          ...(task && Number.isFinite(task.line) ? { line: task.line } : {}),
        });
      };

      plan.tasks.forEach((task) => {
        task.consumes.forEach((iface) => {
          const makers = producers.get(iface.symbol);

          if (!makers || !makers.length) {
            if (iface.fromTask !== null) {
              add(
                'undefined-consume',
                task,
                `Task ${task.id} 消费了「${iface.symbol}」，但没有任何 Task 生产它`,
                '要么在对应 Task 补上 Produces，要么改掉 Consumes 的名字',
              );
            }
            return;
          }

          if (iface.fromTask !== null && !makers.some((m) => m.taskId === iface.fromTask)) {
            add(
              'undefined-consume',
              task,
              `Task ${task.id} 说「${iface.symbol}」来自 Task ${iface.fromTask}，但那里没有生产它`,
              '要么在对应 Task 补上 Produces，要么改掉 Consumes 的名字',
            );
            return;
          }

          if (norm(makers[0].signature) !== norm(iface.signature)) {
            add(
              'signature-mismatch',
              task,
              `「${iface.symbol}」声明为「${makers[0].signature}」，却被当作「${iface.signature}」使用`,
              '让两边使用同一个签名',
            );
          }
        });

        if (!task.steps.some((s) => isVerificationStep(s))) {
          add(
            'task-without-verification',
            task,
            `Task ${task.id}「${task.title}」没有可执行的验证步骤`,
            '补一个带命令和预期输出的步骤',
          );
        }

        if (task.fileCount === 0) {
          add('task-without-files', task, `Task ${task.id}「${task.title}」没有列出文件`, '列出这个 Task 创建或修改的文件');
        }
      });

      if (plan.tasks.length > 1 && plan.reviewCount === 0) {
        add('review-focus-empty', null, '多任务计划缺少 Review Focus 段', '写出 spec 没有覆盖的输入或失败模式');
      }

      if (plan.totalLines > 0) {
        const percent = Math.round((plan.fenceLines / plan.totalLines) * 100);
        if (percent > 50) {
          add(
            'code-block-heavy',
            null,
            `代码块占计划的 ${percent}% —— 写签名，不要写实现`,
            '把实现体换成签名、测试名和断言',
          );
        }
      }

      return findings;
    }

    function planToTreeClient(plan) {
      const nodes = [];
      const now = Date.now();
      let seq = 0;

      const push = (parentId, label, text, type, extra) => {
        seq += 1;
        const node = {
          id: `p${seq}`,
          parentId,
          label,
          text,
          type,
          confidence: 0.8,
          branchId: DEFAULT_BRANCH,
          createdAt: now + seq,
          tags: [],
          ...(extra || {}),
        };
        nodes.push(node);
        return node;
      };

      const root = push(null, plan.title || 'Implementation plan', plan.title || 'Implementation plan', 'claim', { isSection: true });
      plan.tasks.forEach((task) => {
        const taskNode = push(root.id, `Task ${task.id}: ${task.title}`, task.title, 'action', {
          isSection: true,
          line: task.line,
        });
        task.steps.forEach((step) => {
          push(taskNode.id, step.text || `Step ${step.index}`, step.text, isVerificationStep(step.text) ? 'evidence' : 'action', {
            line: step.line,
          });
        });
      });
      return nodes;
    }

    /* ------------------------------------------------------------------ *
     * Local project import
     * ------------------------------------------------------------------ */

    const PROJECT_SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor|out)(\/|$)/i;
    const PROJECT_READABLE = /\.(md|markdown|mdx|json)$/i;
    const PROJECT_BUDGET = 400;

    function readDocTitle(text) {
      const match = String(text).match(/^#\s+(.+?)\s*$/m);
      return match ? match[1].trim() : '';
    }

    /** Walk a dropped FileSystemDirectoryEntry into a flat file list. */
    async function walkEntry(entry, prefix, out) {
      if (!entry || out.length >= PROJECT_BUDGET) return;
      if (entry.isFile) {
        out.push({ path: `${prefix}${entry.name}`, entry });
        return;
      }
      if (!entry.isDirectory || PROJECT_SKIP.test(`${prefix}${entry.name}`)) return;

      const reader = entry.createReader();
      const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await readBatch();
      while (batch.length && out.length < PROJECT_BUDGET) {
        for (const child of batch) {
          if (out.length >= PROJECT_BUDGET) break;
          await walkEntry(child, `${prefix}${entry.name}/`, out);
        }
        batch = await readBatch();
      }
    }

    function entryToFile(item) {
      if (item.file) return Promise.resolve(item.file);
      return new Promise((resolve, reject) => item.entry.file(resolve, reject));
    }

    /**
     * Turn a local project into a thought tree: project root, stack constraints,
     * top-level modules, documents, and any superpowers plans it contains.
     */
    function buildProjectTree(files) {
      const nodes = [];
      const now = Date.now();
      let seq = 0;

      const push = (parentId, label, text, type, extra) => {
        seq += 1;
        const node = {
          id: `pr${seq}`,
          parentId,
          label: String(label || text || '').slice(0, 30),
          text: text || label || '',
          type,
          confidence: 0.75,
          branchId: DEFAULT_BRANCH,
          createdAt: now + seq,
          tags: [],
          ...(extra || {}),
        };
        nodes.push(node);
        return node;
      };

      const byPath = (re) => files.find((f) => re.test(f.path));
      const packageFile = byPath(/(^|\/)package\.json$/);
      let pkg = null;
      if (packageFile) {
        try {
          pkg = JSON.parse(packageFile.text);
        } catch {
          pkg = null;
        }
      }

      const topName = files.length ? files[0].path.split('/')[0] : '';
      const projectName = (pkg && pkg.name) || topName || 'local project';
      const root = push(null, projectName, (pkg && pkg.description) || `Imported from ${projectName}`, 'claim', {
        isSection: true,
      });

      const deps = pkg
        ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
        : [];
      if (deps.length) {
        push(root.id, `Stack: ${deps.slice(0, 3).join(', ')}`, deps.join(', '), 'constraint');
      }
      if (pkg && pkg.scripts && pkg.scripts.test) {
        push(root.id, `Test: ${String(pkg.scripts.test).slice(0, 40)}`, String(pkg.scripts.test), 'evidence');
      }

      // Top-level modules, but only when there are enough files to be meaningful.
      const dirCount = new Map();
      for (const file of files) {
        const parts = file.path.split('/');
        if (parts.length > 1) dirCount.set(parts[0], (dirCount.get(parts[0]) || 0) + 1);
      }
      for (const [dir, count] of [...dirCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        push(root.id, `${dir}/ (${count})`, `${dir} module, ${count} readable files`, 'claim', {
          isSection: true,
        });
      }

      const docs = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f.path) && !PROJECT_SKIP.test(f.path));
      const plans = docs.filter((f) => /superpowers\/plans\//i.test(f.path));
      const specs = docs.filter((f) => /superpowers\/specs\//i.test(f.path));
      const others = docs.filter((f) => plans.indexOf(f) < 0 && specs.indexOf(f) < 0);

      if (specs.length) {
        const group = push(root.id, `Specs (${specs.length})`, 'Design documents', 'claim', { isSection: true });
        specs.slice(0, 8).forEach((file) => {
          push(group.id, readDocTitle(file.text) || file.path.split('/').pop(), file.path, 'claim');
        });
      }

      if (plans.length) {
        const group = push(root.id, `Plans (${plans.length})`, 'Superpowers implementation plans', 'action', {
          isSection: true,
        });
        plans.slice(0, 6).forEach((file) => {
          const plan = parsePlanClient(file.text);
          const planNode = push(
            group.id,
            readDocTitle(file.text) || file.path.split('/').pop(),
            `${plan.tasks.length} tasks · ${file.path}`,
            'action',
            { isSection: true },
          );
          plan.tasks.slice(0, 8).forEach((task) => {
            push(planNode.id, `Task ${task.id}: ${task.title}`, task.title, 'action');
          });
        });
      }

      if (others.length) {
        const group = push(root.id, `Docs (${others.length})`, 'Markdown documents', 'claim', { isSection: true });
        others.slice(0, 12).forEach((file) => {
          push(group.id, readDocTitle(file.text) || file.path.split('/').pop(), file.path, 'claim');
        });
      }

      if (nodes.length === 1) {
        push(root.id, 'No readable .md or .json files', 'Drop a project folder containing docs', 'question');
      }

      return { title: `${projectName} · project`, nodes };
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
        // Keep a rolling copy of the last good tree list, so a bad write or a
        // cleared key does not mean the trees are gone for good.
        if (key === TREES_KEY && Array.isArray(value) && value.length) {
          localStorage.setItem(BACKUP_KEY, JSON.stringify(value));
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    function loadTrees() {
      const parsed = readJson(TREES_KEY);
      const list = Array.isArray(parsed) ? parsed : readJson(BACKUP_KEY);
      if (!Array.isArray(list)) return [];
      return list
        .filter((t) => t && typeof t.id === 'string' && Array.isArray(t.nodes))
        .map((t) => ({ ...t, nodes: normalizeNodes(t.nodes) }));
    }

    function loadSettings() {
      const parsed = readJson(SETTINGS_KEY) || {};
      const llm = parsed.llm || {};
      // The key is never written to localStorage: it lives for the tab session.
      let key = '';
      try {
        key = window.sessionStorage.getItem(APIKEY_SESSION_KEY) || '';
      } catch (error) {
        key = '';
      }
      return {
        llm: {
          baseUrl: typeof llm.baseUrl === 'string' ? llm.baseUrl : 'https://api.openai.com/v1',
          apiKey: key,
          model: typeof llm.model === 'string' ? llm.model : 'gpt-4o-mini',
        },
        mode: parsed.mode === 'rule' || parsed.mode === 'llm' ? parsed.mode : 'auto',
      };
    }

    function saveSettings(next) {
      const llm = (next && next.llm) || {};
      try {
        window.sessionStorage.setItem(APIKEY_SESSION_KEY, String(llm.apiKey || ''));
      } catch (error) {
        /* private mode: the key simply will not survive a reload */
      }
      writeJson(SETTINGS_KEY, {
        ...next,
        llm: { ...llm, apiKey: '' },
      });
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
      .ttl-root {
        --ttl-serif: "Iowan Old Style", "Palatino Linotype", "Songti SC", "STSong", Georgia, serif;
        --ttl-art: linear-gradient(100deg, #8fb4ff 0%, #c9a6ff 54%, #ff9ec4 100%);
        font-family: var(--ttl-serif);
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        /* The host gives this slot ~990 CSS px while the window has ~1030, so a
           viewport-relative max-width is useless here: fill the slot and let the
           canvas shrink instead. */
        width: 100%; max-width: 100%; min-width: 0;
        max-height: 100%;
        overflow: hidden;
        box-sizing: border-box;
        overflow: hidden;
        background:
          radial-gradient(900px 440px at 82% -10%, rgba(47, 111, 235, 0.16), transparent 62%),
          radial-gradient(700px 400px at 2% 106%, rgba(156, 54, 181, 0.11), transparent 60%),
          var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-label-primary, #1a1a1a);
        font-size: 13px;
      }
      .ttl-bar {
        display: flex; flex-direction: column; align-items: stretch; gap: 6px;
        padding: 8px 14px;
        border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fafafa) 55%, transparent);
        backdrop-filter: blur(18px) saturate(1.35);
        -webkit-backdrop-filter: blur(18px) saturate(1.35);
        flex: none;
      }
      .ttl-bar-row {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        min-width: 0; width: 100%;
      }
      .ttl-bar-row > * { flex-shrink: 0; }
      .ttl-title {
        font-family: var(--ttl-serif);
        font-size: 15px; font-weight: 700; margin-right: 4px;
        letter-spacing: .04em;
        background: var(--ttl-art);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .ttl-sub {
        color: var(--dsw-alias-label-secondary, #666); font-size: 11px;
        max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ttl-spacer { flex: 1; }
      .ttl-btn {
        display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 11%, transparent);
        border-radius: 9px;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 58%, transparent);
        backdrop-filter: blur(10px) saturate(1.2);
        -webkit-backdrop-filter: blur(10px) saturate(1.2);
        color: inherit;
        padding: 6px 11px; font-size: 12px; cursor: pointer; line-height: 1.4;
        white-space: nowrap;
        box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
        transition: border-color .15s ease, background .15s ease, transform .08s ease, box-shadow .15s ease;
      }
      .ttl-btn:hover {
        border-color: color-mix(in srgb, #2f6feb 45%, transparent);
        box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent), 0 2px 8px rgba(0,0,0,.10);
      }
      .ttl-btn:active { transform: translateY(1px); }
      .ttl-btn:focus-visible { outline: 2px solid #2f6feb; outline-offset: 2px; }
      .ttl-btn:disabled { opacity: .45; cursor: not-allowed; }
      .ttl-btn.primary {
        background: #2f6feb; border-color: transparent; color: #fff;
      }
      .ttl-btn.primary:hover { filter: brightness(1.08); }
      .ttl-btn.primary:disabled { background: #9db4e8; }
      .ttl-btn.ghost { background: transparent; border-color: transparent; }
      .ttl-input, .ttl-select, .ttl-textarea {
        border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 11%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 56%, transparent);
        backdrop-filter: blur(12px) saturate(1.25);
        -webkit-backdrop-filter: blur(12px) saturate(1.25);
        color: inherit;
        padding: 7px 10px; font-size: 12px; font-family: inherit;
        box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
        transition: border-color .18s ease, box-shadow .18s ease;
      }
      .ttl-input:focus, .ttl-select:focus, .ttl-textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, #2f6feb 55%, transparent);
        box-shadow:
          0 0 0 3px color-mix(in srgb, #2f6feb 16%, transparent),
          inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent);
      }
      .ttl-textarea {
        resize: vertical; line-height: 1.65;
        border-radius: 14px; padding: 12px 14px;
        backdrop-filter: blur(22px) saturate(1.45);
        -webkit-backdrop-filter: blur(22px) saturate(1.45);
      }
      .ttl-body { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
      .ttl-heat { display: flex; gap: 2px; padding: 0 14px 7px; align-items: flex-end; }
      .ttl-heat-cell { flex: 1; height: 3px; border-radius: 2px; background: #2f6feb; }
      .ttl-side {
        width: 316px; flex: 0 1 316px; min-width: 240px;
        display: flex; flex-direction: column; min-height: 0;
        overflow: hidden;
        border-right: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fafafa) 46%, transparent);
        backdrop-filter: blur(20px) saturate(1.3);
        -webkit-backdrop-filter: blur(20px) saturate(1.3);
      }
      .ttl-side-inner { padding: 12px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
      .ttl-side h4 {
        margin: 0; font-family: var(--ttl-serif);
        font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
        color: var(--dsw-alias-label-secondary, #777); font-weight: 700;
        display: flex; align-items: center; gap: 6px;
      }
      .ttl-side h4::before {
        content: ''; width: 3px; height: 11px; border-radius: 2px;
        background: #2f6feb; display: inline-block; flex: none;
      }
      .ttl-tree-list { display: flex; flex-direction: column; gap: 4px; }
      .ttl-tree-item {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px;
        cursor: pointer; border: 1px solid transparent;
        transition: background .14s ease, border-color .14s ease;
      }
      .ttl-tree-item:hover { background: var(--dsw-alias-bg-layer-2, #f0f1f3); }
      .ttl-tree-item.active {
        border-color: #2f6feb; background: var(--dsw-alias-bg-base, #fff);
        box-shadow: inset 3px 0 0 #2f6feb;
      }
      .ttl-tree-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ttl-tree-item .meta { font-size: 10px; color: var(--dsw-alias-label-secondary, #888); }
      .ttl-canvas {
        flex: 1; position: relative; min-width: 0; overflow: hidden;
        /* Width comes from the root, which is clamped against visualViewport in
           JS. A CSS viewport unit cannot do it: 100vw is the layout viewport and
           the host's page zoom makes it far larger than the visible area. */
        max-width: 100%;
        background-color: transparent;
        background-image: radial-gradient(
          circle,
          color-mix(in srgb, var(--dsw-alias-label-secondary, #999) 24%, transparent) 1px,
          transparent 1px
        );
        background-size: 22px 22px;
        background-position: -1px -1px;
      }
      .ttl-canvas > svg { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
      .ttl-canvas > svg.dragging { cursor: grabbing; }
      .ttl-empty {
        position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
        align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #888);
        text-align: center; padding: 24px; pointer-events: none;
      }
      .ttl-empty strong {
        font-family: var(--ttl-serif);
        font-size: 16px; font-weight: 700; letter-spacing: .04em;
        background: var(--ttl-art);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      /* Pinned to the viewport, not to the panel: the host column is wider than
         what is visible, so an in-flow rail lands off screen. */
      .ttl-detail {
        position: fixed; right: 18px; bottom: 104px; width: 384px; max-height: 70vh; z-index: 60;
        border-radius: 16px;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 12%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fafafa) 82%, transparent);
        backdrop-filter: blur(24px) saturate(1.35);
        -webkit-backdrop-filter: blur(24px) saturate(1.35);
        box-shadow:
          0 24px 60px rgba(0, 0, 0, 0.34),
          inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
        overflow: auto; padding: 14px;
        display: flex; flex-direction: column; gap: 10px;
        animation: ttl-pop 0.18s ease-out;
      }
      @keyframes ttl-pop {
        from { opacity: 0; transform: translateY(10px) scale(0.98); }
        to { opacity: 1; transform: none; }
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
      .ttl-side-inner::-webkit-scrollbar, .ttl-detail::-webkit-scrollbar { width: 8px; }
      .ttl-side-inner::-webkit-scrollbar-thumb,
      .ttl-detail::-webkit-scrollbar-thumb {
        background: var(--dsw-alias-border-l2, #c9ccd3); border-radius: 4px;
      }
      .ttl-side-inner::-webkit-scrollbar-track,
      .ttl-detail::-webkit-scrollbar-track { background: transparent; }
      .ttl-nav-inline {
        display: inline-flex; align-items: center; gap: 1px; padding: 2px;
        border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1, #e0e3e8);
        background: var(--dsw-alias-bg-base, #fff);
      }
      .ttl-nav-inline button {
        width: 26px; height: 23px; display: inline-flex; align-items: center; justify-content: center;
        border: none; border-radius: 7px; background: transparent; color: inherit;
        cursor: pointer; font-size: 12px; line-height: 1;
        transition: background .14s ease;
      }
      .ttl-nav-inline button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #eef0f3); }
      .ttl-nav-inline button:disabled { opacity: .35; cursor: default; }
      .ttl-nav-inline button.warn { color: #e8590c; }
      .ttl-nav-inline button.on { background: #2f6feb; color: #fff; }
      .ttl-hover {
        position: absolute; left: 16px; right: 128px; bottom: 16px;
        max-height: 96px; overflow: hidden;
        padding: 9px 13px; border-radius: 12px; z-index: 4;
        background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #10131a) 88%, transparent);
        backdrop-filter: blur(16px) saturate(1.3);
        -webkit-backdrop-filter: blur(16px) saturate(1.3);
        border: 1px solid color-mix(in srgb, #2f6feb 32%, transparent);
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
        font-size: 11.5px; line-height: 1.55;
        color: var(--dsw-alias-label-primary, #e6e9ef);
        white-space: pre-wrap; pointer-events: none;
      }
      .ttl-dock-wrap {
        display: flex; justify-content: flex-end;
        padding: 0 14px 7px;
        pointer-events: none;
      }
      .ttl-dock {
        pointer-events: auto;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 3px 9px 3px 8px; border-radius: 999px; cursor: pointer;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f7f8fa) 34%, transparent);
        backdrop-filter: blur(14px) saturate(1.35);
        -webkit-backdrop-filter: blur(14px) saturate(1.35);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 9%, transparent);
        box-shadow:
          inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent),
          0 3px 12px rgba(0, 0, 0, 0.14);
        font-size: 10.5px; line-height: 1;
        color: var(--dsw-alias-label-secondary, #6b7280);
        transition: border-color .16s ease, box-shadow .16s ease, transform .12s ease;
      }
      .ttl-dock:hover {
        border-color: color-mix(in srgb, #2f6feb 55%, transparent);
        box-shadow:
          inset 0 1px 0 color-mix(in srgb, #fff 16%, transparent),
          0 6px 20px rgba(47, 111, 235, 0.22);
        transform: translateY(-1px);
      }
      .ttl-dock-icon { display: flex; color: #7aa2ff; }
      .ttl-dock-brand {
        font-family: var(--ttl-serif);
        font-size: 12px; font-weight: 700; letter-spacing: .05em;
        background: var(--ttl-art);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .ttl-dock-sep { opacity: .35; }
      .ttl-dock-count { font-variant-numeric: tabular-nums; }
      .ttl-dock-warn { color: #e8590c; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ttl-dock-score { font-weight: 700; font-variant-numeric: tabular-nums; }
      .ttl-dock-idle { color: #e8590c; font-variant-numeric: tabular-nums; }
      .ttl-dock-open { color: #2f6feb; font-weight: 700; }
      .ttl-review {
        display: flex; flex-direction: column; gap: 5px;
        padding: 9px 11px; border-radius: 11px;
        background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 55%, transparent);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
      }
      .ttl-review-head {
        font-family: var(--ttl-serif); font-size: 10px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--dsw-alias-label-secondary, #888);
      }
      .ttl-review-row { display: flex; gap: 7px; font-size: 11px; line-height: 1.55; }
      .ttl-review-tag { flex: none; width: 36px; font-weight: 700; }
      .ttl-review-row.pros .ttl-review-tag { color: #37b24d; }
      .ttl-review-row.cons .ttl-review-tag { color: #e8590c; }
      .ttl-review-row.next .ttl-review-tag { color: #2f6feb; }
      .ttl-rewrite { font-size: 11px; line-height: 1.6; white-space: pre-wrap; }
      .ttl-actions {
        display: flex; flex-wrap: wrap; gap: 6px; padding-top: 8px;
        border-top: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
      }
      .ttl-actions .ttl-btn { flex: 1 1 auto; justify-content: center; }
      .ttl-deep-body { font-size: 11px; line-height: 1.65; white-space: pre-wrap; }
      .ttl-review-tag-note {
        margin-left: 6px; font-size: 9px; font-weight: 400;
        letter-spacing: 0; opacity: 0.6; text-transform: none;
      }
      .ttl-score { margin-left: auto; font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; }
      .ttl-deep {
        padding: 9px 11px; border-radius: 11px; font-size: 11px; line-height: 1.6;
        white-space: pre-wrap;
        background: color-mix(in srgb, #2f6feb 10%, transparent);
        border: 1px solid color-mix(in srgb, #2f6feb 30%, transparent);
      }
      .ttl-nav {
        position: absolute; right: 16px; bottom: 16px; display: flex; gap: 6px;
        padding: 6px; border-radius: 12px; z-index: 3;
        background: var(--dsw-alias-bg-overlay, #fff);
        border: 1px solid var(--dsw-alias-border-l1, #e0e3e8);
        box-shadow: 0 6px 20px rgba(0,0,0,.14);
      }
      .ttl-nav button {
        width: 30px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
        border: none; border-radius: 8px; background: transparent; color: inherit;
        cursor: pointer; font-size: 13px; line-height: 1;
        transition: background .14s ease, color .14s ease;
      }
      .ttl-nav button:hover { background: var(--dsw-alias-bg-layer-2, #eef0f3); }
      .ttl-nav button.warn { color: #e8590c; }
      .ttl-empty svg { width: 56px; height: 56px; opacity: .5; }
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
     * Composer dock — the plugin's result, visible inside the chat
     * ------------------------------------------------------------------ */

    /**
     * A one-line summary of the latest thought tree, rendered under the composer
     * so you can see what the plugin produced without leaving the conversation.
     */
    function DockBar(props) {
      const [trees, setTrees] = useState(() => loadTrees());

      useEffect(() => {
        const refresh = () => setTrees(loadTrees());
        window.addEventListener('ttl:trees', refresh);
        window.addEventListener('storage', refresh);
        return () => {
          window.removeEventListener('ttl:trees', refresh);
          window.removeEventListener('storage', refresh);
        };
      }, []);

      // Expose the composer handle so the panel can hand an annotation over
      // instead of only copying it. Method names differ across builds, so probe.
      useEffect(() => {
        const api = props.inputActions;
        if (!api) return undefined;
        window.__ttlCompose = (text) => {
          for (const name of ['setText', 'setValue', 'replaceText', 'insertText', 'append']) {
            try {
              if (typeof api[name] === 'function') {
                api[name](text);
                return true;
              }
            } catch (error) {
              /* try the next name */
            }
          }
          return false;
        };
        return () => {
          try {
            delete window.__ttlCompose;
          } catch (error) {
            /* ignore */
          }
        };
      }, [props.inputActions]);

      const latest = trees[0];
      const issues = useMemo(() => {
        if (!latest || !latest.nodes || !latest.nodes.length) return 0;
        // A workspace tree is an analysis, not a reasoning chain: it has no
        // findings, and linting it produced absurd counts (131).
        if (latest.extractor === 'workspace') return 0;
        try {
          if (latest.extractor === 'plan') {
            // Plan findings are per task; a big plan would show a scary number.
            return Math.min(lintPlanClient(parsePlanClient(latest.source || '')).length, 99);
          }
          return lintTree(latest.nodes).length;
        } catch (error) {
          return 0;
        }
      }, [latest]);

      if (!latest) return null;

      return h(
        React.Fragment,
        null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'ttl-dock-wrap' },
          h(
          'div',
          {
            className: 'ttl-dock',
            role: 'button',
            tabIndex: 0,
            title: `${latest.title} · ${latest.nodes.length} 节点${issues ? ` · ${issues} 个问题` : ''} · 打开面板`,
            onClick: () => props.open && props.open(),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (props.open) props.open();
              }
            },
          },
          h(
            'span',
            { className: 'ttl-dock-icon' },
            h(
              'svg',
              {
                width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
                stroke: 'currentColor', strokeWidth: 2,
                strokeLinecap: 'round', strokeLinejoin: 'round',
                'aria-hidden': true,
              },
              h('path', { d: 'M6 3.5v17' }),
              h('path', { d: 'M6 8h5' }),
              h('path', { d: 'M6 16h5' }),
              h('circle', { cx: 14.5, cy: 8, r: 2.2 }),
              h('circle', { cx: 14.5, cy: 16, r: 2.2 }),
            ),
          ),
          h('span', { className: 'ttl-dock-brand' }, '思维树'),
          h('span', { className: 'ttl-dock-sep' }, '·'),
          h('span', { className: 'ttl-dock-count' }, `${latest.nodes.length}`),
          latest.averageScore
            ? h('span', {
                className: 'ttl-dock-score',
                style: {
                  color:
                    latest.averageScore >= 70 ? '#37b24d' : latest.averageScore >= 45 ? '#e8590c' : '#e03131',
                },
                title: '这次工作里提问的平均结构分',
              }, `${latest.averageScore}`)
            : null,
          (() => {
            const idleHours = latest.lastAt
              ? Math.floor((Date.now() - latest.lastAt) / 3600000)
              : null;
            if (idleHours === null || idleHours < 4) return null;
            return h('span', {
              className: 'ttl-dock-idle',
              title: '距上次推进已经过去这么久',
            }, `${idleHours}h`);
          })(),
          issues ? h('span', { className: 'ttl-dock-warn' }, `${issues} 问题`) : null,
          h('span', { className: 'ttl-dock-open' }, '→'),
        ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Tree canvas
     * ------------------------------------------------------------------ */

    function TreeCanvas(props) {
      const {
        nodes, selectedId, onSelect, query, typeFilter, cutoff,
        onAddChild, layoutRef, findings, apiRef, focusMode, onJumpToChat,
      } = props;

      const svgRef = useRef(null);
      const [view, setView] = useState({ x: 0, y: 0, w: 800, h: 600 });
      const viewRef = useRef(view);
      viewRef.current = view;
      const rafRef = useRef(0);
      const issueCursor = useRef(-1);
      const [drag, setDrag] = useState(null);
      const [hoverNote, setHoverNote] = useState('');
      const fittedRef = useRef('');

      const layout = useMemo(() => computeLayout(nodes), [nodes]);
      const maxDepth = useMemo(
        () => layout.nodes.reduce((deepest, entry) => Math.max(deepest, entry.depth), 0),
        [layout],
      );

      // Real content extent. layout.width/height include padding on both sides,
      // so centring on them left a visible empty band on the left.
      const bounds = useMemo(() => {
        if (!layout.nodes.length) {
          return { minX: 0, maxX: Math.max(1, layout.width), minY: 0, maxY: Math.max(1, layout.height) };
        }
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const entry of layout.nodes) {
          minX = Math.min(minX, entry.x);
          maxX = Math.max(maxX, entry.x + NODE_W);
          minY = Math.min(minY, entry.y);
          maxY = Math.max(maxY, entry.y + NODE_H);
        }
        return { minX, maxX, minY, maxY };
      }, [layout]);

      useEffect(() => {
        if (layoutRef) layoutRef.current = layout;
      }, [layout, layoutRef]);

      // Fit whenever the topology changes shape. The first node's timestamp makes
      // two trees with identical geometry still re-fit when you switch between them.
      const signature = `${layout.width}x${layout.height}x${nodes.length}x${nodes[0] ? nodes[0].createdAt : 0}`;

      /**
       * Frame the tree inside whatever box the canvas currently reports.
       *
       * Measured against the real node extent, not layout.width (which carries
       * padding), and driven by the element's own size so it stays correct after
       * the host finishes laying the slot out — the first measurement often runs
       * before that, which is what left the tree off-centre.
       */
      const computeFrame = useCallback((minScale = 0) => {
        const el = svgRef.current;
        const box = el ? el.getBoundingClientRect() : { width: 800, height: 600 };
        const availW = Math.max(120, box.width || 0);
        const availH = Math.max(120, box.height || 0);
        const contentW = Math.max(1, bounds.maxX - bounds.minX);
        const contentH = Math.max(1, bounds.maxY - bounds.minY);
        // Width only: height-bound fitting shrank a 24-node tree to 0.4 and made
        // every label unreadable. Vertical overflow is panned instead.
        const fitScale = availW / contentW;
        const scale = Math.max(minScale, Math.min(fitScale, 1.1));
        const w = availW / scale;
        const h = availH / scale;
        return {
          x: bounds.minX + contentW / 2 - w / 2,
          y: bounds.minY + contentH / 2 - h / 2,
          w,
          h,
        };
      }, [bounds]);

      const frameTree = useCallback(() => {
        // Open at a readable scale even if that means panning; 0.75 * 12.8px is
        // about 9.6px, which is the smallest this label font stays legible at.
        setView(computeFrame(0.75));
      }, [computeFrame]);

      useEffect(() => {
        if (fittedRef.current === signature) return;
        fittedRef.current = signature;
        frameTree();
      }, [signature, frameTree]);

      // Re-frame when the canvas itself changes size: the host lays the slot out
      // after the first paint, so an early fit is aimed at the wrong box.
      useEffect(() => {
        const el = svgRef.current;
        if (!el || typeof ResizeObserver !== 'function') return undefined;
        let last = '';
        const observer = new ResizeObserver((entries) => {
          const entry = entries && entries[0];
          const box = entry && entry.contentRect;
          if (!box || box.width < 80) return;
          const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
          if (key === last) return;
          last = key;
          frameTree();
        });
        observer.observe(el);
        return () => observer.disconnect();
      }, [frameTree]);

      const visibleIds = useMemo(() => {
        const sorted = [...nodes].sort((a, b) => a.createdAt - b.createdAt);
        return new Set(sorted.slice(0, cutoff).map((n) => n.id));
      }, [nodes, cutoff]);

      const highlightIds = useMemo(() => {
        if (!selectedId) return new Set();
        return new Set(pathTo(layout.graph, selectedId).map((n) => n.id));
      }, [layout.graph, selectedId]);

      // Focus mode keeps the selected path and its immediate children lit.
      const focusedIds = useMemo(() => {
        if (!focusMode || !selectedId) return null;
        const set = new Set(highlightIds);
        for (const childId of layout.graph.childrenOf.get(selectedId) || []) set.add(childId);
        return set;
      }, [focusMode, selectedId, highlightIds, layout.graph]);

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

      /* ---- Fly-to navigation -------------------------------------- */

      const animateTo = useCallback((target) => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        const from = { ...viewRef.current };
        const start = performance.now();
        const frame = (now) => {
          const t = Math.min(1, (now - start) / 340);
          const ease = 1 - Math.pow(1 - t, 3);
          setView({
            x: from.x + (target.x - from.x) * ease,
            y: from.y + (target.y - from.y) * ease,
            w: from.w + (target.w - from.w) * ease,
            h: from.h + (target.h - from.h) * ease,
          });
          if (t < 1) rafRef.current = requestAnimationFrame(frame);
        };
        rafRef.current = requestAnimationFrame(frame);
      }, []);

      const focusNode = useCallback((id, force) => {
        const entry = layout.nodes.find((n) => n.node.id === id);
        if (!entry) return;
        const v = viewRef.current;
        const cx = entry.x + NODE_W / 2;
        const cy = entry.y + NODE_H / 2;
        const dx = Math.abs(cx - (v.x + v.w / 2));
        const dy = Math.abs(cy - (v.y + v.h / 2));
        // Only fly when the target is actually off-centre.
        if (!force && dx < v.w * 0.16 && dy < v.h * 0.16) return;
        animateTo({ x: cx - v.w / 2, y: cy - v.h / 2, w: v.w, h: v.h });
      }, [layout, animateTo]);

      const selectAndFocus = useCallback((id) => {
        onSelect(id);
        focusNode(id);
      }, [onSelect, focusNode]);

      const jumpIssue = useCallback((dir) => {
        const list = (findings || []).filter((f) => f.nodeId).map((f) => f.nodeId);
        if (!list.length) return;
        issueCursor.current = (issueCursor.current + dir + list.length) % list.length;
        const id = list[issueCursor.current];
        onSelect(id);
        focusNode(id, true);
      }, [findings, onSelect, focusNode]);

      const fitAll = useCallback(() => {
        // The ⤢ button is the "see everything" view: no readable-scale floor.
        animateTo(computeFrame(0));
      }, [computeFrame, animateTo]);

      // Expose the navigation controls so the toolbar can drive them too.
      useEffect(() => {
        if (!apiRef) return;
        apiRef.current = { focusNode, jumpIssue, fitAll, selectAndFocus };
      }, [apiRef, focusNode, jumpIssue, fitAll, selectAndFocus]);

      // Keyboard roaming: ←/↑ up, →/↓ down, Home to root, Enter to centre.
      useEffect(() => {
        const onKey = (event) => {
          if (!selectedId) return;
          const tag = (event.target && event.target.tagName) || '';
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

          const graph = layout.graph;
          const node = graph.nodeMap.get(selectedId);
          if (!node) return;

          const kids = graph.childrenOf.get(selectedId) || [];
          const siblings = node.parentId
            ? (graph.childrenOf.get(node.parentId) || [])
            : graph.roots;
          const idx = siblings.indexOf(selectedId);

          let next = null;
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            next = kids[0] || siblings[idx + 1] || null;
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            next = node.parentId;
          } else if (event.key === 'Home') {
            next = graph.roots[0] || null;
          } else if (event.key === 'Enter') {
            event.preventDefault();
            focusNode(selectedId, true);
            return;
          } else {
            return;
          }

          if (next) {
            event.preventDefault();
            onSelect(next);
            focusNode(next);
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [selectedId, layout, focusNode, onSelect]);

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
        // 2px was tight enough that a shaky click counted as a pan and the node
        // never got selected — which read as "clicking does nothing".
        if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
        setView((prev) => ({ ...prev, x: drag.vx - dx, y: drag.vy - dy }));
      };

      const onPointerUp = () => setDrag(null);

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
          h(
            'defs',
            null,
            h('filter', { id: 'ttl-shadow', x: '-30%', y: '-30%', width: '160%', height: '170%' },
              h('feDropShadow', { dx: '0', dy: '2', stdDeviation: '3', floodColor: '#000', floodOpacity: '0.24' }),
            ),
            h('filter', { id: 'ttl-glow', x: '-45%', y: '-45%', width: '190%', height: '190%' },
              h('feDropShadow', { dx: '0', dy: '0', stdDeviation: '5', floodColor: '#2f6feb', floodOpacity: '0.9' }),
            ),
          ),
          // Depth lanes: a faint band per level so the tree reads as layers, not spaghetti.
          h(
            'g',
            { className: 'ttl-swim' },
            Array.from({ length: maxDepth + 1 }, (_, depth) =>
              depth % 2 === 0
                ? h('rect', {
                    key: `swim-${depth}`,
                    x: PAD + depth * COL_W - 30,
                    y: 0,
                    width: COL_W,
                    height: layout.height + 200,
                    rx: 22,
                    fill: 'rgba(122, 162, 255, 0.03)',
                  })
                : null,
            ),
          ),
          // Links first so nodes paint on top.
          h(
            'g',
            null,
            layout.links.map((link) => {
              const onPath = highlightIds.has(link.target.node.id) && highlightIds.has(link.source.node.id);
              const dim = !visibleIds.has(link.target.node.id) || !matches(link.target.node);
              const linkColor = (TYPE_META[link.target.node.type] || TYPE_META.claim).color;
              return h('path', {
                key: link.id,
                d: link.d,
                fill: 'none',
                stroke: onPath ? '#2f6feb' : withAlpha(linkColor, dim ? 0.08 : 0.24),
                strokeWidth: onPath ? 2 : 1,
                strokeDasharray: dim ? '4 5' : undefined,
                opacity: dim ? 0.4 : 0.95,
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
              const muted = !visible || rejected;
              const dimmed = focusedIds && !focusedIds.has(node.id);
              const isRoot = node.parentId === null;

              return h(
                'g',
                {
                  key: node.id,
                  transform: `translate(${entry.x}, ${entry.y})`,
                  style: {
                    cursor: 'pointer',
                    opacity: hit ? (dimmed ? 0.1 : 1) : 0.22,
                    transition: 'opacity .2s ease',
                  },
                  onClick: (event) => {
                    if (drag && drag.moved) return;
                    event.stopPropagation();
                    selectAndFocus(node.id);
                  },
                  onDoubleClick: (event) => {
                    event.stopPropagation();
                    // Always go through the jump handler: it knows how to explain
                    // a node that has no source message.
                    if (onJumpToChat) {
                      onJumpToChat(node);
                      return;
                    }
                    if (onAddChild) onAddChild(node.id);
                  },
                  onMouseEnter: () => {
                    const parts = [];
                    if (node.note) parts.push(node.note);
                    if (node.review) {
                      if ((node.review.pros || []).length) {
                        parts.push(`✓ 优点　${node.review.pros.join(' · ')}`);
                      }
                      if ((node.review.cons || []).length) {
                        parts.push(`! 不足　${node.review.cons.join(' · ')}`);
                      }
                      if ((node.review.next || []).length) {
                        parts.push(`→ 下一步　${node.review.next.join(' · ')}`);
                      }
                    }
                    if (node.annotation) parts.push(`✎ 我的批注　${node.annotation}`);
                    setHoverNote(parts.join('\n'));
                  },
                  onMouseLeave: () => setHoverNote(''),
                },
                // Card surface, then a colour wash, then the border.
                h('rect', {
                  width: NODE_W, height: NODE_H, rx: 15,
                  fill: 'var(--dsw-alias-bg-layer-1, #16181d)',
                  filter: selected ? 'url(#ttl-glow)' : 'url(#ttl-shadow)',
                }),
                h('rect', {
                  width: NODE_W, height: NODE_H, rx: 15,
                  fill: withAlpha(meta.color, muted ? 0.04 : isRoot ? 0.17 : 0.10),
                }),
                h('rect', {
                  width: NODE_W, height: NODE_H, rx: 15, fill: 'none',
                  stroke: rejected
                    ? '#e03131'
                    : withAlpha(meta.color, selected ? 1 : muted ? 0.16 : isRoot ? 0.6 : 0.32),
                  strokeWidth: selected ? 2 : isRoot ? 1.5 : 1,
                  strokeDasharray: rejected ? '5 4' : undefined,
                }),
                // Type spine.
                h('rect', {
                  x: 0, y: 13, width: 3.5, height: NODE_H - 26, rx: 2,
                  fill: meta.color, opacity: muted ? 0.45 : 1,
                }),
                h('text', {
                  x: 16, y: 30,
                  fill: 'var(--dsw-alias-label-primary, #eceff4)',
                  fontSize: isRoot ? 13.5 : 12.8, fontWeight: 600,
                  style: { pointerEvents: 'none' },
                }, truncate(node.label, 14)),
                h('text', {
                  x: 16, y: 51,
                  fill: withAlpha(meta.color, muted ? 0.65 : 0.95),
                  fontSize: 10, fontWeight: 600,
                  style: { pointerEvents: 'none' },
                }, meta.label),
                h('text', {
                  x: 16 + meta.label.length * 10.5 + 8, y: 51,
                  fill: 'var(--dsw-alias-label-secondary, #8b93a1)',
                  fontSize: 9.5,
                  style: { pointerEvents: 'none' },
                }, `${Math.round(node.confidence * 100)}%`),
                accepted
                  ? h('circle', { cx: NODE_W - 12, cy: 12, r: 3.2, fill: '#0ca678' })
                  : null,
                node.branchId && node.branchId !== DEFAULT_BRANCH
                  ? h('circle', {
                      cx: NODE_W - 12, cy: 12, r: 3.2,
                      fill: BRANCH_PALETTE[Math.abs(hashCode(node.branchId)) % BRANCH_PALETTE.length],
                    })
                  : null,
              );
            }),
          ),
        ),
        layout.nodes.length
          ? h(
              'div',
              { className: 'ttl-nav' },
              h('button', {
                title: '回到根节点 (Home)',
                onClick: () => {
                  const rootId = layout.graph.roots[0];
                  if (rootId) { onSelect(rootId); focusNode(rootId, true); }
                },
              }, '⌂'),
              h('button', {
                title: '上一个问题',
                className: 'warn',
                disabled: !(findings || []).some((f) => f.nodeId),
                onClick: () => jumpIssue(-1),
              }, '▲'),
              h('button', {
                title: '下一个问题',
                className: 'warn',
                disabled: !(findings || []).some((f) => f.nodeId),
                onClick: () => jumpIssue(1),
              }, '▼'),
              h('button', {
                title: '居中当前节点 (Enter)',
                disabled: !selectedId,
                onClick: () => selectedId && focusNode(selectedId, true),
              }, '◎'),
              h('button', { title: '适应画布', onClick: fitAll }, '⤢'),
            )
          : null,
        hoverNote
          ? h('div', { className: 'ttl-hover' }, hoverNote)
          : null,
        layout.nodes.length === 0
          ? h(
              'div',
              { className: 'ttl-empty' },
              h(
                'svg',
                { width: 64, height: 64, viewBox: '0 0 24 24', fill: 'none',
                  stroke: 'currentColor', strokeWidth: 1.2,
                  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
                h('path', { d: 'M6 3.5v17' }),
                h('path', { d: 'M6 8h5' }),
                h('path', { d: 'M6 16h5' }),
                h('circle', { cx: 14.5, cy: 8, r: 2.2 }),
                h('circle', { cx: 14.5, cy: 16, r: 2.2 }),
                h('circle', { cx: 20.5, cy: 12, r: 1.6 }),
              ),
              h('strong', null, '还没有思维树'),
              h('div', null, '点「分析工作区」，或粘贴一段对话'),
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

    /**
     * The same review rules the Host applies, run in the panel.
     *
     * A tree saved before the Host grew reviews has no `review` on its nodes; this
     * keeps the detail panel complete instead of silently dropping two sections.
     */
    function localReview(node) {
      const value = `${node.label || ''} ${node.text || ''}`;
      const pros = [];
      const cons = [];

      if (/\d+/.test(value)) pros.push('带了具体数字或规模');
      if (/优先|取舍|权衡|tradeoff/i.test(value)) pros.push('有取舍意识，不是全都要');
      if (/因为|所以|由于|因此/.test(value)) pros.push('给了理由，不只是下结论');
      if (/不要|避免|别|除了/.test(value)) pros.push('划了边界，说明不做什么');
      if (value.length >= 40) pros.push('描述足够完整，场景能还原');
      if (!pros.length) pros.push('意图清楚，方向可辨');

      if (value.length < 20) cons.push('信息量偏少，缺上下文');
      if (!/(完成|验收|跑通|通过|输出|能用)/.test(value)) {
        cons.push('没有验收标准，"做完"无法判断');
      }
      if (/同时|以及|还有|顺便/.test(value)) cons.push('塞了多个目标，容易只做一半');
      if (!cons.length) cons.push('缺少明确的下一步指向');

      const next =
        node.type === 'conclusion'
          ? ['把这条结论写成一句可验证的话', '标出它依赖哪个前提']
          : ['写一句“完成时能跑通什么”', '拆成 30 分钟以内的一步'];

      let score = 50;
      if (/\d+/.test(value)) score += 10;
      if (/(完成|验收|跑通|通过|输出|能用)/.test(value)) score += 14;
      if (value.length >= 40) score += 8;
      if (/同时|以及|还有|顺便/.test(value)) score -= 12;
      score = Math.max(10, Math.min(98, score));

      return {
        pros,
        cons,
        next,
        score,
        rewrite: `「${truncate(value, 34)}」\n验收：完成时能跑通一个具体场景。\n约束：只改一处，其余保持不动。`,
        local: true,
      };
    }

    function NodeDetail(props) {
      const { node, graph, onUpdate, onBranch, onAddChild, onDelete, onClose, onPublish, onDeepReview, onAddInnovation, onJump } = props;
      const [deep, setDeep] = useState('');
      const [deepBusy, setDeepBusy] = useState(false);
      const meta = TYPE_META[node.type] || TYPE_META.claim;
      const path = pathTo(graph, node.id);
      // A tree saved before the Host grew reviews has no usable review on its
      // nodes; `{}` would slip past `||`, so check for the score.
      const review =
        node.review && typeof node.review.score === 'number' ? node.review : localReview(node);

      return h(
        'aside',
        { className: 'ttl-detail' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'ttl-badge', style: { background: meta.color } }, meta.label),
          h('span', {
            className: 'ttl-score',
            style: {
              color: review.score >= 70 ? '#37b24d' : review.score >= 45 ? '#e8590c' : '#e03131',
            },
            title: '结构分：有没有数字、验收、理由、是否收敛',
          }, `${review.score}`),
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

        // One-click path that does not depend on double-click at all.
        node.messageText
          ? h('button', {
              className: 'ttl-btn primary',
              style: { justifyContent: 'center' },
              onClick: () => onJump && onJump(node),
              title: '跳到对话里的这条提问',
            }, '→ 去对话中的这条')
          : h('div', { className: 'ttl-hint' }, '这是汇总节点，没有对应的单条消息'),

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

        h('div', { className: 'ttl-chips' },
          node.skill ? h('span', { className: 'ttl-chip' }, `技能 · ${node.skill}`) : null,
          node.virtual ? h('span', { className: 'ttl-chip' }, '创新') : null,
        ),

        h(
          'div',
          { className: 'ttl-review' },
          h('div', { className: 'ttl-review-head' },
            '节点评价',
            review.local ? h('span', { className: 'ttl-review-tag-note' }, '面板本地估算') : null,
          ),
          h('div', { className: 'ttl-review-row pros' },
            h('span', { className: 'ttl-review-tag' }, '优点'),
            h('span', null, (review.pros || []).join('；') || '—'),
          ),
          h('div', { className: 'ttl-review-row cons' },
            h('span', { className: 'ttl-review-tag' }, '不足'),
            h('span', null, (review.cons || []).join('；') || '—'),
          ),
          h('div', { className: 'ttl-review-row next' },
            h('span', { className: 'ttl-review-tag' }, '下一步'),
            h('span', null, (review.next || []).join('；') || '—'),
          ),
        ),

        h(
          'div',
          { className: 'ttl-review' },
          h('div', { className: 'ttl-review-head' }, '改写建议'),
          h('div', { className: 'ttl-rewrite' }, review.rewrite || '—'),
        ),

        h('label', { className: 'ttl-hint' }, '我的批注'),
        h('textarea', {
          className: 'ttl-textarea',
          rows: 2,
          value: node.annotation || '',
          placeholder: '给这个节点写一句批注…',
          onChange: (e) => onUpdate(node.id, { annotation: e.target.value }),
        }),
        h('div', { className: 'row' },
          h('button', {
            className: 'ttl-btn',
            disabled: !node.annotation,
            onClick: () => onPublish && onPublish(node.id),
            title: '把批注写进输入框（或复制到剪贴板）',
          }, '发布批注'),
          node.skill
            ? h('button', {
                className: 'ttl-btn',
                onClick: () => {
                  try {
                    navigator.clipboard.writeText(`Use ${node.skill}`);
                  } catch (err) {
                    /* ignore */
                  }
                },
                title: `复制「Use ${node.skill}」`,
              }, node.skill)
            : null,
        ),

        h('div', { className: 'row' },
          h('button', {
            className: 'ttl-btn',
            disabled: deepBusy,
            onClick: async () => {
              setDeepBusy(true);
              try {
                setDeep(await onDeepReview(node.id));
              } catch (err) {
                setDeep(`失败：${(err && err.message) || err}`);
              } finally {
                setDeepBusy(false);
              }
            },
            title: '用你在设置里配置的模型做一次内容评审',
          }, deepBusy ? 'AI 评注中…' : 'AI 评注'),
          deep ? h('button', { className: 'ttl-btn ghost', onClick: () => setDeep('') }, '清除') : null,
        ),
        deep
          ? h(
              'div',
              { className: 'ttl-deep' },
              h('div', { className: 'ttl-review-head' }, 'AI 评注'),
              h('div', { className: 'ttl-deep-body' }, deep),
            )
          : null,

        h('div', { className: 'ttl-actions' },
          h('button', { className: 'ttl-btn', onClick: () => onAddChild(node.id) }, '＋ 子节点'),
          onAddInnovation
            ? h('button', {
                className: 'ttl-btn',
                onClick: () => onAddInnovation(node.id),
                title: '在这个节点下面挂一个创新想法',
              }, '＋ 创新')
            : null,
          h('button', { className: 'ttl-btn', onClick: () => onBranch(node.id) }, '⑂ 分支'),
          h('button', {
            className: 'ttl-btn danger',
            onClick: () => onDelete(node.id),
          }, '删除'),
        ),

        h('div', { className: 'ttl-hint' },
          '双击节点可跳回对话里那条消息；拖拽平移，滚轮缩放。'),
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

    /**
     * The CSS width the panel may actually occupy.
     *
     * On this host innerWidth reports 1282 while the window is 1295 physical px
     * at devicePixelRatio 1.25 — only ~1036 CSS px actually exist. innerWidth,
     * documentElement.clientWidth and visualViewport all report the layout
     * viewport, so take the smallest plausible candidate; outerWidth follows the
     * real window.
     */
    function visibleViewportWidth() {
      const doc = typeof document !== 'undefined' ? document.documentElement : null;
      const candidates = [
        doc ? doc.clientWidth : 0,
        window.innerWidth || 0,
        window.outerWidth || 0,
        window.screen ? window.screen.availWidth || 0 : 0,
      ].filter((value) => Number.isFinite(value) && value > 400);
      if (!candidates.length) return 1200;
      return Math.min(...candidates);
    }

    function Panel(props) {
      // Load storage once, not twice: loadTrees normalises every tree and this
      // used to run again for the currentId initialiser.
      const bootstrap = useRef(null);
      if (bootstrap.current === null) {
        const loaded = loadTrees();
        bootstrap.current = {
          trees: loaded,
          currentId: loaded.length ? loaded[0].id : '',
        };
      }
      const [trees, setTrees] = useState(bootstrap.current.trees);
      const [currentId, setCurrentId] = useState(bootstrap.current.currentId);
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
      const [focusMode, setFocusMode] = useState(false);
      const [sessionOptions, setSessionOptions] = useState([]);
      const [targetSession, setTargetSession] = useState('');

      const refreshSessions = useCallback(() => {
        fetch('http://127.0.0.1:17866/sessions', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!data || !data.ok || !Array.isArray(data.workspaces)) return;
            const flat = [];
            data.workspaces.forEach((workspace) => {
              (workspace.sessions || []).forEach((session) => {
                flat.push({
                  id: session.id,
                  label: session.title || session.id.replace(/^session-/, '').slice(0, 10),
                  mtime: session.mtime || 0,
                });
              });
            });
            flat.sort((a, b) => b.mtime - a.mtime);
            setSessionOptions(flat.slice(0, 30));
          })
          .catch(() => {
            /* Host bridge not up yet */
          });
      }, []);

      // Refresh when the panel is opened and after each analysis, otherwise a
      // conversation started in this tab never appears in the picker.
      useEffect(() => {
        refreshSessions();
      }, [refreshSessions]);

      const layoutRef = useRef(null);
      const canvasApi = useRef(null);
      const rootRef = useRef(null);

      /**
       * The host hands this slot a box wider than the window (measured: ~990 CSS
       * px starting at x=286, where the window is ~1030 wide), so everything to
       * the right of ~740px is clipped — the tree, the export row, the detail
       * rail. Percentage widths cannot fix that because the parent is already
       * too wide; measure the real viewport and clamp here.
       */
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;

        const apply = () => {
          // Measure with the clamp released, otherwise the second run measures
          // the already-clamped box and the width collapses step by step.
          const previousWidth = el.style.maxWidth;
          const previousHeight = el.style.height;
          el.style.maxWidth = 'none';
          el.style.height = 'auto';

          const rect = el.getBoundingClientRect();
          const parent = el.parentElement;
          const parentBox = parent ? parent.getBoundingClientRect() : null;

          // The host's page zoom makes innerWidth report layout px, not visible
          // px, so ask the smallest plausible candidate instead.
          const visibleWidth = visibleViewportWidth();

          el.style.maxWidth = previousWidth || '';
          el.style.height = previousHeight || '';

          const parentRight =
            parentBox && parentBox.width > 0 ? parentBox.left + parentBox.width : visibleWidth;
          const rightEdge = Math.min(visibleWidth, parentRight);

          const avail = Math.max(280, rightEdge - rect.left - 8);
          const parentHeight =
            parentBox && parentBox.height > 0 ? parentBox.height : Infinity;
          const visibleHeight = window.innerHeight || 800;
          const availHeight = Math.max(
            320,
            Math.min(visibleHeight - rect.top - 8, parentHeight),
          );

          el.style.maxWidth = `${Math.round(avail)}px`;
          el.style.height = `${Math.round(availHeight)}px`;
        };

        apply();
        window.addEventListener('resize', apply);
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(apply)
          : setTimeout(apply, 16);
        const timer = setTimeout(apply, 300);
        return () => {
          window.removeEventListener('resize', apply);
          if (typeof cancelAnimationFrame === 'function' && typeof raf === 'number') {
            cancelAnimationFrame(raf);
          }
          clearTimeout(timer);
        };
      }, []);

      const current = useMemo(
        () => trees.find((t) => t.id === currentId) || null,
        [trees, currentId],
      );
      const nodes = current ? current.nodes : [];
      const graph = useMemo(() => buildGraph(nodes), [nodes]);
      const selected = selectedId ? graph.nodeMap.get(selectedId) : null;
      const findings = useMemo(() => {
        if (!nodes.length) return [];
        // Workspace trees are an analysis, not a reasoning chain — no lint noise.
        if (current && current.extractor === 'workspace') return [];
        // Plan trees carry their own rule set: interface drift, missing checks.
        if (current && current.extractor === 'plan') {
          return lintPlanClient(parsePlanClient(current.source || ''));
        }
        return lintTree(nodes);
      }, [nodes, current]);
      const errorCount = findings.filter((f) => f.severity === 'error').length;

      useEffect(() => {
        saveSettings(settings);
      }, [settings]);

      useEffect(() => {
        if (currentId && !trees.some((t) => t.id === currentId)) {
          setCurrentId(trees.length ? trees[0].id : '');
        }
      }, [trees, currentId]);

      const persist = useCallback((next) => {
        // Never let an empty write erase what is stored: that is how a working
        // tree list turns into "已保存的思维树 (0)" and never comes back.
        if (!Array.isArray(next) || (next.length === 0 && trees.length > 0)) {
          setError('拒绝写入空列表：这会清掉已保存的树。请用每棵树上的 ✕ 删除。');
          return;
        }
        setTrees(next);
        if (!writeJson(TREES_KEY, next)) {
          setError('保存失败：浏览器本地存储已满，删掉一些树或缩短内容后再试');
        }
        window.dispatchEvent(new CustomEvent('ttl:trees'));
      }, [trees]);

      const patchCurrent = useCallback(
        (patch) => {
          const next = trees.map((t) =>
            t.id === currentId ? { ...t, ...patch, updatedAt: Date.now() } : t,
          );
          setTrees(next);
          // Side effects belong outside the updater: React may call it twice.
          if (!writeJson(TREES_KEY, next)) {
            setError('保存失败：浏览器本地存储已满，删掉一些树或缩短内容后再试');
          }
          window.dispatchEvent(new CustomEvent('ttl:trees'));
        },
        [currentId, trees],
      );

      const folderRef = useRef(null);

      const importProject = async (entries) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const readable = entries
            .filter((entry) => PROJECT_READABLE.test(entry.path) && !PROJECT_SKIP.test(entry.path))
            .slice(0, 300);

          const files = [];
          for (const item of readable) {
            const file = await entryToFile(item);
            if (!file || file.size > 400000) continue;
            files.push({ path: item.path, text: await file.text() });
          }

          if (!files.length) {
            setNotice('这个项目里没有可解析的 .md / .json 文件');
            return;
          }

          const built = buildProjectTree(files);
          const now = Date.now();
          const tree = {
            id: uid('tree'),
            title: built.title,
            source: files.map((f) => `### ${f.path}`).join('\n'),
            nodes: built.nodes,
            createdAt: now,
            updatedAt: now,
            extractor: 'project',
          };

          persist([tree, ...trees].slice(0, 40));
          setCurrentId(tree.id);
          setSelectedId('');
          setCutoff(built.nodes.length);
          setNotice(`已从 ${files.length} 个文件生成项目树`);
        } catch (err) {
          setError((err && err.message) || String(err));
        } finally {
          setBusy(false);
        }
      };

      const analyzeWorkspace = async () => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const endpoint = targetSession
            ? `http://127.0.0.1:17866/pulse?session=${encodeURIComponent(targetSession)}`
            : 'http://127.0.0.1:17866/pulse';
          const response = await fetch(endpoint, { cache: 'no-store' });
          if (!response.ok) throw new Error(`本地分析服务返回 ${response.status}`);
          const data = await response.json();
          if (!data.ok) throw new Error(data.error || '分析失败');

          const now = Date.now();
          const tree = {
            id: uid('tree'),
            title: `工作区 · ${data.analysis.title || '当前会话'}`,
            source: '',
            nodes: data.tree,
            createdAt: now,
            updatedAt: now,
            extractor: 'workspace',
            averageScore: data.averageScore || 0,
            hourHistogram: data.hourHistogram || [],
            lastAt: data.analysis.lastAt || null,
          };

          persist([tree, ...trees].slice(0, 40));
          setCurrentId(tree.id);
          setSelectedId('');
          setCutoff(data.tree.length);
          setNotice(
            `${data.analysis.turns} 轮对话 · ${data.analysis.toolCalls} 次工具调用 · ${data.suggestions.length} 条建议`,
          );
          refreshSessions();
        } catch (err) {
          setError(
            `连不上本地分析服务（${(err && err.message) || err}）。这个能力由插件的 Host 半边提供，需要重启 dsh 后生效；在此之前可以先用「导入项目」或粘贴。`,
          );
        } finally {
          setBusy(false);
        }
      };

      const onFolderPicked = async (event) => {
        const picked = Array.from(event.target.files || []);
        event.target.value = '';
        if (!picked.length) return;
        await importProject(picked.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
      };

      const importFromClipboard = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text.trim()) {
            setNotice('剪贴板是空的');
            return;
          }
          setSource(text);
          setNotice('已从剪贴板导入，按 Ctrl+Enter 解析');
        } catch (err) {
          setNotice('浏览器拒绝读取剪贴板，请手动粘贴');
        }
      };

      const onDropFile = async (event) => {
        event.preventDefault();
        const dt = event.dataTransfer;
        if (!dt) return;

        // A dropped folder becomes a project tree.
        const items = dt.items ? Array.from(dt.items) : [];
        if (items.length) {
          const entry = items[0] && items[0].webkitGetAsEntry ? items[0].webkitGetAsEntry() : null;
          if (entry && entry.isDirectory) {
            const collected = [];
            await walkEntry(entry, '', collected);
            if (collected.length) {
              await importProject(collected);
              return;
            }
            setNotice('这个目录里没有可读文件');
            return;
          }
        }

        const files = dt.files;
        const file = files && files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
          setNotice('文件超过 2MB，请先裁剪');
          return;
        }
        try {
          const text = await file.text();
          setSource(text);
          setNotice(`已载入 ${file.name}，按 Ctrl+Enter 解析`);
        } catch (err) {
          setNotice('读取文件失败');
        }
      };

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

          // A superpowers plan is a structured document, not prose: parse its
          // tasks and interfaces instead of extracting sentences.
          if (looksLikePlan(text)) {
            const plan = parsePlanClient(text);
            extracted = {
              title: plan.title || 'Implementation plan',
              nodes: planToTreeClient(plan),
            };
            extractor = 'plan';
          }

          const wantsLlm =
            !extracted && settings.mode !== 'rule' && String(settings.llm.apiKey || '').trim();
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
          } else if (!extracted && settings.mode === 'llm') {
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

      const deepReview = async (id) => {
        const target = nodes.find((n) => n.id === id);
        if (!target) return '';
        const llm = (settings && settings.llm) || {};
        if (!llm.apiKey) {
          return '先在「设置」里填 API Key。Host 会用你的端点调用，密钥不经过第三方。';
        }
        const response = await fetch('http://127.0.0.1:17866/deep-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: (() => {
            if (typeof AbortController !== 'function') return undefined;
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 20000);
            return controller.signal;
          })(),
          body: JSON.stringify({
            text: target.text,
            baseUrl: llm.baseUrl,
            apiKey: llm.apiKey,
            model: llm.model,
          }),
        });
        const data = await response.json().catch(() => null);
        if (!data || !data.ok) throw new Error((data && data.error) || 'AI 评审失败');
        return data.review;
      };

      /**
       * Show the Conversation panel.
       *
       * The contract is `selectPanel(panelId: MainPanelId | null)` and it throws
       * for an unregistered key: passing the string 'conversation' always threw,
       * which the surrounding try/catch swallowed, so double-click silently did
       * nothing. `null` is the documented way back to the conversation.
       */
      const showConversation = () => {
        const layout = props && props.layout;
        if (layout && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel(null);
            return 'service';
          } catch (error) {
            /* fall through to the DOM path */
          }
        }

        // Belt and braces: if the service is missing or rejects, click the
        // visible 对话 tab. Two independent paths, because a silent failure here
        // is indistinguishable from "double-click does nothing".
        try {
          const tabs = document.querySelectorAll('button, [role="tab"], [role="button"]');
          for (const tab of tabs) {
            if ((tab.textContent || '').trim() === '对话') {
              tab.click();
              return 'tab';
            }
          }
        } catch (error) {
          /* ignore */
        }

        return '';
      };

      const jumpToChat = (node) => {
        // Only messages can be located. Structural/tool nodes are aggregates and
        // honestly have no single chat line to jump to.
        const text = node.messageText || '';
        if (!text) {
          setNotice('这是汇总节点，没有对应的单条消息；点一下可在右侧看它的评价与批注');
          return;
        }
        try {
          navigator.clipboard.writeText(text);
        } catch (err) {
          /* ignore */
        }

        const switched = showConversation();

        // Try to scroll the matching message into view once the conversation
        // paints. Long conversations may be virtualised, so a miss is normal.
        const needle = String(text).replace(/\s+/g, ' ').trim().slice(0, 16);
        const locate = (attempt) => {
          const found = (() => {
            try {
              const candidates = document.querySelectorAll('div, p, li, span');
              const deadline = Date.now() + 600;
              for (const element of candidates) {
                if (Date.now() > deadline) break;
                if (element.children.length > 0) continue;
                const content = element.textContent || '';
                if (!content.includes(needle)) continue;
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                try {
                  element.animate(
                    [
                      { backgroundColor: 'rgba(47,111,235,0.32)' },
                      { backgroundColor: 'transparent' },
                    ],
                    { duration: 1800, easing: 'ease-out' },
                  );
                } catch (err) {
                  /* ignore */
                }
                return true;
              }
            } catch (err) {
              /* ignore */
            }
            return false;
          })();

          if (found) {
            setNotice('已切到对话并定位到那条消息');
            return;
          }
          if (attempt < 2) {
            setTimeout(() => locate(attempt + 1), 500);
            return;
          }
          if (!switched) {
            setError(
              '无法切回对话面板：layout.selectPanel 不可用，「对话」标签也没找到。' +
                '原文已复制到剪贴板，可手动切到对话后粘贴搜索。',
            );
            return;
          }
          setNotice('已切到对话。这条消息不在当前渲染范围内，原文已复制，粘贴到搜索框即可定位');
        };

        if (switched) setTimeout(() => locate(0), 320);
        else locate(0);
      };

      const publishAnnotation = async (id) => {
        const target = nodes.find((n) => n.id === id);
        if (!target || !target.annotation) {
          setNotice('先写一条批注');
          return;
        }

        // Prefer handing the text to the composer; fall back to the clipboard.
        let handed = false;
        const tryCompose = () => {
          try {
            if (typeof window.__ttlCompose === 'function') {
              return window.__ttlCompose(target.annotation) === true;
            }
          } catch (error) {
            /* ignore */
          }
          return false;
        };

        handed = tryCompose();
        if (!handed) {
          // The dock may not have mounted yet; give it one frame then retry.
          await new Promise((resolve) => setTimeout(resolve, 180));
          handed = tryCompose();
        }

        if (handed) {
          showConversation();
          setNotice('批注已写入输入框，按 Enter 发送即可执行');
          return;
        }

        try {
          await navigator.clipboard.writeText(target.annotation);
          setNotice('批注已复制到剪贴板，粘贴到输入框发送即可在当前工作区执行');
        } catch (err) {
          setNotice('复制失败，请手动选中批注文本');
        }
      };

      const updateNode = (id, patch) => {
        patchCurrent({
          nodes: nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
        });
      };

      const addInnovation = (parentId) => {
        const now = Date.now();
        const child = {
          id: uid('n'),
          parentId,
          label: '创新：新想法',
          text: '把你的创新点写在这里，然后选中它加批注…',
          type: 'conclusion',
          confidence: 0.6,
          branchId: (graph.nodeMap.get(parentId) || {}).branchId || DEFAULT_BRANCH,
          createdAt: now,
          tags: [],
          virtual: true,
          annotation: '',
        };
        patchCurrent({ nodes: [...nodes, child] });
        setSelectedId(child.id);
        setCutoff(nodes.length + 1);
        setNotice('已添加创新节点，写下你的想法');
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
        // A branch is a hypothetical, not a restatement: it must not claim to be
        // the same message, nor inherit "this is an auto-generated innovation".
        delete clone.virtual;
        delete clone.seq;
        delete clone.messageText;
        delete clone.review;
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

      // Two trees often share a title ("工作区 · 某会话"), so a bare title makes the
      // second export overwrite the first. Stamp the time.
      const exportName = (tree, ext) => {
        const safe = String(tree.title || 'tree').replace(/[\\/:*?"<>|]/g, '_');
        const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
        return `${safe}-${stamp}.${ext}`;
      };

      const exportJson = () => {
        if (!current) return;
        // Export every field the panel can restore, not a hand-picked few: a
        // backup that drops annotations and reviews is not a backup.
        download(
          exportName(current, 'json'),
          JSON.stringify(
            {
              title: current.title,
              source: current.source,
              extractor: current.extractor,
              createdAt: current.createdAt,
              nodes: current.nodes,
            },
            null,
            2,
          ),
          'application/json',
        );
      };

      const exportMarkdown = () => {
        if (!current) return;
        download(exportName(current, 'md'), treeToMarkdown(current), 'text/markdown');
      };

      const exportMermaid = () => {
        if (!current) return;
        download(exportName(current, 'mmd'), treeToMermaid(current), 'text/plain');
      };

      const exportAdr = () => {
        if (!current) return;
        download(exportName(current, 'adr.md'), treeToAdr(current), 'text/markdown');
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
        {
          className: 'ttl-root',
          ref: rootRef,
          onDragOver: (event) => event.preventDefault(),
          onDrop: onDropFile,
        },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),

        // Toolbar — two rows so nothing overflows on a narrow window.
        h(
          'div',
          { className: 'ttl-bar' },
          h(
            'div',
            { className: 'ttl-bar-row' },
            h('span', { className: 'ttl-title' }, '思维树'),
            h('span', {
              className: 'ttl-sub',
              title: '构建标记：面板显示的不是这个值时，浏览器还在跑旧代码，请刷新页面',
            },
              `${BUILD} · ${current
                ? `${current.title} · ${totalNodes} 节点 · ${
                    current.extractor === 'llm'
                      ? 'AI 提取'
                      : current.extractor === 'plan'
                        ? '计划解析'
                        : current.extractor === 'project'
                          ? '项目导入'
                          : '规则提取'
                  }`
                : '尚未选择'}`),
            h(
              'div',
              { className: 'ttl-nav-inline' },
              h('button', {
                title:
                  graph.roots.length > 1
                    ? `切换根节点（共 ${graph.roots.length} 个）`
                    : '回到根节点 (Home)',
                onClick: () => {
                  if (!graph.roots.length) return;
                  // Deleting a root leaves several roots; cycling reaches them all
                  // instead of always landing on the first one.
                  const at = graph.roots.indexOf(selectedId);
                  const next = graph.roots[(at + 1) % graph.roots.length];
                  setSelectedId(next);
                  if (canvasApi.current) canvasApi.current.focusNode(next, true);
                },
              }, '⌂'),
              h('button', {
                title: '上一个问题',
                className: 'warn',
                disabled: !findings.some((f) => f.nodeId),
                onClick: () => canvasApi.current && canvasApi.current.jumpIssue(-1),
              }, '▲'),
              h('button', {
                title: '下一个问题',
                className: 'warn',
                disabled: !findings.some((f) => f.nodeId),
                onClick: () => canvasApi.current && canvasApi.current.jumpIssue(1),
              }, '▼'),
              h('button', {
                title: '居中当前节点 (Enter)',
                disabled: !selectedId,
                onClick: () => canvasApi.current && canvasApi.current.focusNode(selectedId, true),
              }, '◎'),
              h('button', {
                title: '聚焦模式：只亮当前路径和直接子节点',
                className: focusMode ? 'on' : '',
                onClick: () => setFocusMode((v) => !v),
              }, '◉'),
              h('button', {
                title: '适应画布',
                onClick: () => canvasApi.current && canvasApi.current.fitAll(),
              }, '⤢'),
            ),
            h('span', { className: 'ttl-spacer' }),
            h('button', { className: 'ttl-btn ghost', onClick: () => setShowSidebar((v) => !v) },
              showSidebar ? '收起输入' : '展开输入'),
            h('button', { className: 'ttl-btn ghost', onClick: () => setShowSettings((v) => !v) }, '设置'),
          ),
          h(
            'div',
            { className: 'ttl-bar-row' },
            h('select', {
              className: 'ttl-select',
              value: targetSession,
              onChange: (e) => setTargetSession(e.target.value),
              title: '选择要分析的会话（默认分析当前工作区）',
              style: { maxWidth: 190 },
            },
              h('option', { value: '' }, '当前工作区'),
              sessionOptions.map((session) =>
                h('option', { key: session.id, value: session.id }, session.label),
              ),
            ),
            h('button', {
              className: 'ttl-btn ghost',
              title: '重新读取会话列表',
              onClick: refreshSessions,
            }, '⟳'),
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
          ),
        ),

        // When you worked, at a glance: one bar per hour of the day.
        current && Array.isArray(current.hourHistogram) && current.hourHistogram.length === 24
          ? h(
              'div',
              { className: 'ttl-heat', title: '提问在一天里的分布' },
              current.hourHistogram.map((count, hour) => {
                const peak = Math.max(1, ...current.hourHistogram);
                return h('div', {
                  key: `heat-${hour}`,
                  className: 'ttl-heat-cell',
                  title: `${hour}:00 — ${count} 次`,
                  style: { opacity: count ? 0.25 + (count / peak) * 0.75 : 0.1 },
                });
              }),
            )
          : null,

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
                    rows: 5,
                    style: { maxHeight: 132 },
                    value: source,
                    placeholder: '粘贴对话、方案讨论，或直接拖入 .md 计划文件…',
                    onChange: (e) => setSource(e.target.value),
                    onKeyDown: (e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        if (!busy) doExtract();
                      }
                    },
                  }),
                  h('div', { className: 'row', style: { display: 'flex', gap: 6 } },
                    h('button', {
                      className: 'ttl-btn primary',
                      style: { flex: 1, justifyContent: 'center' },
                      onClick: analyzeWorkspace,
                      disabled: busy,
                      title: '读取当前工作区的会话记录，梳理脉络并给出建议（需要 Host 半边）',
                    }, busy ? '分析中…' : '分析工作区'),
                    h('button', {
                      className: 'ttl-btn',
                      onClick: doExtract,
                      disabled: busy,
                      title: '解析左侧文本框',
                    }, '解析'),
                  ),
                  h('div', { className: 'row', style: { display: 'flex', gap: 6 } },
                    h('button', { className: 'ttl-btn', onClick: importFromClipboard, title: '从剪贴板导入' }, '剪贴板'),
                    h('button', {
                      className: 'ttl-btn',
                      onClick: () => folderRef.current && folderRef.current.click(),
                      title: '导入本地项目文件夹（也可以直接把文件夹拖进来）',
                      disabled: busy,
                    }, '导入项目'),
                    h('button', {
                      className: 'ttl-btn',
                      onClick: () => setSource(SAMPLE_TEXT),
                      title: '载入示例',
                    }, '示例'),
                  ),
                  h('input', {
                    ref: folderRef,
                    type: 'file',
                    multiple: true,
                    style: { display: 'none' },
                    onChange: onFolderPicked,
                    ...{ webkitdirectory: '' },
                  }),
                  h('div', { className: 'ttl-hint' }, 'Ctrl+Enter 解析 · 支持拖入 superpowers 计划，会自动识别 Task 结构'),
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
            findings,
            apiRef: canvasApi,
            focusMode,
            onJumpToChat: jumpToChat,
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
                onPublish: publishAnnotation,
                onDeepReview: deepReview,
                onAddInnovation: addInnovation,
                onJump: jumpToChat,
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
        looksLikePlan,
        parsePlanClient,
        lintPlanClient,
        planToTreeClient,
        buildProjectTree,
        readDocTitle,
      };
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const openPanel = () => {
          try {
            if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
              ctx.layout.selectPanel('thinking-treelog');
            }
          } catch (error) {
            /* the panel button in the sidebar still works */
          }
        };

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
            () => h(Panel, { layout: ctx.layout }),
          ),
        );

        // A one-line result card above the composer, inside the conversation.
        // (`composer.dock` sits below the composer card, which has no room at the
        // bottom of the window; `input.dock` is the full-width strip above it.)
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'thinking-treelog-dock',
              order: 40,
              label: () => '思维树',
            },
            () => h(DockBar, { open: openPanel }),
          ),
        );
      },
    };
  },
});
