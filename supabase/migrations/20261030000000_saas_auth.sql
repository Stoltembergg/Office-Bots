-- Private service-side persistence only. Do not grant these tables to Data API roles.
-- OAuth PKCE verifiers and session digests are sensitive authentication material.
BEGIN;

CREATE SCHEMA office_bots_private;
REVOKE ALL ON SCHEMA office_bots_private FROM PUBLIC, anon, authenticated;

CREATE TABLE office_bots_private.oauth_states (
  state text PRIMARY KEY
    CHECK (state ~ '^[A-Za-z0-9_-]{43}$'),
  binding_digest text NOT NULL
    CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  code_verifier text NOT NULL
    CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms bigint NOT NULL,
  CHECK (expires_at_ms > created_at_ms),
  CHECK (expires_at_ms <= created_at_ms + 600000)
);

CREATE INDEX oauth_states_expires_at_idx
  ON office_bots_private.oauth_states (expires_at_ms);

CREATE TABLE office_bots_private.sessions (
  token_digest text PRIMARY KEY
    CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  github_user_id text NOT NULL
    CHECK (github_user_id ~ '^[1-9][0-9]{0,19}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms bigint NOT NULL,
  revoked_at_ms bigint,
  CHECK (expires_at_ms > created_at_ms),
  CHECK (expires_at_ms <= created_at_ms + 2592000000),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms BETWEEN created_at_ms AND expires_at_ms)
);

REVOKE ALL ON TABLE office_bots_private.oauth_states FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE office_bots_private.sessions FROM PUBLIC, anon, authenticated;

COMMIT;
