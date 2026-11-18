-- Feature F7 (Prompts 68-69): request access to one figure of another team ("I want to see
-- ARPU of Finance only"), modelled on Google Drive's request-access flow: the requester gives a
-- reason, the team's Admins (and the Super Admin) approve with an expiry or decline, and both
-- sides are notified.
--
-- What an approval grants (Prompt 69: "that one metric, read-only"): exactly the requested
-- metric or KPI, as computed values, until it expires. It is NOT an RLS grant on metric rows:
-- a KPI is computed from two base metrics, and row access would expose those raw figures and
-- mix them into the requester's own totals. Shared figures are read only through
-- app.shared_series / app.shared_summary, which check the grant on every call.

CREATE TABLE access_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  requester_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requester_name text NOT NULL, -- copied at request time: the approvers can't see other teams' users
  target_team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  source_kind    text NOT NULL CHECK (source_kind IN ('metric', 'kpi')),
  source         text NOT NULL, -- a metric name or a KPI key
  -- the base metrics used: [metric] for a metric, [numerator, denominator] for a KPI
  metrics        metric_name[] NOT NULL CHECK (cardinality(metrics) BETWEEN 1 AND 2),
  reason         text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  days           integer NOT NULL CHECK (days BETWEEN 1 AND 90), -- requested duration
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'declined', 'revoked')),
  decided_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at     timestamptz,
  decision_note  text CHECK (length(decision_note) <= 500),
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (expires_at IS NOT NULL))
);
-- One open request per person, team and figure.
CREATE UNIQUE INDEX access_requests_one_pending_uq
  ON access_requests (requester_id, target_team_id, source) WHERE status = 'pending';
CREATE INDEX access_requests_requester_idx ON access_requests (requester_id, created_at DESC);
CREATE INDEX access_requests_team_idx ON access_requests (target_team_id, created_at DESC);

-- Visible to the requester, to the target team's Admins (in that team's context) and to the
-- Super Admin. Decisions (UPDATE) only by those approvers; requests are created through
-- app.request_access, which checks the figure and the team.
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY access_requests_read ON access_requests FOR SELECT
  USING (org_id = app.current_org_id()
         AND (requester_id = app.current_user_id()
              OR (SELECT app.active_role()) = 'super_admin'
              OR ((SELECT app.active_role()) = 'admin' AND target_team_id = app.current_team_id())));
CREATE POLICY access_requests_decide ON access_requests FOR UPDATE
  USING (org_id = app.current_org_id()
         AND ((SELECT app.active_role()) = 'super_admin'
              OR ((SELECT app.active_role()) = 'admin' AND target_team_id = app.current_team_id())))
  WITH CHECK (org_id = app.current_org_id());
GRANT SELECT ON access_requests TO aafm_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, expires_at) ON access_requests TO aafm_app;

-- Team names of the whole organization (names only), so anyone can pick whom to ask.
CREATE FUNCTION app.team_directory() RETURNS TABLE (id uuid, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.name FROM teams t
    WHERE t.org_id = app.current_org_id() AND app.current_user_id() IS NOT NULL
    ORDER BY t.name
  $$;

-- Create a request. Refuses: another org's team, your own current team, an unknown figure, and
-- a person who can already see that team. Returns the request and who should approve it (the
-- target team's Admins and the org's Super Admins) for the notifications.
CREATE FUNCTION app.request_access(p_team uuid, p_kind text, p_source text, p_reason text,
                                   p_days integer)
  RETURNS TABLE (request_id uuid, approver_ids uuid[], team_name text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_metrics metric_name[];
    v_id uuid;
  BEGIN
    IF app.active_role() IS NULL
       OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = p_team AND t.org_id = app.current_org_id()) THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    IF app.active_role() = 'super_admin' OR EXISTS (
         SELECT 1 FROM memberships m WHERE m.user_id = app.current_user_id() AND m.team_id = p_team) THEN
      RAISE EXCEPTION 'You can already see this team''s data' USING ERRCODE = 'LIM01';
    END IF;
    v_metrics := CASE
      WHEN p_kind = 'metric' AND p_source IN ('revenue', 'page_views', 'clicks', 'errors', 'users')
        THEN ARRAY[p_source::metric_name]
      WHEN p_kind = 'kpi' AND p_source = 'arpu' THEN ARRAY['revenue', 'users']::metric_name[]
      WHEN p_kind = 'kpi' AND p_source = 'ctr' THEN ARRAY['clicks', 'page_views']::metric_name[]
      WHEN p_kind = 'kpi' AND p_source = 'error_rate' THEN ARRAY['errors', 'page_views']::metric_name[]
    END;
    IF v_metrics IS NULL THEN
      RAISE EXCEPTION 'unknown metric or KPI' USING ERRCODE = '22023';
    END IF;

    INSERT INTO access_requests (org_id, requester_id, requester_name, target_team_id,
                                 source_kind, source, metrics, reason, days)
    VALUES (app.current_org_id(), app.current_user_id(),
            (SELECT u.name FROM users u WHERE u.id = app.current_user_id()),
            p_team, p_kind, p_source, v_metrics, trim(p_reason), p_days)
    RETURNING access_requests.id INTO v_id;

    RETURN QUERY
      SELECT v_id,
             ARRAY(SELECT DISTINCT m.user_id FROM memberships m
                   WHERE m.org_id = app.current_org_id()
                     AND ((m.team_id = p_team AND m.role = 'admin') OR m.role = 'super_admin')),
             (SELECT t.name FROM teams t WHERE t.id = p_team);
  END $$;

-- The grant check used by both readers: the caller's own approved, unexpired request.
CREATE FUNCTION app.granted_request(p_request uuid) RETURNS access_requests
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE r access_requests;
  BEGIN
    SELECT * INTO r FROM access_requests a
    WHERE a.id = p_request AND a.requester_id = app.current_user_id()
      AND a.org_id = app.current_org_id() AND a.status = 'approved' AND a.expires_at > now();
    IF r.id IS NULL THEN
      RAISE EXCEPTION 'no active access' USING ERRCODE = '42501';
    END IF;
    RETURN r;
  END $$;

-- The granted figure over time (one value per bucket): the metric's sum, or the KPI's ratio of
-- sums (null when the denominator is zero), for the whole team. Nothing else is returned.
CREATE FUNCTION app.shared_series(p_request uuid, p_from timestamptz, p_to timestamptz,
                                  p_bucket_ms bigint)
  RETURNS TABLE (t timestamptz, value double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE r access_requests := app.granted_request(p_request);
  BEGIN
    RETURN QUERY
      SELECT date_bin(p_bucket_ms * interval '1 millisecond', p.ts, p_from) AS t,
             CASE WHEN cardinality(r.metrics) = 1 THEN sum(p.value)
                  ELSE sum(p.value) FILTER (WHERE p.metric = r.metrics[1])
                       / NULLIF(sum(p.value) FILTER (WHERE p.metric = r.metrics[2]), 0) END
      FROM metric_points p
      WHERE p.team_id = r.target_team_id AND p.metric = ANY (r.metrics)
        AND p.ts >= p_from AND p.ts < p_to
      GROUP BY 1 ORDER BY 1;
  END $$;

-- The granted figure for the last range and the range before (for the change arrow).
CREATE FUNCTION app.shared_summary(p_request uuid, p_range_ms bigint)
  RETURNS TABLE (current double precision, previous double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    r access_requests := app.granted_request(p_request);
    v_cut timestamptz := now() - p_range_ms * interval '1 millisecond';
  BEGIN
    RETURN QUERY
      WITH s AS (
        SELECT (p.ts > v_cut) AS recent, p.metric, sum(p.value) AS total
        FROM metric_points p
        WHERE p.team_id = r.target_team_id AND p.metric = ANY (r.metrics)
          AND p.ts > v_cut - p_range_ms * interval '1 millisecond'
        GROUP BY 1, 2
      )
      SELECT
        CASE WHEN cardinality(r.metrics) = 1
             THEN coalesce((SELECT total FROM s WHERE recent AND metric = r.metrics[1]), 0)
             ELSE (SELECT total FROM s WHERE recent AND metric = r.metrics[1])
                  / NULLIF((SELECT total FROM s WHERE recent AND metric = r.metrics[2]), 0) END,
        CASE WHEN cardinality(r.metrics) = 1
             THEN coalesce((SELECT total FROM s WHERE NOT recent AND metric = r.metrics[1]), 0)
             ELSE (SELECT total FROM s WHERE NOT recent AND metric = r.metrics[1])
                  / NULLIF((SELECT total FROM s WHERE NOT recent AND metric = r.metrics[2]), 0) END;
  END $$;

REVOKE ALL ON FUNCTION app.team_directory(),
  app.request_access(uuid, text, text, text, integer), app.granted_request(uuid),
  app.shared_series(uuid, timestamptz, timestamptz, bigint), app.shared_summary(uuid, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.team_directory(),
  app.request_access(uuid, text, text, text, integer),
  app.shared_series(uuid, timestamptz, timestamptz, bigint), app.shared_summary(uuid, bigint)
  TO aafm_app;
