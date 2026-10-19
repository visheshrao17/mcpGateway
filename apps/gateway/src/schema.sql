CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  url text NOT NULL,
  auth_type text NOT NULL CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name text,
  credential_enc bytea,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'unreachable')),
  last_error text,
  last_checked_at timestamptz,
  tools_hash text,
  tools_changed_at timestamptz,
  config_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_tools (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  input_schema jsonb NOT NULL,
  output_schema jsonb,
  annotations jsonb,
  PRIMARY KEY (server_id, name)
);

CREATE TABLE IF NOT EXISTS tool_policies (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  admin_only boolean NOT NULL,
  PRIMARY KEY (server_id, tool_name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  user_email text NOT NULL,
  source text NOT NULL CHECK (source IN ('mcp', 'chat')),
  server_slug text,
  tool_name text NOT NULL,
  args_summary text,
  duration_ms integer,
  outcome text NOT NULL CHECK (outcome IN ('pending', 'ok', 'tool_error', 'timeout', 'unreachable', 'denied', 'unknown', 'error')),
  error text
);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log(user_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_server_idx ON audit_log(server_slug, id DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content text,
  tool_calls jsonb,
  tool_call_id text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS bootstrap_state (
  key text PRIMARY KEY,
  done_at timestamptz NOT NULL DEFAULT now()
);
