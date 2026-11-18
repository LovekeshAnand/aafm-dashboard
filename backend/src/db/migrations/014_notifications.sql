-- Features F3 + F4 (Prompts 68-69): in-app notifications.
-- People are told when an admin changes something about their access: added to a team, removed
-- from one, role changed, password reset, team deleted, and when their own password changes
-- (a security notice). The data-access requests (F7) use the same centre, so their kinds are
-- included now. Delivery: a row per recipient under RLS, pushed live to the recipient's
-- socket room by the API after commit.

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN (
               'team_added', 'team_removed', 'role_changed', 'password_reset',
               'password_changed', 'team_deleted',
               'access_requested', 'access_approved', 'access_declined')),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 500),
  link       text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&.-]*$'), -- in-app paths only
  meta       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Each person reads and marks only their own; nobody can write someone else's.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_own_read ON notifications FOR SELECT
  USING (user_id = app.current_user_id() AND org_id = app.current_org_id());
CREATE POLICY notifications_own_update ON notifications FOR UPDATE
  USING (user_id = app.current_user_id() AND org_id = app.current_org_id())
  WITH CHECK (user_id = app.current_user_id() AND org_id = app.current_org_id());
GRANT SELECT ON notifications TO aafm_app;
GRANT UPDATE (read_at) ON notifications TO aafm_app;

-- The only way to notify someone: a signed-in request may notify a user of its own
-- organization (never another tenant). Returns the new row for the live push.
CREATE FUNCTION app.notify(p_user uuid, p_kind text, p_title text, p_body text, p_link text,
                           p_meta jsonb)
  RETURNS TABLE (id uuid, user_id uuid, kind text, title text, body text, link text,
                 meta jsonb, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    IF app.current_user_id() IS NULL
       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user AND u.org_id = app.current_org_id()) THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
      INSERT INTO notifications (org_id, user_id, kind, title, body, link, meta)
      VALUES (app.current_org_id(), p_user, p_kind, p_title, coalesce(p_body, ''), p_link,
              coalesce(p_meta, '{}'))
      RETURNING notifications.id, notifications.user_id, notifications.kind,
                notifications.title, notifications.body, notifications.link,
                notifications.meta, notifications.created_at;
  END $$;

REVOKE ALL ON FUNCTION app.notify(uuid, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notify(uuid, text, text, text, text, jsonb) TO aafm_app;

-- Housekeeping also drops notifications read more than 90 days ago (otherwise as in 012).
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
    DELETE FROM metric_points WHERE ts < now() - interval '30 days';
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
