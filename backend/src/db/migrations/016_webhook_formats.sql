-- Feature F5 (Prompts 68-69): webhooks for people who aren't developers. An endpoint has a
-- format: 'standard' (signed Standard Webhooks JSON, for developers) or a chat app ('slack',
-- 'discord', 'teams'), which receives a readable message in that app's own format
-- (Slack {text}, Discord {content}, Teams Workflows Adaptive Card; src/utils/chat-message.js).
ALTER TABLE webhooks
  ADD COLUMN format text NOT NULL DEFAULT 'standard'
    CHECK (format IN ('standard', 'slack', 'discord', 'teams'));
GRANT SELECT (format), INSERT (format), UPDATE (format) ON webhooks TO aafm_app;

-- The worker needs the format with each claimed delivery (otherwise as in migration 010).
DROP FUNCTION app.claim_webhook_deliveries(integer);
CREATE FUNCTION app.claim_webhook_deliveries(p_limit integer)
  RETURNS TABLE (id uuid, webhook_id uuid, event_id uuid, event text, body text, attempt integer,
                 url text, format text, secret text, previous_secret text)
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
      RETURNING d.id, d.webhook_id, d.event_id, d.event, d.body, d.attempt, w.url, w.format,
                w.secret,
                CASE WHEN w.previous_secret_expires_at > now() THEN w.previous_secret END;
  END $$;

REVOKE ALL ON FUNCTION app.claim_webhook_deliveries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_webhook_deliveries(integer) TO aafm_app;
