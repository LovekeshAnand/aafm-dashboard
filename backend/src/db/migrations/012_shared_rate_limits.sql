-- Problems-log #13 (part 1): rate-limit counters shared by every API instance.
-- express-rate-limit's default store is per process, so with N instances a client gets N times
-- the budget. One small table holds the fixed-window counters instead. UNLOGGED: no WAL writes
-- (fast); after a database crash the table starts empty, which only resets the counters.
-- Keys are hashes of session tokens or client IPs, never raw tokens. Not tenant data, so no RLS
-- (like `sessions`).
CREATE UNLOGGED TABLE rate_limits (
  key      text PRIMARY KEY,
  hits     integer NOT NULL,
  reset_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO aafm_app;

-- Housekeeping also drops expired counters (otherwise identical to migration 011).
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
    DELETE FROM rate_limits WHERE reset_at < now();
    GET DIAGNOSTICS v_limits = ROW_COUNT;
    v_segments := app.compact_audit(p_audit_hot);
    RETURN jsonb_build_object('sessions', v_sessions, 'deliveries', v_deliveries,
                              'idempotency_keys', v_keys, 'metric_points', v_points,
                              'rate_limits', v_limits, 'audit_segments', v_segments);
  END $$;
