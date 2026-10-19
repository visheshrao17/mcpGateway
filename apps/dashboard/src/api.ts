import type { ApiKey, AuditPage, ChatEvent, ChatHistory, ChatReply, Conversation, Invite, Member, Meta, PublicInvite, Role, Server, ServerInput, User } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event('session-expired'));
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error?.message ?? `Request failed (${response.status})`, response.status, data?.error?.code ?? 'request_failed');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const id = encodeURIComponent;
export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: (email: string, password: string) => request<{ user: User }>('/auth/login', 'POST', { email, password }),
  logout: () => request<void>('/auth/logout', 'POST'),
  invite: (token: string) => request<PublicInvite>(`/invites/${id(token)}`),
  acceptInvite: (token: string, name: string, password: string) => request<{ user: User }>(`/invites/${id(token)}/accept`, 'POST', { name, password }),
  servers: () => request<Server[]>('/servers'),
  addServer: (body: ServerInput) => request<void>('/servers', 'POST', body),
  editServer: (serverId: string, body: Partial<Omit<ServerInput, 'slug'>> & { enabled?: boolean }) => request<void>(`/servers/${id(serverId)}`, 'PATCH', body),
  removeServer: (serverId: string) => request<void>(`/servers/${id(serverId)}`, 'DELETE'),
  refreshServer: (serverId: string) => request<void>(`/servers/${id(serverId)}/refresh`, 'POST'),
  toolPolicy: (serverId: string, tool: string, admin_only: boolean) => request<void>(`/servers/${id(serverId)}/tools/${id(tool)}/policy`, 'PUT', { admin_only }),
  keys: (all = false) => request<ApiKey[]>(`/keys${all ? '?all=1' : ''}`),
  createKey: (name: string) => request<ApiKey & { key: string }>('/keys', 'POST', { name }),
  revokeKey: (keyId: string) => request<void>(`/keys/${id(keyId)}`, 'DELETE'),
  users: () => request<Member[]>('/users'),
  editUser: (userId: string, body: { role?: Role; active?: boolean }) => request<Member>(`/users/${id(userId)}`, 'PATCH', body),
  invites: () => request<Invite[]>('/invites'),
  createInvite: (email: string, role: Role) => request<Omit<Invite, 'accepted_at'> & { invite_url: string }>('/invites', 'POST', { email, role }),
  removeInvite: (inviteId: string) => request<void>(`/invites/${id(inviteId)}`, 'DELETE'),
  audit: (params: URLSearchParams) => request<AuditPage>(`/audit?${params}`),
  chat: (message: string, conversation_id?: string) => request<ChatReply>('/chat', 'POST', { message, conversation_id }),
  meta: () => request<Meta>('/meta'),
  conversations: () => request<Conversation[]>('/chat'),
  conversation: (conversationId: string) => request<ChatHistory>(`/chat/${id(conversationId)}`),
};

/**
 * Streams one chat turn as server-sent events. Resolves when the stream ends.
 * Abort the signal to stop the turn server-side.
 */
export async function streamChat(message: string, conversationId: string | undefined, onEvent: (event: ChatEvent) => void, signal: AbortSignal) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ message, conversation_id: conversationId }),
    signal,
  });
  if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error?.message ?? `Request failed (${response.status})`, response.status, data?.error?.code ?? 'request_failed');
  }
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream') || !response.body) {
    const result = (await response.json()) as ChatReply;
    onEvent({ type: 'conversation', conversation_id: result.conversation_id });
    onEvent({ type: 'message', content: result.reply });
    onEvent({ type: 'done', ...result });
    return;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const flush = (block: string) => {
    let name = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    try {
      const payload = JSON.parse(data.join('\n'));
      onEvent({ ...payload, type: name } as ChatEvent);
    } catch { /* ignore malformed event */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value.replace(/\r\n?/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      flush(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
  }
  if (buffer.trim()) flush(buffer);
}
