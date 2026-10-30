-- Least-privilege database role for the Vercel GitHub auth functions.
-- The login role and its password are created separately in the Supabase project.
BEGIN;

CREATE ROLE office_bots_auth_runtime NOLOGIN;

GRANT CONNECT ON DATABASE postgres TO office_bots_auth_runtime;
GRANT USAGE ON SCHEMA office_bots_private TO office_bots_auth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE office_bots_private.oauth_states TO office_bots_auth_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE office_bots_private.sessions TO office_bots_auth_runtime;

COMMENT ON ROLE office_bots_auth_runtime IS
  'Runtime access for Office Bots GitHub OAuth and session persistence only.';

COMMIT;
