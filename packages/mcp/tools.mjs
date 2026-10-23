/**
 * Tool implementations for the Thinking TreeLog MCP server.
 *
 * Kept separate from the stdio transport so they can be tested by direct import
 * (the sandbox forbids spawning a piped child process to drive the server).
 */

import {
  analyzeTree,
  extractWithRules,
  normalizeNodes,
  toMarkdown,
  toMermaid,
} from '@thinking-treelog/core';
import {
  lintTree,
  parseMarkdown,
  summarizeFindings,
  toAdr,
} from '@thinking-treelog/core/engineering';
import { lintPlan, parsePlan } from '@thinking-treelog/core/plan';
import { analyzeRhythm, formatRhythm } from '@thinking-treelog/core/rhythm';
import { formatTrace, traceCoverage } from '@thinking-treelog/core/trace';
import {
  analyzeConversation,
  decodeSession,
  formatPulse,
  listWorkspaces,
  pickSession,
  sessionsRoot,
  suggestNext,
  threadOf,
} from '@thinking-treelog/core/workspace';

export const TOOLS = [
  {
    name: 'build_thought_tree',
    description:
      'Parse a pasted conversation, plan, or reasoning transcript into a thought tree. ' +
      'Returns JSON with a flat node list; parentId carries the structure. Node types are ' +
      'question | claim | assumption | evidence | constraint | conclusion | action. ' +
      'Use this when a user asks to structure a discussion, review reasoning, or find where an argument forks.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The conversation or reasoning text to parse.' },
        title: { type: 'string', description: 'Optional tree title. Derived from the first node when omitted.' },
        maxNodes: { type: 'number', description: 'Maximum nodes to extract (default 60).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'thought_tree_markdown',
    description:
      'Render a thought tree as a Markdown outline with type and confidence annotations. ' +
      'Accepts either a tree object ({title, nodes}) or a bare node array.',
    inputSchema: {
      type: 'object',
      properties: {
        tree: { type: 'object', description: 'Thought tree object, or an object with a nodes array.' },
        nodes: { type: 'array', description: 'Bare node array, used when `tree` is omitted.' },
        title: { type: 'string', description: 'Title when passing a bare node array.' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'thought_tree_mermaid',
    description:
      'Render a thought tree as a Mermaid flowchart (paste-ready for GitHub READMEs and docs).',
    inputSchema: {
      type: 'object',
      properties: {
        tree: { type: 'object' },
        nodes: { type: 'array' },
        title: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'thought_tree_stats',
    description:
      'Summarise a thought tree: node count, depth, type mix, branch count, average confidence, ' +
      'and the lowest-confidence claims worth re-checking.',
    inputSchema: {
      type: 'object',
      properties: {
        tree: { type: 'object' },
        nodes: { type: 'array' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'lint_thought_tree',
    description:
      'Check a thought tree for reasoning gaps: conclusions with no evidence, unverified ' +
      'assumptions, rejected options that still carry children, over-deep chains. ' +
      'Use this before treating a plan as settled.',
    inputSchema: {
      type: 'object',
      properties: {
        tree: { type: 'object' },
        nodes: { type: 'array' },
        maxDepth: { type: 'number', description: 'Maximum decision-chain depth (default 8).' },
        minConclusionConfidence: {
          type: 'number',
          description: 'Minimum confidence for a conclusion (default 0.5).',
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'thought_tree_adr',
    description:
      'Render a thought tree as an Architecture Decision Record with Context / Decision / ' +
      'Consequences sections.',
    inputSchema: {
      type: 'object',
      properties: {
        tree: { type: 'object' },
        nodes: { type: 'array' },
        title: { type: 'string' },
        id: { type: 'string', description: 'ADR number, e.g. "0007".' },
        status: { type: 'string', description: 'Proposed | Accepted | Rejected | Superseded.' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'lint_plan',
    description:
      'Audit a structured implementation plan (the superpowers writing-plans format) before ' +
      'anyone writes code. Catches interface drift: a task consuming a symbol no task produces, ' +
      'the same symbol declared with two different signatures, a task with no runnable ' +
      'verification step, and a missing Review Focus section. Returns JSON findings.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: {
          type: 'string',
          description: 'The plan document. Must contain "### Task N: ..." headings.',
        },
      },
      required: ['markdown'],
      additionalProperties: false,
    },
  },
  {
    name: 'trace_coverage',
    description:
      'Check that every decision in a design spec has a corresponding task in the plan. ' +
      'Returns which decisions match a task, which have no plausible task, and which tasks the ' +
      'spec never mentions. Lexical matching: treat a low score as "look at this", not a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'The design document (Markdown).' },
        plan: { type: 'string', description: 'The implementation plan (Markdown).' },
        threshold: {
          type: 'number',
          description: 'Match threshold between 0 and 1 (default 0.12).',
        },
      },
      required: ['spec', 'plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_rhythm',
    description:
      'Read a working project\'s pace from its git history and report it: active days, sprint ' +
      'phases, theme mix, whether the work has stalled, and what to pick up next. Falls back to ' +
      'file modification times when the directory is not a git repository. Use this when the ' +
      'user asks "where is this project at" or "what should I do next".',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the server working directory.',
        },
        limit: {
          type: 'number',
          description: 'How many historical events to read (default 60).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_pulse',
    description:
      'Read the current dsh workspace from its session logs and report what this work is about: ' +
      'the recent thread of questions, how it is being done (tool mix), unfinished todos, and ' +
      'what to do next. Suggestions mix superpowers moves (executing-plans / writing-plans / ' +
      'systematic-debugging) with treelog checks. Use when the user asks 梳理脉络, 我在做什么, ' +
      '今天做到哪了, or 下一步做什么.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Workspace path to match. Defaults to the server working directory.',
        },
        sessionId: { type: 'string', description: 'Pin a specific session id.' },
        maxThreads: {
          type: 'number',
          description: 'How many recent questions to show (default 8).',
        },
      },
      additionalProperties: false,
    },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function asNodes(args) {
  const source = args?.tree ?? args;
  const raw = Array.isArray(source) ? source : source?.nodes;
  if (!Array.isArray(raw)) {
    throw new Error('expected a tree object with a nodes array, or a bare node array');
  }
  return normalizeNodes(raw);
}

function asTitle(args, nodes) {
  return String(args?.title || args?.tree?.title || nodes[0]?.label || 'Thought tree');
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export async function callTool(name, args = {}) {
  switch (name) {
    case 'build_thought_tree': {
      const text = String(args?.text ?? '');
      if (!text.trim()) throw new Error('`text` is required');
      const maxNodes = Number.isFinite(Number(args?.maxNodes)) ? Number(args.maxNodes) : 60;
      const nodes = normalizeNodes(extractWithRules(text, { maxNodes }));
      if (!nodes.length) throw new Error('no reasoning steps found in the supplied text');
      const title = String(args?.title || nodes[0].label || 'Thought tree');
      return textResult(JSON.stringify({ title, extractor: 'rule', nodes }, null, 2));
    }

    case 'thought_tree_markdown': {
      const nodes = asNodes(args);
      return textResult(toMarkdown({ title: asTitle(args, nodes), nodes }));
    }

    case 'thought_tree_mermaid': {
      const nodes = asNodes(args);
      return textResult(toMermaid({ title: asTitle(args, nodes), nodes }));
    }

    case 'thought_tree_stats': {
      const nodes = asNodes(args);
      return textResult(JSON.stringify(analyzeTree({ title: asTitle(args, nodes), nodes }), null, 2));
    }

    case 'lint_thought_tree': {
      const nodes = asNodes(args);
      const findings = lintTree(nodes, {
        maxDepth: Number.isFinite(Number(args.maxDepth)) ? Number(args.maxDepth) : undefined,
        minConclusionConfidence: Number.isFinite(Number(args.minConclusionConfidence))
          ? Number(args.minConclusionConfidence)
          : undefined,
      });
      return textResult(
        JSON.stringify({ summary: summarizeFindings(findings), findings }, null, 2),
      );
    }

    case 'thought_tree_adr': {
      const nodes = asNodes(args);
      return textResult(
        toAdr(
          { title: asTitle(args, nodes), nodes, extractor: 'rule' },
          {
            id: typeof args.id === 'string' ? args.id : undefined,
            status: typeof args.status === 'string' ? args.status : undefined,
          },
        ),
      );
    }

    case 'lint_plan': {
      const markdown = String(args?.markdown ?? '');
      if (!markdown.trim()) throw new Error('`markdown` is required');
      const plan = parsePlan(markdown);
      if (!plan.tasks.length) {
        throw new Error('no tasks found — expected "### Task N: ..." headings');
      }
      const findings = lintPlan(plan, { locale: 'en' });
      return textResult(
        JSON.stringify(
          {
            title: plan.title,
            tasks: plan.tasks.length,
            summary: summarizeFindings(findings),
            findings,
          },
          null,
          2,
        ),
      );
    }

    case 'trace_coverage': {
      const spec = String(args?.spec ?? '');
      const planText = String(args?.plan ?? '');
      if (!spec.trim() || !planText.trim()) throw new Error('`spec` and `plan` are required');

      const plan = parsePlan(planText);
      if (!plan.tasks.length) {
        throw new Error('no tasks found in `plan` — expected "### Task N: ..." headings');
      }

      const result = traceCoverage(parseMarkdown(spec), plan.tasks, {
        threshold: Number.isFinite(Number(args?.threshold)) ? Number(args.threshold) : undefined,
      });
      return textResult(formatTrace(result, { locale: 'en' }));
    }

    case 'project_rhythm': {
      const dir = typeof args?.path === 'string' && args.path.trim() ? args.path : process.cwd();
      const limit = Number.isFinite(Number(args?.limit)) ? Number(args.limit) : 60;
      const analysis = analyzeRhythm(dir, { limit });
      return textResult(formatRhythm(analysis, { locale: 'zh' }));
    }

    case 'workspace_pulse': {
      const workspaces = listWorkspaces(sessionsRoot());
      if (!workspaces.length) {
        throw new Error('no dsh session logs found under ~/.dsh/sessions');
      }

      const picked = pickSession(workspaces, {
        cwd: typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd : process.cwd(),
        sessionId: typeof args?.sessionId === 'string' ? args.sessionId : undefined,
      });
      if (!picked) throw new Error('no matching session found');

      const records = decodeSession(picked.session.file, { maxFrames: 300, headFrames: 6 });
      const analysis = analyzeConversation(records);
      const suggestions = suggestNext(analysis);
      const maxThreads = Number.isFinite(Number(args?.maxThreads)) ? Number(args.maxThreads) : 8;

      return textResult(
        formatPulse(analysis, suggestions, { thread: threadOf(analysis, { maxThreads }) }),
      );
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
