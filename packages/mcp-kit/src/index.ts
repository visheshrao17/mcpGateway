import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer, createMcpHandler, type CallToolResult } from '@modelcontextprotocol/server';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';

export type ServeOptions = {
  name: string;
  version: string;
  register: (server: McpServer) => void;
};

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing env ${name}`);
  return value;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Serves one stateless Streamable HTTP MCP endpoint at /mcp plus /healthz.
 * MCP_BEARER_TOKEN, when set, is required on every MCP request.
 * ALLOWED_HOSTS lists the Host header values accepted (DNS rebinding guard).
 */
export function serveMcp({ name, version, register }: ServeOptions): http.Server {
  const port = Number(env('PORT', '8000'));
  const token = process.env.MCP_BEARER_TOKEN || undefined;
  const validateHost = hostHeaderValidation(env('ALLOWED_HOSTS', 'localhost,127.0.0.1').split(','));
  const handle = toNodeHandler(
    createMcpHandler(
      () => {
        const server = new McpServer({ name, version });
        register(server);
        return server;
      },
      { legacy: 'stateless', onerror: (err) => console.error(JSON.stringify({ level: 'error', msg: err.message })) },
    ),
  );

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!validateHost(req, res)) return;
    if (token) {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ') || !sameSecret(header.slice(7), token)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'invalid or missing bearer token' }));
        return;
      }
    }
    await handle(req, res);
  });
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', msg: `${name} listening`, port })));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
  return server;
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export { env };
