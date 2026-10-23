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
import { lintTree, summarizeFindings, toAdr } from '@thinking-treelog/core/engineering';

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

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
