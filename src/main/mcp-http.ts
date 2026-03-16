import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import * as http from 'node:http';
import * as net from 'node:net';
import { createMcpContext, tools } from './tool-handlers';
import { scanProjectTree } from './utils';

const DEFAULT_PORT = 7777;
const PORT_RANGE = 100;

let httpServer: http.Server | null = null;
let activePort: number | null = null;
const transports = new Map<string, SSEServerTransport>();

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(): Promise<number> {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_RANGE; p++) {
    if (await isPortAvailable(p)) return p;
  }
  throw new Error(`No available port in range ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_RANGE - 1}`);
}

function createMcpServerInstance(
  getProjectPath: () => string | null,
  getRootPath: () => string | null,
  setActiveProject?: (p: string) => void,
): McpServer {
  const server = new McpServer({ name: 'night-pm', version: '1.0.0' });

  // Context resolved per tool call so project_set_active updates are visible to subsequent tools.
  const ctx = () => createMcpContext({
      projectPath: getProjectPath(),
      scanRoot: getRootPath() ?? '',
      setActiveProject,
      scanProjectTree,
    });

  for (const [name, tool] of Object.entries(tools)) {
    server.tool(name, tool.description, tool.schema, async (args: unknown) => {
      return await tool.handler(ctx(), args);
    });
  }

  return server;
}

export interface McpHttpStatus {
  running: boolean;
  port: number | null;
  connections: number;
  url: string | null;
}

export async function startMcpHttpServer(
  getProjectPath: () => string | null,
  getRootPath: () => string | null,
  setActiveProject?: (p: string) => void,
): Promise<McpHttpStatus> {
  if (httpServer) return getStatus();

  const port = await findAvailablePort();

  httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      const mcpInst = createMcpServerInstance(getProjectPath, getRootPath, setActiveProject);
      transports.set(transport.sessionId, transport);
      res.on('close', () => { transports.delete(transport.sessionId); });
      await mcpInst.connect(transport);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Session not found'); return; }
      await transport.handlePostMessage(req, res);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'night-pm', version: '1.0.0', connections: transports.size }));
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.listen(port, '127.0.0.1', () => { activePort = port; resolve(); });
  });

  console.log(`[MCP HTTP] Server listening on http://127.0.0.1:${port}/sse`);
  return getStatus();
}

export async function stopMcpHttpServer(): Promise<void> {
  if (!httpServer) return;
  for (const t of transports.values()) {
    try { await t.close(); } catch { /* ignore */ }
  }
  transports.clear();
  await new Promise<void>((resolve) => {
    httpServer!.close(() => resolve());
  });
  httpServer = null;
  activePort = null;
  console.log('[MCP HTTP] Server stopped');
}

export function getStatus(): McpHttpStatus {
  return {
    running: httpServer !== null,
    port: activePort,
    connections: transports.size,
    url: activePort ? `http://127.0.0.1:${activePort}/sse` : null,
  };
}
