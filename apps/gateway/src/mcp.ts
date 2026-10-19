import { Server, createMcpHandler, hostHeaderValidationResponse, type CallToolResult, type McpHttpHandler, type Tool } from '@modelcontextprotocol/server';
import { userForApiKey, type User } from './auth.ts';
import { callTool, viewFor, type Ctx } from './calltool.ts';
import { log } from './log.ts';
import type { Route } from './upstreams.ts';

export function toMcpTool(r: Route): Tool {
  return {
    name: r.exposedName,
    description: r.tool.description ?? undefined,
    inputSchema: r.tool.input_schema as Tool['inputSchema'],
    ...(r.tool.output_schema && { outputSchema: r.tool.output_schema as Tool['outputSchema'] }),
    ...(r.tool.annotations && { annotations: r.tool.annotations }),
  } as Tool;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function createMcpEndpoint(ctx: Ctx) {
  const handlersByUser = new Map<string, McpHttpHandler>();
  const allowedHosts = [new URL(ctx.config.publicUrl).hostname, 'localhost', '127.0.0.1', '[::1]'];

  const factory = ({ authInfo }: { authInfo?: { extra?: Record<string, unknown> } }) => {
    const user = authInfo!.extra!.user as User;
    const server = new Server({ name: 'urumi-mcp-gateway', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler('tools/list', async () => ({ tools: viewFor(ctx.manager, user).map(toMcpTool) }));
    server.setRequestHandler('tools/call', async (req) => {
      const call = await callTool(ctx, user, 'mcp', req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      if (!call.result) return errorResult(call.error ?? call.outcome);
      const { _meta, ...rest } = call.result;
      const meta = { ...(_meta ?? {}) };
      delete meta['io.modelcontextprotocol/serverInfo'];
      const result = Object.keys(meta).length ? { ...rest, _meta: meta } : rest;
      return server.projectCallToolResult(result as CallToolResult, ctx.manager.catalog.routes.get(req.params.name)?.tool.output_schema ?? undefined);
    });
    return server;
  };

  const handlerFor = (userId: string) => {
    let handler = handlersByUser.get(userId);
    if (!handler) {
      handler = createMcpHandler(factory, { legacy: 'stateless', onerror: (err) => log('warn', 'mcp handler error', { error: err.message }) });
      handlersByUser.set(userId, handler);
    }
    return handler;
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const rejected = hostHeaderValidationResponse(request, allowedHosts);
      if (rejected) return rejected;
      const user = await userForApiKey(ctx.pool, request.headers.get('authorization') ?? undefined);
      if (!user) {
        return Response.json(
          { error: { code: 'unauthorized', message: 'missing, unknown or revoked API key' } },
          { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } },
        );
      }
      return handlerFor(user.id).fetch(request, { authInfo: { token: '', clientId: user.id, scopes: [], extra: { user } } });
    },
    notifyAll() {
      for (const handler of handlersByUser.values()) handler.notify.toolsChanged();
    },
    async close() {
      await Promise.allSettled([...handlersByUser.values()].map((h) => h.close()));
    },
  };
}
