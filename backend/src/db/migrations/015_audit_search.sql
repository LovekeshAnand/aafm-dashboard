-- Feature F6 (Prompts 68-69): audit log search, filters, sorting and numbered pages, across
-- the live rows and the compressed archive (migration 011). Visibility is the same as the
-- audit_log_read policy: the Super Admin sees the org, an Admin only their own team's entries.
-- Free-text search matches the person, action, target, IP and details, case-insensitively,
-- with strpos (so % and _ in the search are plain characters, not wildcards).
-- Stable pages: page 1 returns `as_of` (the newest seq at that moment); later pages pass it
-- back, so entries written meanwhile (including each viewer's own audit.view) can't shift
-- the pages and cause duplicates or gaps (offset-pagination drift).
-- ponytail: scans the org's matching rows per search (label-pruned for the archive); fine at
-- this scale, add a trigram index or a search table if the log reaches millions of rows.

CREATE FUNCTION app.audit_search(p_q text, p_actor uuid, p_action text, p_team uuid,
                                 p_results text[], p_from timestamptz, p_to timestamptz,
                                 p_sort text, p_limit integer, p_offset integer,
                                 p_as_of bigint)
  RETURNS TABLE (entry jsonb, total bigint, as_of bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_role member_role := app.active_role();
    v_team uuid := p_team;
    v_q text := lower(nullif(trim(p_q), ''));
    v_as_of bigint := p_as_of;
  BEGIN
    IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    IF v_role = 'admin' THEN
      IF p_team IS NOT NULL AND p_team <> app.current_team_id() THEN RETURN; END IF;
      v_team := app.current_team_id();
    END IF;
    IF v_as_of IS NULL THEN
      v_as_of := (SELECT max(a.seq) FROM audit_log a WHERE a.org_id = app.current_org_id());
    END IF;

    RETURN QUERY
      WITH visible AS (
        SELECT a.* FROM audit_log a WHERE a.org_id = app.current_org_id()
        UNION ALL
        SELECT e.* FROM audit_segments g, jsonb_populate_recordset(NULL::audit_log, g.entries) e
        WHERE g.org_id = app.current_org_id()
          AND (v_team IS NULL OR g.team_ids @> ARRAY[v_team])
          AND (p_actor IS NULL OR g.actor_ids @> ARRAY[p_actor])
          AND (p_results IS NULL OR g.results && p_results)
          AND (p_from IS NULL OR g.last_at >= p_from)
          AND (p_to IS NULL OR g.first_at < p_to)
      ),
      matched AS (
        SELECT v.* FROM visible v
        WHERE v.seq <= v_as_of
          AND (v_team IS NULL OR v.team_id = v_team)
          AND (p_actor IS NULL OR v.actor_id = p_actor)
          AND (p_action IS NULL OR v.action LIKE p_action || '%')
          AND (p_results IS NULL OR v.result = ANY (p_results))
          AND (p_from IS NULL OR v.at >= p_from)
          AND (p_to IS NULL OR v.at < p_to)
          AND (v_q IS NULL
               OR strpos(lower(coalesce(v.actor_name, 'system')), v_q) > 0
               OR strpos(v.action, v_q) > 0
               OR strpos(lower(coalesce(v.target_type, '') || ' ' || coalesce(v.target_id, '')), v_q) > 0
               OR strpos(coalesce(v.ip, ''), v_q) > 0
               OR strpos(lower(v.meta::text), v_q) > 0)
      )
      SELECT to_jsonb(m) - 'hash' - 'prev_hash', count(*) OVER (), v_as_of
      FROM matched m
      ORDER BY
        CASE WHEN p_sort = 'issues' THEN m.result <> 'allowed' END DESC NULLS LAST,
        CASE WHEN p_sort = 'oldest' THEN m.seq END ASC,
        m.seq DESC
      LIMIT p_limit OFFSET p_offset;
  END $$;

REVOKE ALL ON FUNCTION app.audit_search(text, uuid, text, uuid, text[], timestamptz, timestamptz,
  text, integer, integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_search(text, uuid, text, uuid, text[], timestamptz,
  timestamptz, text, integer, integer, bigint) TO aafm_app;
