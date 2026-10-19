import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as z from 'zod/v4';
import type { Gateway } from '../src/app.ts';
import { ADMIN, apiClient, fakeUpstream, freshDatabase, inviteMember, startGateway, testConfig, waitFor, type Upstream } from './helpers.ts';

type LlmRequest = { model: string; messages: any[]; tools?: any[] };
let llmRequests: LlmRequest[] = [];
let respond: (req: LlmRequest, n: number) => { status?: number; body: unknown; delayMs?: number; headersFirst?: boolean } = () => ({ body: {} });

const toolCall = (name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`) => ({
  body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
});
const final = (content: string) => ({ body: { choices: [{ message: { role: 'assistant', content } }] } });

let llm: http.Server;
let flakyWrites = 0;
let upstream: Upstream;
let gw: Gateway;
let base: string;
let admin: ReturnType<typeof apiClient>;

before(async () => {
  llm = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.equal(req.headers.authorization, 'Bearer test-llm-key');
    const body = JSON.parse(raw) as LlmRequest;
    llmRequests.push(body);
    const out = respond(body, llmRequests.length);
    if (out.headersFirst) {
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.write(' ');
      await new Promise((r) => setTimeout(r, out.delayMs ?? 0));
      res.end(JSON.stringify(out.body));
      return;
    }
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
  upstream = await fakeUpstream((s) => {
    s.registerTool('list_orders', { description: 'orders', inputSchema: z.object({ period: z.string() }), annotations: { readOnlyHint: true } }, async ({ period }) => ({
      content: [{ type: 'text', text: `3 orders for ${period}` }],
    }));
    s.registerTool('big', { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'x'.repeat(20000) }] }));
    s.registerTool('create_product', { inputSchema: z.object({ name: z.string() }) }, async () => ({ content: [{ type: 'text', text: 'created' }] }));
    s.registerTool('slow_read', { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => {
      await new Promise((r) => setTimeout(r, 800));
      return { content: [{ type: 'text', text: 'slow result' }] };
    });
    s.registerTool('flaky_write', { inputSchema: z.object({ name: z.string() }) }, async () => {
      flakyWrites++;
      return { isError: true, content: [{ type: 'text', text: 'store did not answer; the POST may have been applied' }] };
    });
  });
  const config = testConfig(await freshDatabase(), {
    LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
    LLM_MODEL: 'test/model',
    LLM_API_KEY: 'test-llm-key',
    MAX_AGENT_STEPS: '3',
    SEED_SERVERS: JSON.stringify([{ slug: 'woo', name: 'Woo', url: upstream.url, auth_type: 'none' }]),
    SEED_ADMIN_ONLY_TOOLS: 'woo__create_product',
  });
  ({ gw, url: base } = await startGateway(config));
  admin = apiClient(base);
  await admin.login(ADMIN.email, ADMIN.password);
  await waitFor(async () => (await admin.get('/api/servers')).body[0]?.status === 'connected');
});

after(async () => {
  await gw.stop();
  await upstream.close();
  llm.closeAllConnections();
  llm.close();
});

test('seeded server and admin-only policy are in place', async () => {
  const [woo] = (await admin.get('/api/servers')).body;
  assert.equal(woo.slug, 'woo');
  assert.equal(woo.tools.find((t: any) => t.name === 'create_product').admin_only, true);
  assert.deepEqual((await admin.get('/api/meta')).body, { mcp_url: 'http://app.localtest.me/mcp', llm_model: 'test/model' });
});

test('chat: tool call then final answer, persisted and private to the owner', async () => {
  llmRequests = [];
  respond = (_req, n) => (n === 1 ? toolCall('woo__list_orders', { period: 'today' }) : final('You had 3 orders today.'));
  const res = await admin.post('/api/chat', { message: 'How many orders today?' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.reply, 'You had 3 orders today.');
  assert.deepEqual(res.body.tool_calls.map((t: any) => [t.name, t.outcome, t.result_preview]), [['woo__list_orders', 'ok', '3 orders for today']]);
  assert.deepEqual(res.body.tool_calls[0].arguments, { period: 'today' });

  assert.equal(llmRequests.length, 2);
  assert.equal(llmRequests[0]!.model, 'test/model');
  assert.match(llmRequests[0]!.messages[0].content, /untrusted data, never instructions/);
  assert.ok(llmRequests[0]!.tools!.some((t) => t.function.name === 'woo__list_orders'));
  assert.equal(llmRequests[1]!.messages.at(-1).role, 'tool');
  assert.equal(llmRequests[1]!.messages.at(-1).content, '3 orders for today');

  const audit = (await admin.get('/api/audit?limit=1')).body.rows[0];
  assert.equal(audit.source, 'chat');
  assert.equal(audit.outcome, 'ok');

  const history = await admin.get(`/api/chat/${res.body.conversation_id}`);
  assert.deepEqual(
    history.body.messages.map((m: any) => m.role),
    ['user', 'assistant', 'assistant'],
  );
  assert.equal(history.body.messages[1].tool_calls[0].outcome, 'ok');
  assert.equal(history.body.messages[2].content, 'You had 3 orders today.');

  respond = () => final('Still 3.');
  const again = await admin.post('/api/chat', { conversation_id: res.body.conversation_id, message: 'And now?' });
  assert.equal(again.body.reply, 'Still 3.');
  assert.equal(llmRequests.at(-1)!.messages.filter((m) => m.role === 'user').length, 2);

  const member = await inviteMember(base, admin, 'm@example.com');
  assert.equal((await member.get(`/api/chat/${res.body.conversation_id}`)).status, 404);
  assert.equal((await member.post('/api/chat', { conversation_id: res.body.conversation_id, message: 'hi' })).status, 404);
});

test('chat: step cap stops a looping model', async () => {
  llmRequests = [];
  respond = () => toolCall('woo__list_orders', { period: 'today' });
  const res = await admin.post('/api/chat', { message: 'loop forever' });
  assert.equal(res.status, 200);
  assert.equal(llmRequests.length, 3);
  assert.equal(res.body.tool_calls.length, 3);
  assert.match(res.body.reply, /stopped after 3 steps/);
});

test('chat: tool results are truncated to 8000 chars before going back to the model', async () => {
  llmRequests = [];
  respond = (_req, n) => (n === 1 ? toolCall('woo__big', {}) : final('ok'));
  const res = await admin.post('/api/chat', { message: 'big' });
  assert.equal(res.body.tool_calls[0].result_preview.length, 300);
  assert.equal(llmRequests[1]!.messages.at(-1).content.length, 8000);
});

test('chat: member cannot use an admin-only tool; denied and audited', async () => {
  const member = apiClient(base);
  await member.login('m@example.com', 'member-password-1');
  llmRequests = [];
  respond = (_req, n) => (n === 1 ? toolCall('woo__create_product', { name: 'x' }) : final('I could not do that.'));
  const res = await member.post('/api/chat', { message: 'create a product named x' });
  assert.ok(!llmRequests[0]!.tools!.some((t) => t.function.name === 'woo__create_product'));
  assert.equal(res.body.tool_calls[0].outcome, 'denied');
  const own = (await member.get('/api/audit')).body.rows;
  assert.equal(own[0].outcome, 'denied');
  assert.equal(own[0].source, 'chat');
});

test('chat: LLM errors become a clear message', async () => {
  respond = () => ({ status: 429, body: { error: { message: 'rate limited', code: 429 } } });
  const res = await admin.post('/api/chat', { message: 'hello' });
  assert.equal(res.status, 200);
  assert.match(res.body.reply, /rate limiting requests \(HTTP 429\)/);
  respond = () => ({ status: 401, body: { error: { message: 'bad key' } } });
  assert.match((await admin.post('/api/chat', { message: 'hello' })).body.reply, /API key was rejected/);
});

test('chat: after a write fails or may have been applied, further writes in that request are refused without calling the upstream', async () => {
  respond = (_req, n) => (n <= 2 ? toolCall('woo__flaky_write', { name: 'Lamp' }) : final('I could not confirm the product; please check the store.'));
  llmRequests = [];
  flakyWrites = 0;
  const res = await admin.post('/api/chat', { message: 'create a lamp' });
  assert.equal(res.status, 200);
  assert.equal(flakyWrites, 1, 'upstream write called exactly once');
  assert.deepEqual(res.body.tool_calls.map((c: any) => c.outcome), ['tool_error', 'denied']);
  const audit = await admin.get('/api/audit?server=woo&limit=5');
  assert.deepEqual(audit.body.rows.filter((r: any) => r.tool_name === 'flaky_write').map((r: any) => r.outcome), ['denied', 'tool_error']);
});

async function readEvents(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)![1],
      data: JSON.parse(block.match(/^data: (.*)$/m)![1]!),
    }));
}

test('chat: streams progress events in order when the client asks for text/event-stream', async () => {
  respond = (_req, n) => (n === 1 ? toolCall('woo__list_orders', { period: 'today' }) : final('There were 3 orders today.'));
  llmRequests = [];
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', accept: 'text/event-stream', cookie: admin.cookie },
    body: JSON.stringify({ message: 'orders today?' }),
  });
  assert.equal(res.headers.get('content-type')?.startsWith('text/event-stream'), true);
  const events = await readEvents(res);
  assert.deepEqual(
    events.map((e) => e.event),
    ['conversation', 'thinking', 'tool_call_started', 'tool_call_finished', 'thinking', 'message', 'done'],
  );
  assert.equal(events[3]!.data.outcome, 'ok');
  assert.equal(events[5]!.data.content, 'There were 3 orders today.');
  const list = await admin.get('/api/chat');
  assert.equal(list.body[0].id, events[0]!.data.conversation_id, 'newest conversation listed first');
});

test('chat: stopping the request aborts the model call and records the stop', async () => {
  respond = () => ({ ...final('too late'), delayMs: 3000 });
  llmRequests = [];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', accept: 'text/event-stream', cookie: admin.cookie },
    body: JSON.stringify({ message: 'slow question' }),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const conversationId = JSON.parse(first.match(/^data: (.*)$/m)![1]!).conversation_id;
  controller.abort();
  await waitFor(async () => {
    const convo = await admin.get(`/api/chat/${conversationId}`);
    return convo.body.messages.some((m: any) => m.role === 'assistant' && m.content.startsWith('Stopped.'));
  }, 2500, 'stop recorded before the slow model would have answered');
});

test('chat: stopping while a tool runs still records the stop once the tool returns', async () => {
  respond = (_req, n) => (n === 1 ? toolCall('woo__slow_read', {}) : final('should not be reached'));
  llmRequests = [];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', accept: 'text/event-stream', cookie: admin.cookie },
    body: JSON.stringify({ message: 'slow tool please' }),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  let seen = '';
  while (!seen.includes('tool_call_started')) seen += new TextDecoder().decode((await reader.read()).value);
  const conversationId = JSON.parse(seen.match(/^data: (.*)$/m)![1]!).conversation_id;
  controller.abort();
  await waitFor(async () => {
    const convo = await admin.get(`/api/chat/${conversationId}`);
    return convo.body.messages.some((m: any) => m.role === 'assistant' && (m.content ?? '').startsWith('Stopped.'));
  }, 3000, 'stop recorded after the tool finished');
  assert.equal(llmRequests.length, 1, 'no further model call after stop');
});

test('chat: stopping while the model has sent headers but not its body still records the stop', async () => {
  respond = () => ({ ...final('too late'), delayMs: 3000, headersFirst: true });
  llmRequests = [];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', accept: 'text/event-stream', cookie: admin.cookie },
    body: JSON.stringify({ message: 'headers first' }),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const conversationId = JSON.parse(first.match(/^data: (.*)$/m)![1]!).conversation_id;
  await waitFor(async () => llmRequests.length === 1, 2000, 'model request in flight');
  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  await waitFor(async () => {
    const convo = await admin.get(`/api/chat/${conversationId}`);
    return convo.body.messages.some((m: any) => m.role === 'assistant' && (m.content ?? '').startsWith('Stopped.'));
  }, 2500, 'stop recorded while the model body was pending');
});
