ALTER TABLE agent_runtime.dialogue_tasks
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
