-- Tier 2 B (Prompts 37-38): live metrics.
--  * `users` (active users) becomes a fifth base metric so ARPU = revenue / users (Prompt 38).
--  * app.simulate_tick() appends one point per team per metric. Values are scaled to the tick
--    length so a 5-minute bucket of live ticks sums to the same magnitude as the seeded
--    5-minute history (no 60x jump at "now").
--  * Short "incidents" multiply a team's metric for a few minutes: genuine anomalies for the
--    detector (Tier 2 D) to find, instead of hard-coded fake alerts.
-- Note: the new enum value is not used by any statement in this migration (Postgres forbids
-- using an enum value in the transaction that adds it); it is only referenced inside the
-- plpgsql body, which runs later.

ALTER TYPE metric_name ADD VALUE IF NOT EXISTS 'users';

-- Stable per-team scale (Finance and Marketing keep differing magnitudes; new teams get one).
CREATE FUNCTION app.team_scale(p_team uuid) RETURNS double precision
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT 1 + (abs(hashtext(p_team::text)) % 100) / 100.0 $$;

CREATE TABLE metric_incidents (
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  metric  metric_name NOT NULL,
  until   timestamptz NOT NULL,
  PRIMARY KEY (team_id, metric)
);

-- Single row: when the last tick ran. Lets several API instances share one simulator
-- without double-writing (the first to claim the interval wins).
CREATE TABLE simulator_state (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_tick timestamptz NOT NULL
);
INSERT INTO simulator_state (last_tick) VALUES (now() - interval '1 day');

CREATE FUNCTION app.simulate_tick(p_seconds integer)
  RETURNS TABLE (org_id uuid, team_id uuid, metric metric_name, ts timestamptz, value double precision)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    IF p_seconds NOT BETWEEN 1 AND 300 THEN
      RAISE EXCEPTION 'tick length must be 1-300 seconds' USING ERRCODE = '22023';
    END IF;

    -- Claim this interval; another instance that ticked moments ago wins instead.
    PERFORM 1 FROM simulator_state
    WHERE last_tick <= now() - make_interval(secs => p_seconds * 0.9);
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE simulator_state SET last_tick = now();

    -- Occasionally start a 3-minute incident (about once per 4 hours per team-metric at 5s).
    INSERT INTO metric_incidents (team_id, metric, until)
    SELECT t.id, m, now() + interval '3 minutes'
    FROM teams t CROSS JOIN unnest(enum_range(NULL::metric_name)) m
    WHERE random() < p_seconds / 14400.0
    ON CONFLICT (team_id, metric) DO UPDATE SET until = excluded.until
      WHERE metric_incidents.until < now();

    -- Hourly retention: keep 30 days of points.
    IF extract(minute FROM now()) = 0 AND extract(second FROM now()) < p_seconds THEN
      DELETE FROM metric_points WHERE metric_points.ts < now() - interval '30 days';
    END IF;

    RETURN QUERY
      INSERT INTO metric_points (org_id, team_id, metric, ts, value)
      SELECT t.org_id, t.id, b.metric, date_trunc('second', now()),
             round((b.base * app.team_scale(t.id)
                    * (1 + 0.3 * sin(2 * pi() * extract(hour FROM now()) / 24))
                    * (0.85 + random() * 0.3)
                    * CASE WHEN i.until > now() THEN 4 ELSE 1 END
                    * p_seconds / 300.0)::numeric, 4)
      FROM teams t
      CROSS JOIN (VALUES ('revenue'::metric_name, 500.0), ('page_views', 1200.0),
                         ('clicks', 300.0), ('errors', 5.0), ('users', 120.0)) b(metric, base)
      LEFT JOIN metric_incidents i ON i.team_id = t.id AND i.metric = b.metric
      ON CONFLICT DO NOTHING
      RETURNING metric_points.org_id, metric_points.team_id, metric_points.metric,
                metric_points.ts, metric_points.value;
  END $$;

REVOKE ALL ON FUNCTION app.simulate_tick(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.simulate_tick(integer) TO aafm_app;
GRANT EXECUTE ON FUNCTION app.team_scale(uuid) TO aafm_app;
