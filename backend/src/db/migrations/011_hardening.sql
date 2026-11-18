-- Production hardening (Prompts 51-53, docs/edge-case-audit.md).
--   E2-E4  resource caps, enforced in the database so no code path can bypass them
--   E9     time limits on every app-role query and transaction
--   E14/17 housekeeping: expired sessions, old webhook deliveries, idempotency keys, metrics
--   E19    Loki-style audit archive: recent entries stay as indexed rows; older ones are packed
--          per org and hour into LZ4-compressed JSON segments indexed by labels (teams, actors,
--          actions, results, time). Every entry is kept, the hash chain spans both, and RLS
--          rules are applied by the only functions that read the archive.
--   E20    Idempotency-Key storage

-- ---------------------------------------------------------------------------
-- E9: time limits (node-postgres has no default timeouts at all)
-- ---------------------------------------------------------------------------
ALTER ROLE aafm_app SET statement_timeout = '10s';
ALTER ROLE aafm_app SET lock_timeout = '5s';
ALTER ROLE aafm_app SET idle_in_transaction_session_timeout = '30s';

-- ---------------------------------------------------------------------------
-- E2-E4: caps (OWASP API4:2023: limit how many records a client can create)
-- SQLSTATE LIM01 is ours; the API maps it to 409 with this message.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_parent_col text := TG_ARGV[0];
    v_cap integer := TG_ARGV[1]::integer;
    v_label text := TG_ARGV[2];
    v_parent uuid;
    v_count integer;
  BEGIN
    v_parent := (to_jsonb(NEW) ->> v_parent_col)::uuid;
    -- Serialize inserts under the same parent so two concurrent inserts can't both pass.
    PERFORM pg_advisory_xact_lock(hashtext('cap:' || TG_TABLE_NAME || ':' || v_parent));
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', TG_TABLE_NAME, v_parent_col)
      INTO v_count USING v_parent;
    IF v_count >= v_cap THEN
      RAISE EXCEPTION 'Limit reached: at most % %', v_cap, v_label USING ERRCODE = 'LIM01';
    END IF;
    RETURN NEW;
  END $$;

CREATE TRIGGER projects_cap BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_cap('team_id', '25', 'projects per team');
CREATE TRIGGER teams_cap BEFORE INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION app.enforce_cap('org_id', '50', 'teams per organization');
CREATE TRIGGER webhooks_cap BEFORE INSERT ON webhooks
  FOR EACH ROW EXECUTE FUNCTION app.enforce_cap('team_id', '10', 'webhooks per team');
CREATE TRIGGER custom_metrics_cap BEFORE INSERT ON custom_metrics
  FOR EACH ROW EXECUTE FUNCTION app.enforce_cap('team_id', '50', 'custom metrics per team');

-- ---------------------------------------------------------------------------
-- E20: Idempotency-Key (IETF draft-ietf-httpapi-idempotency-key-header), per user, 24 h
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,          -- method + path + body, to refuse key reuse (422)
  status_code  integer,                -- NULL while the first request is still running (409)
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_own ON idempotency_keys FOR ALL
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO aafm_app;

-- ---------------------------------------------------------------------------
-- E19: compressed audit archive
-- ---------------------------------------------------------------------------
CREATE TABLE audit_segments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid NOT NULL,
  hour        timestamptz NOT NULL,
  first_seq   bigint NOT NULL,
  last_seq    bigint NOT NULL,
  first_at    timestamptz NOT NULL,
  last_at     timestamptz NOT NULL,
  entry_count integer NOT NULL,
  -- the label index (Loki indexes labels only; the lines live in compressed chunks)
  team_ids    uuid[] NOT NULL,
  actor_ids   uuid[] NOT NULL,
  actions     text[] NOT NULL,
  results     text[] NOT NULL,
  entries     jsonb COMPRESSION lz4 NOT NULL, -- the original rows, hashes included, in seq order
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_segments_org_seq_idx ON audit_segments (org_id, last_seq DESC);
CREATE INDEX audit_segments_teams_idx ON audit_segments USING gin (team_ids);
CREATE INDEX audit_segments_actors_idx ON audit_segments USING gin (actor_ids);
-- No grants and no policies: the app role reaches the archive only through the functions below.
ALTER TABLE audit_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_segments FORCE ROW LEVEL SECURITY;
CREATE TRIGGER audit_segments_append_only BEFORE UPDATE OR DELETE ON audit_segments
  FOR EACH ROW EXECUTE FUNCTION app.audit_append_only();

-- Rows may leave audit_log only to move into a segment, inside app.compact_audit().
CREATE OR REPLACE FUNCTION app.audit_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_log'
       AND current_setting('app.audit_compacting', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
  END $$;

-- Packs up to p_max_buckets (org, hour) buckets older than p_hot into segments. The newest
-- entry of each org always stays in audit_log, because the next append chains onto it.
-- p_org limits the run to one organization (NULL = all).
CREATE FUNCTION app.compact_audit(p_hot interval, p_max_buckets integer DEFAULT 24,
                                  p_org uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    b record;
    v_done integer := 0;
  BEGIN
    PERFORM set_config('app.audit_compacting', 'on', true);
    FOR b IN
      SELECT a.org_id, date_trunc('hour', a.at) AS hour
      FROM audit_log a
      WHERE a.at < date_trunc('hour', now() - p_hot)
        AND (p_org IS NULL OR a.org_id = p_org)
      GROUP BY 1, 2
      ORDER BY 2
      LIMIT p_max_buckets
    LOOP
      PERFORM pg_advisory_xact_lock(hashtext('audit:' || b.org_id)); -- no append in between
      WITH moved AS (
        DELETE FROM audit_log a
        WHERE a.org_id = b.org_id AND a.at >= b.hour AND a.at < b.hour + interval '1 hour'
          AND a.seq < (SELECT max(x.seq) FROM audit_log x WHERE x.org_id = b.org_id)
        RETURNING a.*
      )
      INSERT INTO audit_segments (org_id, hour, first_seq, last_seq, first_at, last_at, entry_count,
                                  team_ids, actor_ids, actions, results, entries)
      SELECT b.org_id, b.hour, min(m.seq), max(m.seq), min(m.at), max(m.at), count(*),
             coalesce(array_agg(DISTINCT m.team_id) FILTER (WHERE m.team_id IS NOT NULL), '{}'),
             coalesce(array_agg(DISTINCT m.actor_id) FILTER (WHERE m.actor_id IS NOT NULL), '{}'),
             array_agg(DISTINCT m.action), array_agg(DISTINCT m.result),
             jsonb_agg(to_jsonb(m) ORDER BY m.seq)
      FROM moved m
      HAVING count(*) > 0;
      IF FOUND THEN v_done := v_done + 1; END IF;
    END LOOP;
    RETURN v_done;
  END $$;

-- One archive page, newest first, with the same visibility as the audit_log_read policy:
-- the Super Admin sees the org, an Admin only their own team's entries. Segments are pruned by
-- their labels, then expanded one at a time. If p_max_segments are scanned before p_limit
-- entries are found, a final row carries `resume_before` so the caller can continue.
CREATE FUNCTION app.audit_archive_page(p_before bigint, p_limit integer, p_actor uuid,
                                       p_action text, p_team uuid, p_result text,
                                       p_from timestamptz, p_to timestamptz,
                                       p_max_segments integer DEFAULT 200)
  RETURNS TABLE (entry jsonb, resume_before bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_role member_role := app.active_role();
    v_team uuid := p_team;
    s record;
    v_found integer := 0;
    v_scanned integer := 0;
  BEGIN
    IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    IF v_role = 'admin' THEN
      IF p_team IS NOT NULL AND p_team <> app.current_team_id() THEN RETURN; END IF;
      v_team := app.current_team_id();
    END IF;

    FOR s IN
      SELECT g.id, g.last_seq, g.entries FROM audit_segments g
      WHERE g.org_id = app.current_org_id()
        AND (p_before IS NULL OR g.first_seq < p_before)
        AND (p_actor IS NULL OR g.actor_ids @> ARRAY[p_actor])
        AND (v_team IS NULL OR g.team_ids @> ARRAY[v_team])
        AND (p_result IS NULL OR g.results @> ARRAY[p_result])
        AND (p_action IS NULL OR EXISTS (SELECT 1 FROM unnest(g.actions) x WHERE x LIKE p_action || '%'))
        AND (p_from IS NULL OR g.last_at >= p_from)
        AND (p_to IS NULL OR g.first_at < p_to)
      ORDER BY g.last_seq DESC
    LOOP
      IF v_scanned >= p_max_segments THEN
        RETURN QUERY SELECT NULL::jsonb, s.last_seq + 1; -- continue from this unread segment
        RETURN;
      END IF;
      v_scanned := v_scanned + 1;
      RETURN QUERY
        SELECT to_jsonb(r) - 'hash' - 'prev_hash', NULL::bigint
        FROM jsonb_populate_recordset(NULL::audit_log, s.entries) r
        WHERE (p_before IS NULL OR r.seq < p_before)
          AND (p_actor IS NULL OR r.actor_id = p_actor)
          AND (v_team IS NULL OR r.team_id = v_team)
          AND (p_result IS NULL OR r.result = p_result)
          AND (p_action IS NULL OR r.action LIKE p_action || '%')
          AND (p_from IS NULL OR r.at >= p_from)
          AND (p_to IS NULL OR r.at < p_to)
        ORDER BY r.seq DESC;
      GET DIAGNOSTICS v_found = ROW_COUNT;
      p_limit := p_limit - v_found;
      EXIT WHEN p_limit <= 0;
    END LOOP;
  END $$;

-- The chain now spans archived and live entries. One SELECT = one snapshot, so a compaction
-- running at the same time can't make an intact chain look broken.
CREATE OR REPLACE FUNCTION app.audit_verify() RETURNS TABLE (checked bigint, first_broken bigint)
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
    FOR r IN
      SELECT x.* FROM (
        SELECT e.* FROM audit_segments g,
               jsonb_populate_recordset(NULL::audit_log, g.entries) e
        WHERE g.org_id = app.current_org_id()
        UNION ALL
        SELECT a.* FROM audit_log a WHERE a.org_id = app.current_org_id()
      ) x ORDER BY x.seq
    LOOP
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

-- Storage figures for the Audit page: live rows, archived entries, and the archive's size as
-- stored (compressed) next to its size as plain JSON.
CREATE FUNCTION app.audit_storage()
  RETURNS TABLE (live_entries bigint, archived_entries bigint, segments bigint,
                 archive_raw_bytes bigint, archive_stored_bytes bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT (SELECT count(*) FROM audit_log WHERE org_id = app.current_org_id()),
           coalesce(sum(entry_count), 0), count(*),
           coalesce(sum(octet_length(entries::text)), 0), coalesce(sum(pg_column_size(entries)), 0)
    FROM audit_segments
    WHERE org_id = app.current_org_id()
      AND coalesce(app.active_role() IN ('super_admin', 'admin'), false)
  $$;

-- ---------------------------------------------------------------------------
-- E14/E17/E19/E20: housekeeping, run by one instance at a time every few minutes.
-- Each step is bounded so the call stays well inside the 10 s statement timeout.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.housekeeping(p_session_idle interval, p_audit_hot interval)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_sessions integer;
    v_deliveries integer;
    v_keys integer;
    v_points integer;
    v_segments integer;
  BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtext('housekeeping')) THEN
      RETURN NULL; -- another instance is on it
    END IF;
    DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - p_session_idle;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;
    DELETE FROM webhook_deliveries WHERE id IN (
      SELECT id FROM webhook_deliveries
      WHERE status IN ('delivered', 'failed') AND created_at < now() - interval '30 days'
      LIMIT 10000);
    GET DIAGNOSTICS v_deliveries = ROW_COUNT;
    DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_keys = ROW_COUNT;
    DELETE FROM metric_points WHERE ts < now() - interval '30 days';
    GET DIAGNOSTICS v_points = ROW_COUNT;
    v_segments := app.compact_audit(p_audit_hot);
    RETURN jsonb_build_object('sessions', v_sessions, 'deliveries', v_deliveries,
                              'idempotency_keys', v_keys, 'metric_points', v_points,
                              'audit_segments', v_segments);
  END $$;

REVOKE ALL ON FUNCTION app.enforce_cap(), app.compact_audit(interval, integer, uuid),
  app.audit_archive_page(bigint, integer, uuid, text, uuid, text, timestamptz, timestamptz, integer),
  app.audit_storage(), app.housekeeping(interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.audit_archive_page(bigint, integer, uuid, text, uuid, text, timestamptz, timestamptz, integer),
  app.audit_storage(), app.housekeeping(interval, interval) TO aafm_app;
