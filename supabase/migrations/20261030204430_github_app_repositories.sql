-- GitHub App authorization state and the user's selected repository stay server-side in the private schema.
-- Raw GitHub user access tokens are intentionally never persisted.
BEGIN;

CREATE TABLE office_bots_private.github_app_oauth_states (
  state text PRIMARY KEY
    CHECK (state ~ '^[A-Za-z0-9_-]{43}$'),
  github_user_id text NOT NULL
    CHECK (github_user_id ~ '^[1-9][0-9]{0,19}$'),
  binding_digest text NOT NULL
    CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  code_verifier text NOT NULL
    CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms bigint NOT NULL,
  CHECK (expires_at_ms > created_at_ms),
  CHECK (expires_at_ms <= created_at_ms + 600000)
);

CREATE INDEX github_app_oauth_states_expires_at_idx
  ON office_bots_private.github_app_oauth_states (expires_at_ms);

CREATE TABLE office_bots_private.github_app_repositories (
  github_user_id text NOT NULL
    CHECK (github_user_id ~ '^[1-9][0-9]{0,19}$'),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  full_name text NOT NULL
    CHECK (full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  is_private boolean NOT NULL,
  default_branch text,
  html_url text NOT NULL,
  last_synced_at_ms bigint NOT NULL CHECK (last_synced_at_ms >= 0),
  PRIMARY KEY (github_user_id, repository_id),
  CHECK (default_branch IS NULL OR (char_length(default_branch) <= 255 AND default_branch !~ '[[:cntrl:]]')),
  CHECK (html_url = 'https://github.com/' || full_name)
);

CREATE INDEX github_app_repositories_user_name_idx
  ON office_bots_private.github_app_repositories (github_user_id, lower(full_name));

CREATE TABLE office_bots_private.github_app_selected_repositories (
  github_user_id text PRIMARY KEY
    CHECK (github_user_id ~ '^[1-9][0-9]{0,19}$'),
  repository_id bigint NOT NULL,
  selected_at_ms bigint NOT NULL CHECK (selected_at_ms >= 0),
  FOREIGN KEY (github_user_id, repository_id)
    REFERENCES office_bots_private.github_app_repositories (github_user_id, repository_id)
    ON DELETE CASCADE
);

REVOKE ALL ON TABLE office_bots_private.github_app_oauth_states FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE office_bots_private.github_app_repositories FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE office_bots_private.github_app_selected_repositories FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE office_bots_private.github_app_oauth_states TO office_bots_auth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE office_bots_private.github_app_repositories TO office_bots_auth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE office_bots_private.github_app_selected_repositories TO office_bots_auth_runtime;

COMMENT ON ROLE office_bots_auth_runtime IS
  'Runtime access for Office Bots authentication and per-user GitHub repository metadata and selection only.';

COMMIT;
