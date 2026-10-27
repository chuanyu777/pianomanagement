CREATE TABLE agent_runtime.dialogue_tasks (
  thread_id UUID PRIMARY KEY REFERENCES agent_runtime.agent_threads(id),
  actor_key TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
