-- Tier 3 C (Prompts 47-49): webhook subscriptions.
--  * Admins subscribe an endpoint per team (optionally one project) to events (Prompt 48).
--  * Standard Webhooks: every message carries webhook-id / webhook-timestamp /
--    webhook-signature, HMAC-SHA256 with a per-endpoint whsec_ secret (signing is done by the
--    API worker, src/webhooks.js). webhook-id stays the same across retries and redeliveries.
--  * Transactional outbox: a delivery row is written in the same transaction as the change
--    that caused it, so an event is never lost and never sent for a rolled-back change. The
--    worker claims due rows with FOR UPDATE SKIP LOCKED (safe with several API instances).
--  * Retries: attempt 1 at once, then +5 s, +5 min, +30 min, +2 h, +5 h (with jitter), then
--    failed. 10 consecutive failed attempts, or a 410 Gone, disable the endpoint.
--  * Secrets: the app role can't SELECT them; only the worker's claim function returns them.

CREATE TABLE webhooks (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL,
  team_id                    uuid NOT NULL,
  project_id                 uuid,
  url                        text NOT NULL CHECK (length(url) <= 2000 AND url ~ '^https?://'),
  description                text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  events                     text[] NOT NULL CHECK (
    cardinality(events) > 0
    AND events <@ ARRAY['alert.opened', 'alert.resolved', 'dashboard.created', 'dashboard.updated',
                        'dashboard.deleted', 'member.added', 'member.removed']),
  secret                     text NOT NULL,
  previous_secret            text,
  previous_secret_expires_at timestamptz,
  enabled                    boolean NOT NULL DEFAULT true,
  failure_count              integer NOT NULL DEFAULT 0,
  disabled_reason            text,
  created_by                 uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, team_id, org_id) REFERENCES projects (id, team_id, org_id) ON DELETE CASCADE
);
CREATE INDEX webhooks_team_idx ON webhooks (team_id);
CREATE INDEX webhooks_org_idx ON webhooks (org_id);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  team_id         uuid NOT NULL,
  webhook_id      uuid NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event_id        uuid NOT NULL,             -- the webhook-id header
  event           text NOT NULL,
  body            text NOT NULL,             -- the exact bytes that are signed and sent
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempt         integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  response_code   integer,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);

-- Webhooks are team administration: Admins of the team and the Super Admin.
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY webhooks_admin ON webhooks FOR ALL
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id))
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id));
GRANT SELECT (id, org_id, team_id, project_id, url, description, events, enabled, failure_count,
              disabled_reason, created_by, created_at) ON webhooks TO aafm_app;
GRANT INSERT (org_id, team_id, project_id, url, description, events, secret, created_by)
  ON webhooks TO aafm_app;
GRANT UPDATE (url, description, events, project_id, enabled, failure_count, disabled_reason)
  ON webhooks TO aafm_app;
GRANT DELETE ON webhooks TO aafm_app;

-- Deliveries: Admins read them and may queue a test or a redelivery; only the worker
-- functions below change their status.
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_read ON webhook_deliveries FOR SELECT
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id));
CREATE POLICY webhook_deliveries_insert ON webhook_deliveries FOR INSERT
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id));
GRANT SELECT, INSERT ON webhook_deliveries TO aafm_app;

-- The message body (Standard Webhooks: type, timestamp, data).
CREATE FUNCTION app.webhook_body(p_event text, p_data jsonb) RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT jsonb_build_object(
      'type', p_event,
      'timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'data', p_data)::text
  $$;

-- Internal: queue one event for every enabled, subscribed endpoint of the team.
CREATE FUNCTION app.enqueue_webhook_event(p_org uuid, p_team uuid, p_project uuid, p_event text,
                                          p_data jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_count integer;
  BEGIN
    INSERT INTO webhook_deliveries (org_id, team_id, webhook_id, event_id, event, body)
    SELECT w.org_id, w.team_id, w.id, e.event_id, p_event, app.webhook_body(p_event, p_data)
    FROM webhooks w CROSS JOIN (SELECT gen_random_uuid() AS event_id) e
    WHERE w.org_id = p_org AND w.team_id = p_team AND w.enabled AND p_event = ANY (w.events)
      AND (w.project_id IS NULL OR w.project_id IS NOT DISTINCT FROM p_project);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END $$;

-- Request path: the API calls this inside the transaction of the change itself. The team
-- must be inside the caller's context, so a request can't queue events for another tenant.
CREATE FUNCTION app.emit_webhook_event(p_team uuid, p_project uuid, p_event text, p_data jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF app.active_role() IS NULL OR NOT app.in_scope(app.current_org_id(), p_team) THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN app.enqueue_webhook_event(app.current_org_id(), p_team, p_project, p_event, p_data);
  END $$;

-- Alerts are written by app.detect_anomalies(); a trigger queues their events in the same
-- transaction.
CREATE FUNCTION app.alert_webhook() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_event text;
  BEGIN
    IF TG_OP = 'INSERT' THEN v_event := 'alert.opened';
    ELSIF OLD.status = 'open' AND NEW.status = 'resolved' THEN v_event := 'alert.resolved';
    ELSE RETURN NULL;
    END IF;
    PERFORM app.enqueue_webhook_event(NEW.org_id, NEW.team_id, NEW.project_id, v_event,
      jsonb_build_object(
        'alert', to_jsonb(NEW) - 'org_id',
        'team', (SELECT t.name FROM teams t WHERE t.id = NEW.team_id),
        'project', (SELECT p.name FROM projects p WHERE p.id = NEW.project_id)));
    RETURN NULL;
  END $$;
CREATE TRIGGER alerts_webhook AFTER INSERT OR UPDATE OF status ON alerts
  FOR EACH ROW EXECUTE FUNCTION app.alert_webhook();

-- Worker: claim due deliveries (with the endpoint and its signing secrets). A row stuck in
-- 'sending' (worker crashed mid-request) is claimed again once its lock expires.
CREATE FUNCTION app.claim_webhook_deliveries(p_limit integer)
  RETURNS TABLE (id uuid, event_id uuid, event text, body text, attempt integer, url text,
                 secret text, previous_secret text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    UPDATE webhook_deliveries d SET status = 'failed', last_error = 'Endpoint disabled'
    WHERE d.status = 'pending'
      AND d.webhook_id IN (SELECT w.id FROM webhooks w WHERE NOT w.enabled);

    RETURN QUERY
      UPDATE webhook_deliveries d
      SET status = 'sending', locked_until = now() + interval '2 minutes', attempt = d.attempt + 1
      FROM webhooks w
      WHERE w.id = d.webhook_id
        AND d.id IN (
          SELECT q.id FROM webhook_deliveries q
          WHERE (q.status = 'pending' AND q.next_attempt_at <= now())
             OR (q.status = 'sending' AND q.locked_until < now())
          ORDER BY q.next_attempt_at
          LIMIT p_limit
          FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.event_id, d.event, d.body, d.attempt, w.url, w.secret,
                CASE WHEN w.previous_secret_expires_at > now() THEN w.previous_secret END;
  END $$;

-- Worker: record the outcome of one attempt and schedule the next one.
CREATE FUNCTION app.finish_webhook_delivery(p_id uuid, p_ok boolean, p_code integer,
                                            p_error text, p_gone boolean)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    d webhook_deliveries;
    v_delays interval[] := ARRAY['5 seconds', '5 minutes', '30 minutes', '2 hours', '5 hours']::interval[];
    v_final boolean;
  BEGIN
    SELECT * INTO d FROM webhook_deliveries WHERE webhook_deliveries.id = p_id;
    IF p_ok THEN
      UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), response_code = p_code,
                                    last_error = NULL, locked_until = NULL
      WHERE webhook_deliveries.id = p_id;
      UPDATE webhooks SET failure_count = 0 WHERE webhooks.id = d.webhook_id;
      RETURN;
    END IF;

    v_final := p_gone OR d.attempt > cardinality(v_delays);
    UPDATE webhook_deliveries
    SET status = CASE WHEN v_final THEN 'failed' ELSE 'pending' END,
        next_attempt_at = CASE WHEN v_final THEN next_attempt_at
                               ELSE now() + v_delays[d.attempt] * (0.9 + random() * 0.2) END,
        response_code = p_code, last_error = left(p_error, 300), locked_until = NULL
    WHERE webhook_deliveries.id = p_id;

    UPDATE webhooks
    SET failure_count = failure_count + 1,
        enabled = enabled AND NOT (p_gone OR failure_count + 1 >= 10),
        disabled_reason = CASE
          WHEN p_gone THEN 'Endpoint returned 410 Gone'
          WHEN failure_count + 1 >= 10 THEN '10 consecutive failed attempts'
          ELSE disabled_reason END
    WHERE webhooks.id = d.webhook_id;
  END $$;

-- Rotation keeps the previous secret valid for 24 h: messages carry both signatures meanwhile
-- (Standard Webhooks allows several space-separated signatures), so receivers can switch
-- without dropping events. Returns false if the hook isn't the caller's to manage.
CREATE FUNCTION app.rotate_webhook_secret(p_id uuid, p_secret text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE webhooks
    SET previous_secret = secret, previous_secret_expires_at = now() + interval '24 hours',
        secret = p_secret
    WHERE id = p_id
      AND coalesce(app.active_role() IN ('super_admin', 'admin'), false)
      AND app.in_scope(org_id, team_id);
    RETURN FOUND;
  END $$;

REVOKE ALL ON FUNCTION app.webhook_body(text, jsonb),
  app.enqueue_webhook_event(uuid, uuid, uuid, text, jsonb),
  app.emit_webhook_event(uuid, uuid, text, jsonb), app.alert_webhook(),
  app.claim_webhook_deliveries(integer),
  app.finish_webhook_delivery(uuid, boolean, integer, text, boolean),
  app.rotate_webhook_secret(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webhook_body(text, jsonb),
  app.emit_webhook_event(uuid, uuid, text, jsonb), app.claim_webhook_deliveries(integer),
  app.finish_webhook_delivery(uuid, boolean, integer, text, boolean),
  app.rotate_webhook_secret(uuid, text) TO aafm_app;
