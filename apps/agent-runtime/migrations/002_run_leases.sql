ALTER TABLE agent_runtime.agent_runs
  ADD COLUMN lease_owner_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_runtime.agent_runs
  ADD CONSTRAINT agent_runs_attempt_count_nonnegative CHECK (attempt_count >= 0);

CREATE INDEX agent_runs_queued_claim_idx
  ON agent_runtime.agent_runs (created_at, id)
  WHERE status = 'queued';

CREATE INDEX agent_runs_expired_lease_idx
  ON agent_runtime.agent_runs (lease_expires_at, id)
  WHERE status = 'running' AND lease_expires_at IS NOT NULL;
