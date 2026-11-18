-- Problems-log #39: signed audit checkpoints (the AWS CloudTrail digest idea).
-- The hash chain proves no entry was edited, but deleting the NEWEST entries leaves a shorter
-- chain that still verifies. Every housekeeping run therefore records each org's newest
-- (seq, hash), signed with HMAC-SHA256 by a key that lives outside the database (the keyring
-- file). Verify then requires every checkpointed entry to still exist with the same hash, and
-- every signature to be valid, so deleting the tail (or forging a checkpoint) is detected.
-- Window: entries newer than the last checkpoint (at most one housekeeping interval, 5 min)
-- are covered by the chain only.

CREATE TABLE audit_checkpoints (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     uuid NOT NULL,
  seq        bigint NOT NULL,
  hash       bytea NOT NULL,
  key_id     text NOT NULL,
  signature  text NOT NULL, -- base64 HMAC-SHA256 of "<org_id>|<seq>|<hash hex>"
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, seq)
);
ALTER TABLE audit_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checkpoints FORCE ROW LEVEL SECURITY;
CREATE TRIGGER audit_checkpoints_append_only BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION app.audit_append_only();

-- Worker: each org's newest entry that has no checkpoint yet.
CREATE FUNCTION app.audit_heads_to_checkpoint()
  RETURNS TABLE (org_id uuid, seq bigint, hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT h.org_id, h.seq, h.hash
    FROM (SELECT DISTINCT ON (a.org_id) a.org_id, a.seq, a.hash
          FROM audit_log a ORDER BY a.org_id, a.seq DESC) h
    WHERE NOT EXISTS (SELECT 1 FROM audit_checkpoints c
                      WHERE c.org_id = h.org_id AND c.seq >= h.seq)
  $$;

-- Worker: store a signed checkpoint, only for an entry that really exists with that hash.
CREATE FUNCTION app.add_audit_checkpoint(p_org uuid, p_seq bigint, p_hash bytea,
                                         p_key_id text, p_signature text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM audit_log a
                   WHERE a.org_id = p_org AND a.seq = p_seq AND a.hash = p_hash) THEN
      RAISE EXCEPTION 'no such audit entry' USING ERRCODE = '22023';
    END IF;
    INSERT INTO audit_checkpoints (org_id, seq, hash, key_id, signature)
    VALUES (p_org, p_seq, p_hash, p_key_id, p_signature)
    ON CONFLICT (org_id, seq) DO NOTHING;
  END $$;

-- Verify (Admins / Super Admin of the org): recent checkpoints and whether each checkpointed
-- entry is still present, live or archived, with the same hash.
CREATE FUNCTION app.audit_checkpoint_status(p_limit integer DEFAULT 100)
  RETURNS TABLE (seq bigint, hash bytea, key_id text, signature text,
                 created_at timestamptz, present boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF coalesce(app.active_role() NOT IN ('super_admin', 'admin'), true) THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
      SELECT c.seq, c.hash, c.key_id, c.signature, c.created_at,
             EXISTS (SELECT 1 FROM audit_log a
                     WHERE a.org_id = c.org_id AND a.seq = c.seq AND a.hash = c.hash)
             OR EXISTS (SELECT 1 FROM audit_segments g,
                                  jsonb_populate_recordset(NULL::audit_log, g.entries) e
                        WHERE g.org_id = c.org_id AND c.seq BETWEEN g.first_seq AND g.last_seq
                          AND e.seq = c.seq AND e.hash = c.hash)
      FROM audit_checkpoints c
      WHERE c.org_id = app.current_org_id()
      ORDER BY c.seq DESC
      LIMIT p_limit;
  END $$;

REVOKE ALL ON FUNCTION app.audit_heads_to_checkpoint(),
  app.add_audit_checkpoint(uuid, bigint, bytea, text, text),
  app.audit_checkpoint_status(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_heads_to_checkpoint(),
  app.add_audit_checkpoint(uuid, bigint, bytea, text, text),
  app.audit_checkpoint_status(integer) TO aafm_app;
