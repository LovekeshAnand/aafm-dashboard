-- Feature F1 (Prompts 68-69): mark a project Completed. A completed project is frozen:
--   * live data stops (the simulator skips it) and its history is kept (retention spares it);
--   * its dashboards and widgets are read-only (enforced here, so no code path can bypass it);
--   * open alerts are closed, since no new data will ever resolve them.
-- An Admin of the team (or the Super Admin) can reopen it; data then resumes from that moment.
ALTER TABLE projects
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN completed_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- Read-only dashboards and widgets. A delete that comes from a foreign-key cascade (deleting
-- the organization or the team) is allowed: cascades run as triggers, so the depth is > 1,
-- while any direct delete runs at depth 1.
CREATE OR REPLACE FUNCTION app.project_frozen_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_project uuid;
  BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'dashboards' THEN
      v_project := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
    ELSE
      SELECT d.project_id INTO v_project FROM dashboards d
      WHERE d.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.dashboard_id ELSE NEW.dashboard_id END;
    END IF;
    IF EXISTS (SELECT 1 FROM projects p WHERE p.id = v_project AND p.completed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'This project is completed, so it is read-only. An Admin can reopen it.'
        USING ERRCODE = 'LIM01';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END $$;
CREATE TRIGGER dashboards_frozen BEFORE INSERT OR UPDATE OR DELETE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION app.project_frozen_guard();
CREATE TRIGGER widgets_frozen BEFORE INSERT OR UPDATE OR DELETE ON widgets
  FOR EACH ROW EXECUTE FUNCTION app.project_frozen_guard();

-- Completing closes the project's open alerts (alerts are otherwise written only by
-- app.detect_anomalies, which the app role can't bypass). Returns the closed alerts' team.
CREATE FUNCTION app.close_project_alerts() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE alerts SET status = 'resolved', resolved_at = now()
    WHERE project_id = NEW.id AND status = 'open';
    RETURN NEW;
  END $$;
CREATE TRIGGER projects_completed AFTER UPDATE OF completed_at ON projects
  FOR EACH ROW WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)
  EXECUTE FUNCTION app.close_project_alerts();

-- The simulator: no new data or incidents for completed projects, and retention spares them
-- (otherwise as in migration 006).
CREATE OR REPLACE FUNCTION app.simulate_tick(p_seconds integer)
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
    WHERE p.completed_at IS NULL AND random() < p_seconds / 14400.0
    ON CONFLICT (project_id, metric) DO UPDATE SET until = excluded.until
      WHERE metric_incidents.until < now();

    IF extract(minute FROM now()) = 0 AND extract(second FROM now()) < p_seconds THEN
      DELETE FROM metric_points mp WHERE mp.ts < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM projects p
                        WHERE p.id = mp.project_id AND p.completed_at IS NOT NULL);
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
      WHERE p.completed_at IS NULL
      ON CONFLICT DO NOTHING
      RETURNING metric_points.org_id, metric_points.team_id, metric_points.project_id,
                metric_points.metric, metric_points.ts, metric_points.value;
  END $$;

-- Housekeeping: retention spares completed projects (otherwise as in migration 014).
CREATE OR REPLACE FUNCTION app.housekeeping(p_session_idle interval, p_audit_hot interval)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_sessions integer;
    v_deliveries integer;
    v_keys integer;
    v_points integer;
    v_limits integer;
    v_notifications integer;
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
    DELETE FROM metric_points mp WHERE mp.ts < now() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM projects p
                      WHERE p.id = mp.project_id AND p.completed_at IS NOT NULL);
    GET DIAGNOSTICS v_points = ROW_COUNT;
    DELETE FROM rate_limits WHERE reset_at < now();
    GET DIAGNOSTICS v_limits = ROW_COUNT;
    DELETE FROM notifications WHERE read_at < now() - interval '90 days';
    GET DIAGNOSTICS v_notifications = ROW_COUNT;
    v_segments := app.compact_audit(p_audit_hot);
    RETURN jsonb_build_object('sessions', v_sessions, 'deliveries', v_deliveries,
                              'idempotency_keys', v_keys, 'metric_points', v_points,
                              'rate_limits', v_limits, 'notifications', v_notifications,
                              'audit_segments', v_segments);
  END $$;

REVOKE ALL ON FUNCTION app.project_frozen_guard(), app.close_project_alerts() FROM PUBLIC;
