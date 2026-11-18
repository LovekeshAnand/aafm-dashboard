-- Tier 3 B (Prompts 47-49): audit log, "who accessed what".
-- What is recorded (Prompt 48, "named reads"): sign-in success and failure, sign-out, team
-- switch, password changes and resets, every write, opening a dashboard, viewing members or the
-- audit log itself, and every permission denial. Metric polling is not recorded. Secrets,
-- passwords and session tokens are never recorded (OWASP Logging Cheat Sheet).
--
-- Integrity (OWASP: "build in tamper detection"; a restricted writer account):
--   * the app role can only call app.audit(); it has no INSERT, UPDATE or DELETE on the table;
--   * a trigger refuses UPDATE and DELETE for everyone, the owner included;
--   * rows are hash-chained per organization, hash = sha256(prev_hash || row), the same idea
--     as AWS CloudTrail's chained digests, so app.audit_verify() finds the first edited or
--     removed row. Ceiling: removing the newest rows (the tail) isn't detectable from the
--     chain alone; CloudTrail closes that by signing periodic digests, the upgrade path here.
-- org_id / team_id are plain columns, not foreign keys: the trail outlives deleted teams and
-- organizations (a cascading delete would also collide with the append-only rule).

CREATE SEQUENCE audit_log_seq;
CREATE TABLE audit_log (
  seq         bigint PRIMARY KEY DEFAULT nextval('audit_log_seq'),
  org_id      uuid NOT NULL,
  team_id     uuid,
  actor_id    uuid,
  actor_name  text,
  action      text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type text,
  target_id   text,
  result      text NOT NULL DEFAULT 'allowed' CHECK (result IN ('allowed', 'denied', 'failed')),
  ip          text,
  user_agent  text,
  meta        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash   bytea,
  hash        bytea NOT NULL
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, seq DESC);
CREATE INDEX audit_log_team_idx ON audit_log (team_id, seq DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, seq DESC);

-- The exact bytes that are hashed. Timestamps as epoch microseconds, so the TimeZone setting
-- can't change the result; jsonb::text is already normalized.
CREATE FUNCTION app.audit_row_bytes(a audit_log) RETURNS bytea
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT convert_to(concat_ws('|', a.seq, a.org_id, a.team_id, a.actor_id, a.actor_name,
             a.action, a.target_type, a.target_id, a.result, a.ip, a.user_agent, a.meta::text,
             (extract(epoch FROM a.at) * 1000000)::bigint), 'UTF8')
  $$;

CREATE FUNCTION app.audit_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_append_only();

-- Super Admin reads the whole org; a team Admin reads their own team's entries.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_read ON audit_log FOR SELECT
  USING (org_id = app.current_org_id()
         AND ((SELECT app.active_role()) = 'super_admin'
              OR ((SELECT app.active_role()) = 'admin' AND team_id = app.current_team_id())));
GRANT SELECT ON audit_log TO aafm_app;

-- The only way in. The actor and org come from the request context, not from arguments, so a
-- caller can't write entries in someone else's name. p_team defaults to the session's team.
CREATE FUNCTION app.audit(p_action text, p_target_type text, p_target_id text, p_result text,
                          p_meta jsonb, p_ip text, p_user_agent text, p_team uuid DEFAULT NULL)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_org uuid := app.current_org_id();
    v_row audit_log;
  BEGIN
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'audit needs an organization context' USING ERRCODE = '42501';
    END IF;
    -- One writer per org at a time keeps the chain linear.
    -- ponytail: serializes audit writes within an org; batch or digest hourly at high volume.
    PERFORM pg_advisory_xact_lock(hashtext('audit:' || v_org));

    -- The whole row, seq and timestamp included, is built first so its hash can be stored
    -- in the same INSERT (no UPDATE ever touches the table).
    v_row.seq := nextval('audit_log_seq');
    v_row.org_id := v_org;
    v_row.team_id := coalesce(p_team, app.current_team_id());
    v_row.actor_id := app.current_user_id();
    v_row.actor_name := (SELECT u.name FROM users u WHERE u.id = v_row.actor_id);
    v_row.action := p_action;
    v_row.target_type := p_target_type;
    v_row.target_id := p_target_id;
    v_row.result := coalesce(p_result, 'allowed');
    v_row.ip := left(p_ip, 64);
    v_row.user_agent := left(p_user_agent, 200);
    v_row.meta := coalesce(p_meta, '{}');
    v_row.at := clock_timestamp();
    v_row.prev_hash := (SELECT a.hash FROM audit_log a WHERE a.org_id = v_org ORDER BY a.seq DESC LIMIT 1);
    v_row.hash := sha256(coalesce(v_row.prev_hash, '') || app.audit_row_bytes(v_row));
    INSERT INTO audit_log SELECT v_row.*;
  END $$;

-- Recomputes the caller's org chain. Returns the first broken seq, or NULL if intact.
CREATE FUNCTION app.audit_verify() RETURNS TABLE (checked bigint, first_broken bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    r audit_log;
    v_prev bytea;
    v_count bigint := 0;
  BEGIN
    IF coalesce(app.active_role() NOT IN ('super_admin', 'admin'), true) THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    FOR r IN SELECT * FROM audit_log WHERE org_id = app.current_org_id() ORDER BY seq LOOP
      v_count := v_count + 1;
      IF r.prev_hash IS DISTINCT FROM v_prev
         OR r.hash <> sha256(coalesce(r.prev_hash, '') || app.audit_row_bytes(r)) THEN
        RETURN QUERY SELECT v_count, r.seq;
        RETURN;
      END IF;
      v_prev := r.hash;
    END LOOP;
    RETURN QUERY SELECT v_count, NULL::bigint;
  END $$;

REVOKE ALL ON FUNCTION app.audit(text, text, text, text, jsonb, text, text, uuid),
  app.audit_verify(), app.audit_row_bytes(audit_log), app.audit_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit(text, text, text, text, jsonb, text, text, uuid),
  app.audit_verify() TO aafm_app;
