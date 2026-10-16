UPDATE agent_runtime.agent_runs
   SET lease_owner_token = NULL,
       lease_expires_at = NULL
 WHERE status <> 'running'
    OR (lease_owner_token IS NULL) <> (lease_expires_at IS NULL);

ALTER TABLE agent_runtime.agent_runs
  ADD CONSTRAINT agent_runs_lease_pair_check
    CHECK ((lease_owner_token IS NULL) = (lease_expires_at IS NULL)),
  ADD CONSTRAINT agent_runs_lease_status_check
    CHECK (status = 'running' OR lease_owner_token IS NULL);
