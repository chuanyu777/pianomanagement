CREATE TABLE agent_runtime.agent_threads (
  id UUID PRIMARY KEY,
  user_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  current_preview_id UUID,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_runtime.agent_runs (
  id UUID PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES agent_runtime.agent_threads(id),
  client_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_input', 'completed', 'failed')),
  user_message TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_runs_thread_client_request_key UNIQUE (thread_id, client_request_id)
);

CREATE TABLE agent_runtime.agent_messages (
  id UUID PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES agent_runtime.agent_threads(id),
  run_id UUID REFERENCES agent_runtime.agent_runs(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  structured JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_runtime.agent_run_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runtime.agent_runs(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_run_events_run_cursor_idx
  ON agent_runtime.agent_run_events (run_id, event_id);

CREATE INDEX agent_messages_thread_created_idx
  ON agent_runtime.agent_messages (thread_id, created_at, id);
