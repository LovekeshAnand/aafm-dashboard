-- Tier 2 D (Prompts 37-41): anomaly detection with a fixed rule per metric (Prompt 38: no
-- sensitivity settings in Tier 2).
--
-- Rule, evaluated every 30 s for every team x metric:
--   current  = sum of the last 5 minutes of live points
--   baseline = the previous hour as twelve 5-minute buckets: mean and sample stddev
--   z        = (current - mean) / max(stddev, 10% of mean)
--   open  an alert when |z| > 2    (the brief's "alert if metric > 2 sigma", both directions)
--   close it       when |z| < 1.5  (stricter recovery threshold = hysteresis, so a value
--                                   hovering near 2 sigma doesn't flap; Datadog recovery
--                                   thresholds / Zabbix recovery expressions)
-- Guards against false alarms:
--   * at least 10 full baseline buckets (50 minutes of history);
--   * the current window must be >= 90% covered by live ticks (no alert from a gap after a
--     restart, or from 5-minute seeded history being compared with 5-second ticks);
--   * the 10%-of-mean floor on sigma, so a nearly constant series can't alert on tiny moves.
-- A trailing hour (not 24 h) keeps the daily cycle out of sigma. Seasonality-aware baselines
-- are a documented ceiling.

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  team_id     uuid NOT NULL,
  metric      metric_name NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  direction   text NOT NULL CHECK (direction IN ('above', 'below')),
  value       double precision NOT NULL,   -- the 5-minute sum that triggered it
  mean        double precision NOT NULL,
  stddev      double precision NOT NULL,
  z           double precision NOT NULL,
  peak_z      double precision NOT NULL,   -- largest |z| while open
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
-- At most one open alert per team x metric.
CREATE UNIQUE INDEX alerts_one_open_uq ON alerts (team_id, metric) WHERE status = 'open';
CREATE INDEX alerts_team_recent_idx ON alerts (team_id, opened_at DESC);
CREATE INDEX alerts_org_recent_idx ON alerts (org_id, opened_at DESC);

-- Read-only for the app, under the same team/org scope as everything else.
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY alerts_read ON alerts FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));
GRANT SELECT ON alerts TO aafm_app;

CREATE FUNCTION app.detect_anomalies(p_tick_seconds integer)
  RETURNS TABLE (action text, id uuid, org_id uuid, team_id uuid, metric metric_name,
                 direction text, value double precision, mean double precision,
                 stddev double precision, z double precision, opened_at timestamptz,
                 resolved_at timestamptz)
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
        SELECT t.org_id, t.id AS team_id, m AS metric
        FROM teams t CROSS JOIN unnest(enum_range(NULL::metric_name)) m
      ),
      cur AS (
        SELECT p.team_id, p.metric, sum(p.value) AS total, count(*) AS points
        FROM metric_points p
        WHERE p.ts > now() - interval '5 minutes'
        GROUP BY p.team_id, p.metric
      ),
      buckets AS (
        SELECT p.team_id, p.metric,
               date_bin('5 minutes', p.ts, now() - interval '65 minutes') AS b, sum(p.value) AS total
        FROM metric_points p
        WHERE p.ts > now() - interval '65 minutes' AND p.ts <= now() - interval '5 minutes'
        GROUP BY 1, 2, 3
      ),
      base AS (
        SELECT team_id, metric, avg(total) AS mean, stddev_samp(total) AS sd, count(*) AS n
        FROM buckets GROUP BY team_id, metric
      )
      SELECT se.org_id, se.team_id, se.metric, c.total, c.points, b.mean, b.sd, b.n
      FROM series se
      JOIN cur c USING (team_id, metric)
      JOIN base b USING (team_id, metric)
    LOOP
      SELECT * INTO v_open FROM alerts a
      WHERE a.team_id = s.team_id AND a.metric = s.metric AND a.status = 'open';

      -- Not enough reliable data: never open; an open alert stays as it is.
      CONTINUE WHEN s.n < 10 OR s.mean IS NULL OR s.mean <= 0
                 OR s.points < 0.9 * (300.0 / p_tick_seconds);

      v_z := (s.total - s.mean) / greatest(coalesce(s.sd, 0), 0.1 * s.mean);

      IF v_open.id IS NULL AND abs(v_z) > 2 THEN
        RETURN QUERY
          INSERT INTO alerts (org_id, team_id, metric, direction, value, mean, stddev, z, peak_z)
          VALUES (s.org_id, s.team_id, s.metric, CASE WHEN v_z > 0 THEN 'above' ELSE 'below' END,
                  s.total, s.mean, coalesce(s.sd, 0), v_z, abs(v_z))
          RETURNING 'opened'::text, alerts.id, alerts.org_id, alerts.team_id, alerts.metric,
                    alerts.direction, alerts.value, alerts.mean, alerts.stddev, alerts.z,
                    alerts.opened_at, alerts.resolved_at;
      ELSIF v_open.id IS NOT NULL AND abs(v_z) < 1.5 THEN
        RETURN QUERY
          UPDATE alerts SET status = 'resolved', resolved_at = now()
          WHERE alerts.id = v_open.id
          RETURNING 'resolved'::text, alerts.id, alerts.org_id, alerts.team_id, alerts.metric,
                    alerts.direction, alerts.value, alerts.mean, alerts.stddev, alerts.z,
                    alerts.opened_at, alerts.resolved_at;
      ELSIF v_open.id IS NOT NULL AND abs(v_z) > v_open.peak_z THEN
        UPDATE alerts SET peak_z = abs(v_z) WHERE alerts.id = v_open.id;
      END IF;
    END LOOP;
  END $$;

REVOKE ALL ON FUNCTION app.detect_anomalies(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.detect_anomalies(integer) TO aafm_app;
