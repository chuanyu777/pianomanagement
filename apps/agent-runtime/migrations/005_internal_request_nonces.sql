CREATE TABLE agent_runtime.internal_request_nonces (
  nonce UUID PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX internal_request_nonces_expires_at_idx
  ON agent_runtime.internal_request_nonces (expires_at);
