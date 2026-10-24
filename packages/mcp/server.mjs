#!/usr/bin/env node
/**
 * Thinking TreeLog — MCP server (stdio).
 *
 * Zero runtime dependencies beyond the workspace core package: this speaks
 * newline-delimited JSON-RPC 2.0 directly, so it can be dropped into any MCP
 * client without a build step.
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { TOOLS, callTool } from './tools.mjs';

const SERVER_INFO = { name: 'thinking-treelog', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
      return;

    case 'notifications/initialized':
      return;

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const result = await callTool(name, args);
        send({ jsonrpc: '2.0', id, result });
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(error?.message ?? error) }],
            isError: true,
          },
        });
      }
      return;
    }

    default:
      if (id !== undefined) sendError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Start the stdio loop.
 *
 * Exported rather than run at module scope: importing this package used to
 * register stdin readers and process handlers as a side effect, which hangs any
 * tool that merely wanted to inspect the exported server.
 */
export function start() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      sendError(null, -32700, `parse error: ${error.message}`);
      return;
    }

    handleRequest(message).catch((error) => {
      sendError(message?.id ?? null, -32603, String(error?.message ?? error));
    });
  });

  rl.on('close', () => process.exit(0));

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  process.stderr.write('thinking-treelog MCP server ready on stdio\n');

  return rl;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) start();
