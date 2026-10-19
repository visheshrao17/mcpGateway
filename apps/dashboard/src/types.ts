export type Role = 'admin' | 'member';
export interface User { id: string; email: string; name: string; role: Role }
export interface Member extends User { active: boolean; created_at: string }
export interface Invite { id: string; email: string; role: Role; expires_at: string; accepted_at: string | null }
export interface PublicInvite { email: string; role: Role; expires_at: string }
export type AuthType = 'none' | 'bearer' | 'header';
export interface Tool {
  name: string; exposed_name: string; description: string;
  input_schema: Record<string, unknown>; annotations: Record<string, unknown> | null; admin_only: boolean;
}
export interface Server {
  id: string; slug: string; name: string; url: string; auth_type: AuthType;
  auth_header_name: string | null; has_credential: boolean; enabled: boolean;
  status: 'connected' | 'unreachable' | 'disabled' | 'pending'; last_error: string | null;
  last_checked_at: string | null; tools_changed_at: string | null; tools: Tool[];
}
export interface ServerInput {
  slug: string; name: string; url: string; auth_type: AuthType;
  auth_header_name?: string | null; credential?: string | null;
}
export interface ApiKey {
  id: string; name: string; prefix: string; user_email: string; created_at: string;
  last_used_at: string | null; revoked_at: string | null;
}
export interface Meta { mcp_url: string; llm_model: string | null }
export type Outcome = 'pending' | 'ok' | 'tool_error' | 'timeout' | 'unreachable' | 'denied' | 'unknown' | 'error';
export const outcomes: Outcome[] = ['pending', 'ok', 'tool_error', 'timeout', 'unreachable', 'denied', 'unknown', 'error'];
export interface AuditRow {
  id: string; started_at: string; user_email: string; source: 'mcp' | 'chat';
  server_slug: string; tool_name: string; duration_ms: number | null; outcome: Outcome; error: string | null;
}
export interface AuditPage { rows: AuditRow[]; next_before_id: string | null }
export interface ToolCall { name: string; arguments: unknown; outcome: Outcome; duration_ms: number; result_preview: unknown }
export interface ChatReply { conversation_id: string; reply: string; tool_calls: ToolCall[] }
export interface ChatMessage { role: string; content: string; tool_calls?: ToolCall[] }
export interface Conversation { id: string; title: string; created_at: string; updated_at: string }
export interface ChatHistory { messages: ChatMessage[] }
export type ChatEvent =
  | { type: 'conversation'; conversation_id: string }
  | { type: 'thinking'; step: number }
  | { type: 'tool_call_started'; id: string; name: string; arguments: unknown }
  | { type: 'tool_call_finished'; id: string; name: string; arguments: unknown; outcome: Outcome; duration_ms: number; result_preview: unknown }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done'; conversation_id: string; reply: string; tool_calls: ToolCall[] };
