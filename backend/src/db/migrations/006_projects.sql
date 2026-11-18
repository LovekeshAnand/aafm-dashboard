-- Tier 3 A (Prompts 47-49): Org -> Team -> Project.
-- Projects belong to a team and are reached through team membership (Sentry's model,
-- Prompt 48): every member sees the team's projects with their team role, so the existing
-- team-scoped RLS keeps working unchanged. Projects own the data: metric points, dashboards
-- and alerts carry project_id, and team totals are the sum over the team's projects.
-- Composite FKs (project_id, team_id, org_id) pin every row to a project of its own team.

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  team_id    uuid NOT NULL,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  UNIQUE (team_id, name),
  UNIQUE (id, team_id, org_id)
);
CREATE INDEX projects_org_idx ON projects (org_id);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_read ON projects FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));
-- Creating, renaming and deleting projects is team administration.
CREATE POLICY projects_write ON projects FOR ALL
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id))
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO aafm_app;

-- Every team always has at least one project: existing teams get "General" now, new teams get
-- it on creation (runs as the caller, so the projects policy above still applies).
INSERT INTO projects (org_id, team_id, name) SELECT org_id, id, 'General' FROM teams;

CREATE FUNCTION app.default_project() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    INSERT INTO projects (org_id, team_id, name) VALUES (NEW.org_id, NEW.id, 'General');
    RETURN NEW;
  END $$;
CREATE TRIGGER teams_default_project AFTER INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION app.default_project();

-- Existing rows move into their team's "General" project.
ALTER TABLE dashboards ADD COLUMN project_id uuid;
UPDATE dashboards d SET project_id = p.id FROM projects p WHERE p.team_id = d.team_id;
ALTER TABLE dashboards
  ALTER COLUMN project_id SET NOT NULL,
  ADD FOREIGN KEY (project_id, team_id, org_id) REFERENCES projects (id, team_id, org_id) ON DELETE CASCADE;
CREATE INDEX dashboards_project_idx ON dashboards (project_id, updated_at DESC);

ALTER TABLE metric_points ADD COLUMN project_id uuid;
UPDATE metric_points m SET project_id = p.id FROM projects p WHERE p.team_id = m.team_id;
ALTER TABLE metric_points
  ALTER COLUMN project_id SET NOT NULL,
  DROP CONSTRAINT metric_points_pkey,
  ADD PRIMARY KEY (project_id, metric, ts),
  ADD FOREIGN KEY (project_id, team_id, org_id) REFERENCES projects (id, team_id, org_id) ON DELETE CASCADE;
-- Team-level reads (team totals, RLS by team) keep an index of their own.
CREATE INDEX metric_points_team_idx ON metric_points (team_id, metric, ts);

ALTER TABLE alerts ADD COLUMN project_id uuid;
UPDATE alerts a SET project_id = p.id FROM projects p WHERE p.team_id = a.team_id;
ALTER TABLE alerts
  ALTER COLUMN project_id SET NOT NULL,
  ADD FOREIGN KEY (project_id, team_id, org_id) REFERENCES projects (id, team_id, org_id) ON DELETE CASCADE;
DROP INDEX alerts_one_open_uq;
CREATE UNIQUE INDEX alerts_one_open_uq ON alerts (project_id, metric) WHERE status = 'open';
CREATE INDEX alerts_project_recent_idx ON alerts (project_id, opened_at DESC);

-- Incidents are transient simulator state, so the table is simply rebuilt per project.
DROP TABLE metric_incidents;
CREATE TABLE metric_incidents (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  metric     metric_name NOT NULL,
  until      timestamptz NOT NULL,
  PRIMARY KEY (project_id, metric)
);

-- The simulator and the detector now work per project (same formulas as migrations 003/004).
DROP FUNCTION app.simulate_tick(integer);
CREATE FUNCTION app.simulate_tick(p_seconds integer)
  RETURNS TABLE (org_id uuid, team_id uuid, project_id uuid, metric metric_name, ts timestamptz,
                 value double precision)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    IF p_seconds NOT BETWEEN 1 AND 300 THEN
      RAISE EXCEPTION 'tick length must be 1-300 seconds' USING ERRCODE = '22023';
    END IF;

    PERFORM 1 FROM simulator_state
    WHERE last_tick <= now() - make_interval(secs => p_seconds * 0.9);
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE simulator_state SET last_tick = now();

    INSERT INTO metric_incidents (project_id, metric, until)
    SELECT p.id, m, now() + interval '3 minutes'
    FROM projects p CROSS JOIN unnest(enum_range(NULL::metric_name)) m
    WHERE random() < p_seconds / 14400.0
    ON CONFLICT (project_id, metric) DO UPDATE SET until = excluded.until
      WHERE metric_incidents.until < now();

    IF extract(minute FROM now()) = 0 AND extract(second FROM now()) < p_seconds THEN
      DELETE FROM metric_points WHERE metric_points.ts < now() - interval '30 days';
    END IF;

    RETURN QUERY
      INSERT INTO metric_points (org_id, team_id, project_id, metric, ts, value)
      SELECT p.org_id, p.team_id, p.id, b.metric, date_trunc('second', now()),
             round((b.base * app.team_scale(p.id)
                    * (1 + 0.3 * sin(2 * pi() * extract(hour FROM now()) / 24))
                    * (0.85 + random() * 0.3)
                    * CASE WHEN i.until > now() THEN 4 ELSE 1 END
                    * p_seconds / 300.0)::numeric, 4)
      FROM projects p
      CROSS JOIN (VALUES ('revenue'::metric_name, 500.0), ('page_views', 1200.0),
                         ('clicks', 300.0), ('errors', 5.0), ('users', 120.0)) b(metric, base)
      LEFT JOIN metric_incidents i ON i.project_id = p.id AND i.metric = b.metric
      ON CONFLICT DO NOTHING
      RETURNING metric_points.org_id, metric_points.team_id, metric_points.project_id,
                metric_points.metric, metric_points.ts, metric_points.value;
  END $$;

DROP FUNCTION app.detect_anomalies(integer);
CREATE FUNCTION app.detect_anomalies(p_tick_seconds integer)
  RETURNS TABLE (action text, id uuid, org_id uuid, team_id uuid, project_id uuid,
                 metric metric_name, direction text, value double precision,
                 mean double precision, stddev double precision, z double precision,
                 opened_at timestamptz, resolved_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE
    s record;
    v_z double precision;
    v_open alerts%ROWTYPE;
  BEGIN
    FOR s IN
      WITH series AS (
        SELECT p.org_id, p.team_id, p.id AS project_id, m AS metric
        FROM projects p CROSS JOIN unnest(enum_range(NULL::metric_name)) m
      ),
      cur AS (
        SELECT mp.project_id, mp.metric, sum(mp.value) AS total, count(*) AS points
        FROM metric_points mp
        WHERE mp.ts > now() - interval '5 minutes'
        GROUP BY mp.project_id, mp.metric
      ),
      buckets AS (
        SELECT mp.project_id, mp.metric,
               date_bin('5 minutes', mp.ts, now() - interval '65 minutes') AS b, sum(mp.value) AS total
        FROM metric_points mp
        WHERE mp.ts > now() - interval '65 minutes' AND mp.ts <= now() - interval '5 minutes'
        GROUP BY 1, 2, 3
      ),
      base AS (
        SELECT project_id, metric, avg(total) AS mean, stddev_samp(total) AS sd, count(*) AS n
        FROM buckets GROUP BY project_id, metric
      )
      SELECT se.org_id, se.team_id, se.project_id, se.metric, c.total, c.points, b.mean, b.sd, b.n
      FROM series se
      JOIN cur c USING (project_id, metric)
      JOIN base b USING (project_id, metric)
    LOOP
      SELECT * INTO v_open FROM alerts a
      WHERE a.project_id = s.project_id AND a.metric = s.metric AND a.status = 'open';

      CONTINUE WHEN s.n < 10 OR s.mean IS NULL OR s.mean <= 0
                 OR s.points < 0.9 * (300.0 / p_tick_seconds);

      v_z := (s.total - s.mean) / greatest(coalesce(s.sd, 0), 0.1 * s.mean);

      IF v_open.id IS NULL AND abs(v_z) > 2 THEN
        RETURN QUERY
          INSERT INTO alerts (org_id, team_id, project_id, metric, direction, value, mean, stddev, z, peak_z)
          VALUES (s.org_id, s.team_id, s.project_id, s.metric,
                  CASE WHEN v_z > 0 THEN 'above' ELSE 'below' END,
                  s.total, s.mean, coalesce(s.sd, 0), v_z, abs(v_z))
          RETURNING 'opened'::text, alerts.id, alerts.org_id, alerts.team_id, alerts.project_id,
                    alerts.metric, alerts.direction, alerts.value, alerts.mean, alerts.stddev,
                    alerts.z, alerts.opened_at, alerts.resolved_at;
      ELSIF v_open.id IS NOT NULL AND abs(v_z) < 1.5 THEN
        RETURN QUERY
          UPDATE alerts SET status = 'resolved', resolved_at = now()
          WHERE alerts.id = v_open.id
          RETURNING 'resolved'::text, alerts.id, alerts.org_id, alerts.team_id, alerts.project_id,
                    alerts.metric, alerts.direction, alerts.value, alerts.mean, alerts.stddev,
                    alerts.z, alerts.opened_at, alerts.resolved_at;
      ELSIF v_open.id IS NOT NULL AND abs(v_z) > v_open.peak_z THEN
        UPDATE alerts SET peak_z = abs(v_z) WHERE alerts.id = v_open.id;
      END IF;
    END LOOP;
  END $$;

REVOKE ALL ON FUNCTION app.simulate_tick(integer), app.detect_anomalies(integer),
  app.default_project() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.simulate_tick(integer), app.detect_anomalies(integer) TO aafm_app;
