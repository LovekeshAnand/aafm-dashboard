-- Tier 3 (Prompt 50): webhook delivery outcomes in the audit log, and encrypted secrets.
--
-- 1. Audit entries without a request. The webhook worker has no signed-in user, so the chain
--    logic moves into app.audit_append(), which takes the org, team and actor explicitly and is
--    callable only by owner-run functions (not granted to the app role). app.audit() keeps its
--    signature and still takes the actor from the request context.
-- 2. Every failed delivery attempt, the final give-up, an automatic endpoint disable and a
--    delivery that succeeds after failing are audited with the actor "Webhook worker", so the
--    team sees where and when an integration broke. A first-try success is not audited: the
--    deliveries table already lists it, and logging every routine success would bury the
--    failures (OWASP Logging: record what the risk justifies).
--    Only the endpoint's host is logged: webhook URLs often embed tokens in the path or query.
-- 3. Secrets are sealed by the API (AES-256-GCM, src/utils/secret-box.js) before they reach the
--    database. The CHECKs are NOT VALID so pre-existing development rows are left alone, but
--    every new or changed secret must be sealed. The id is chosen by the API (it is bound into
--    the ciphertext), so the app role may now insert it.

CREATE FUNCTION app.audit_append(p_org uuid, p_team uuid, p_actor uuid, p_actor_name text,
                                 p_action text, p_target_type text, p_target_id text,
                                 p_result text, p_meta jsonb, p_ip text, p_user_agent text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_row audit_log;
  BEGIN
    IF p_org IS NULL THEN
      RAISE EXCEPTION 'audit needs an organization' USING ERRCODE = '42501';
    END IF;
    -- One writer per org at a time keeps the chain linear (measured: ~3,200 writes/s for a
    -- single org with 10 concurrent writers, Prompt 50).
    PERFORM pg_advisory_xact_lock(hashtext('audit:' || p_org));
    v_row.seq := nextval('audit_log_seq');
    v_row.org_id := p_org;
    v_row.team_id := p_team;
    v_row.actor_id := p_actor;
    v_row.actor_name := coalesce(p_actor_name, (SELECT u.name FROM users u WHERE u.id = p_actor));
    v_row.action := p_action;
    v_row.target_type := p_target_type;
    v_row.target_id := p_target_id;
    v_row.result := coalesce(p_result, 'allowed');
    v_row.ip := left(p_ip, 64);
    v_row.user_agent := left(p_user_agent, 200);
    v_row.meta := coalesce(p_meta, '{}');
    v_row.at := clock_timestamp();
    v_row.prev_hash := (SELECT a.hash FROM audit_log a WHERE a.org_id = p_org ORDER BY a.seq DESC LIMIT 1);
    v_row.hash := sha256(coalesce(v_row.prev_hash, '') || app.audit_row_bytes(v_row));
    INSERT INTO audit_log SELECT v_row.*;
  END $$;

CREATE OR REPLACE FUNCTION app.audit(p_action text, p_target_type text, p_target_id text,
                                     p_result text, p_meta jsonb, p_ip text, p_user_agent text,
                                     p_team uuid DEFAULT NULL)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF app.current_org_id() IS NULL THEN
      RAISE EXCEPTION 'audit needs an organization context' USING ERRCODE = '42501';
    END IF;
    PERFORM app.audit_append(app.current_org_id(), coalesce(p_team, app.current_team_id()),
                             app.current_user_id(), NULL, p_action, p_target_type, p_target_id,
                             p_result, p_meta, p_ip, p_user_agent);
  END $$;

-- The worker needs the webhook id (the decryption AAD) with each claimed delivery.
DROP FUNCTION app.claim_webhook_deliveries(integer);
CREATE FUNCTION app.claim_webhook_deliveries(p_limit integer)
  RETURNS TABLE (id uuid, webhook_id uuid, event_id uuid, event text, body text, attempt integer,
                 url text, secret text, previous_secret text)
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
      RETURNING d.id, d.webhook_id, d.event_id, d.event, d.body, d.attempt, w.url, w.secret,
                CASE WHEN w.previous_secret_expires_at > now() THEN w.previous_secret END;
  END $$;

-- Same retry rules as migration 009, plus the audit entries described above. Returns what the
-- worker needs to push a live "webhooks:changed" event to the team.
DROP FUNCTION app.finish_webhook_delivery(uuid, boolean, integer, text, boolean);
CREATE FUNCTION app.finish_webhook_delivery(p_id uuid, p_ok boolean, p_code integer,
                                            p_error text, p_gone boolean)
  RETURNS TABLE (org_id uuid, team_id uuid, webhook_id uuid, status text, disabled boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    d webhook_deliveries;
    w webhooks;
    v_delays interval[] := ARRAY['5 seconds', '5 minutes', '30 minutes', '2 hours', '5 hours']::interval[];
    v_final boolean;
    v_disable boolean;
    v_status text;
    v_next timestamptz;
    v_meta jsonb;
  BEGIN
    SELECT * INTO d FROM webhook_deliveries WHERE webhook_deliveries.id = p_id;
    SELECT * INTO w FROM webhooks WHERE webhooks.id = d.webhook_id;
    IF d.id IS NULL OR w.id IS NULL THEN RETURN; END IF; -- deleted meanwhile: nothing to record

    v_meta := jsonb_build_object(
      'webhook_id', w.id, 'host', substring(w.url FROM '^https?://([^/?#]+)'),
      'event', d.event, 'event_id', d.event_id, 'delivery_id', d.id,
      'attempt', d.attempt, 'response_code', p_code);

    IF p_ok THEN
      UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), response_code = p_code,
                                    last_error = NULL, locked_until = NULL
      WHERE webhook_deliveries.id = p_id;
      UPDATE webhooks SET failure_count = 0 WHERE webhooks.id = w.id;
      IF d.attempt > 1 THEN
        PERFORM app.audit_append(w.org_id, w.team_id, NULL, 'Webhook worker', 'webhook.delivery_recovered',
                                 'webhook', w.id::text, 'allowed', v_meta, NULL, NULL);
      END IF;
      RETURN QUERY SELECT w.org_id, w.team_id, w.id, 'delivered'::text, false;
      RETURN;
    END IF;

    v_final := p_gone OR d.attempt > cardinality(v_delays);
    v_disable := w.enabled AND (p_gone OR w.failure_count + 1 >= 10);
    v_status := CASE WHEN v_final THEN 'failed' ELSE 'pending' END;
    v_next := CASE WHEN v_final THEN NULL ELSE now() + v_delays[d.attempt] * (0.9 + random() * 0.2) END;

    UPDATE webhook_deliveries
    SET status = v_status, next_attempt_at = coalesce(v_next, next_attempt_at),
        response_code = p_code, last_error = left(p_error, 300), locked_until = NULL
    WHERE webhook_deliveries.id = p_id;

    UPDATE webhooks
    SET failure_count = failure_count + 1,
        enabled = enabled AND NOT v_disable,
        disabled_reason = CASE
          WHEN NOT v_disable THEN disabled_reason
          WHEN p_gone THEN 'Endpoint returned 410 Gone'
          ELSE '10 consecutive failed attempts' END
    WHERE webhooks.id = w.id;

    PERFORM app.audit_append(w.org_id, w.team_id, NULL, 'Webhook worker',
      CASE WHEN v_final THEN 'webhook.delivery_abandoned' ELSE 'webhook.delivery_failed' END,
      'webhook', w.id::text, 'failed',
      v_meta || jsonb_build_object('error', left(p_error, 300), 'next_attempt_at', v_next),
      NULL, NULL);
    IF v_disable THEN
      PERFORM app.audit_append(w.org_id, w.team_id, NULL, 'Webhook worker', 'webhook.endpoint_disabled',
        'webhook', w.id::text, 'failed',
        jsonb_build_object('webhook_id', w.id, 'host', v_meta->'host',
                           'reason', CASE WHEN p_gone THEN '410 Gone' ELSE '10 consecutive failed attempts' END),
        NULL, NULL);
    END IF;
    RETURN QUERY SELECT w.org_id, w.team_id, w.id, v_status, v_disable;
  END $$;

ALTER TABLE webhooks
  ADD CONSTRAINT webhooks_secret_sealed CHECK (secret ~ '^v1:') NOT VALID,
  ADD CONSTRAINT webhooks_previous_secret_sealed CHECK (previous_secret ~ '^v1:') NOT VALID;
GRANT INSERT (id) ON webhooks TO aafm_app;

REVOKE ALL ON FUNCTION app.audit_append(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text),
  app.claim_webhook_deliveries(integer),
  app.finish_webhook_delivery(uuid, boolean, integer, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_webhook_deliveries(integer),
  app.finish_webhook_delivery(uuid, boolean, integer, text, boolean) TO aafm_app;
