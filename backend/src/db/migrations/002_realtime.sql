-- Real-time sync (Prompts 32-33): Socket.IO with the Postgres adapter.

-- The adapter fans packets out between API instances with NOTIFY; payloads over 8000 bytes
-- spill into this table (schema from @socket.io/postgres-adapter's README).
CREATE TABLE socket_io_attachments (
  id         bigserial UNIQUE,
  created_at timestamptz DEFAULT now(),
  payload    bytea
);
GRANT SELECT, INSERT, DELETE ON socket_io_attachments TO aafm_app;
GRANT USAGE ON SEQUENCE socket_io_attachments_id_seq TO aafm_app;

-- resolve_session now also returns the user's display name, so a socket can label presence
-- and "who changed what" without an extra query. The return type changes, so drop + create.
DROP FUNCTION app.resolve_session(bytea, interval);
CREATE FUNCTION app.resolve_session(p_token_hash bytea, p_idle interval)
  RETURNS TABLE (user_id uuid, org_id uuid, team_id uuid, membership_id uuid, role member_role,
                 must_change_password boolean, name text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    UPDATE sessions s SET last_seen_at = now()
    WHERE s.token_hash = p_token_hash AND s.expires_at > now()
      AND s.last_seen_at > now() - p_idle AND s.last_seen_at < now() - interval '1 minute';

    RETURN QUERY
      SELECT s.user_id, s.org_id, m.team_id, s.membership_id, m.role, u.must_change_password, u.name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN memberships m ON m.id = s.membership_id
      WHERE s.token_hash = p_token_hash AND s.expires_at > now() AND s.last_seen_at > now() - p_idle;
  END $$;
REVOKE ALL ON FUNCTION app.resolve_session(bytea, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea, interval) TO aafm_app;
