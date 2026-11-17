-- Tier 1: Org -> Team hierarchy, org-scoped accounts, roles, sessions, dashboards, metrics,
-- all enforced by row-level security.
-- Every request runs as role aafm_app with transaction-local settings:
--   app.user_id  - the signed-in user
--   app.org_id   - the user's organization
--   app.team_id  - the selected team ('' for an org-level super_admin session or no selection)

CREATE SCHEMA app;

CREATE TYPE member_role AS ENUM ('super_admin', 'admin', 'editor', 'viewer');
CREATE TYPE metric_name AS ENUM ('revenue', 'page_views', 'clicks', 'errors');
CREATE TYPE widget_type AS ENUM ('line', 'bar', 'stat');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id) -- target for composite FKs that pin a row to one org
);

-- Accounts belong to exactly one org (AWS IAM model, Prompt 10): email is unique per org only.
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email                text NOT NULL CHECK (email = lower(trim(email)) AND email LIKE '%_@_%'),
  name                 text NOT NULL CHECK (length(trim(name)) > 0),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  UNIQUE (id, org_id)
);

-- A super_admin membership is org-wide (no team); every other role belongs to exactly one team.
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  team_id    uuid,
  role       member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  CHECK ((role = 'super_admin') = (team_id IS NULL))
);
CREATE UNIQUE INDEX memberships_user_team_uq ON memberships (user_id, team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX memberships_user_org_admin_uq ON memberships (user_id, org_id) WHERE team_id IS NULL;
CREATE INDEX memberships_team_idx ON memberships (team_id);
CREATE INDEX memberships_org_idx ON memberships (org_id);

-- Server-side sessions (OWASP Session Management). Only the SHA-256 of the token is stored.
-- membership_id NULL = signed in but no team selected yet. Removing a membership ends its sessions.
CREATE TABLE sessions (
  token_hash    bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  membership_id uuid REFERENCES memberships (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE dashboards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  team_id    uuid NOT NULL,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  version    integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  UNIQUE (id, team_id, org_id)
);
CREATE INDEX dashboards_team_idx ON dashboards (team_id, updated_at DESC);
CREATE INDEX dashboards_org_idx ON dashboards (org_id, updated_at DESC);

-- Widget position/size use grid units, matching react-grid-layout's {x, y, w, h}.
CREATE TABLE widgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL,
  org_id       uuid NOT NULL,
  team_id      uuid NOT NULL,
  type         widget_type NOT NULL,
  metric       metric_name NOT NULL,
  title        text NOT NULL DEFAULT '',
  x            integer NOT NULL DEFAULT 0 CHECK (x BETWEEN 0 AND 11),
  y            integer NOT NULL DEFAULT 0 CHECK (y >= 0),
  w            integer NOT NULL DEFAULT 4 CHECK (w BETWEEN 1 AND 12),
  h            integer NOT NULL DEFAULT 3 CHECK (h BETWEEN 1 AND 12),
  config       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- a widget can never point at another team's dashboard
  FOREIGN KEY (dashboard_id, team_id, org_id) REFERENCES dashboards (id, team_id, org_id) ON DELETE CASCADE
);
CREATE INDEX widgets_dashboard_idx ON widgets (dashboard_id);
CREATE INDEX widgets_team_idx ON widgets (team_id);

-- Simulated time series. The PK (team_id, metric, ts) is also the index for range reads.
CREATE TABLE metric_points (
  org_id  uuid NOT NULL,
  team_id uuid NOT NULL,
  metric  metric_name NOT NULL,
  ts      timestamptz NOT NULL,
  value   double precision NOT NULL,
  PRIMARY KEY (team_id, metric, ts),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE
);
CREATE INDEX metric_points_org_idx ON metric_points (org_id, metric, ts);

-- Optimistic concurrency: every UPDATE bumps version and updated_at, so clients send the
-- version they last saw (WHERE version = $n) and a stale write matches 0 rows -> 409.
CREATE FUNCTION app.bump_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.version := OLD.version + 1; NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER dashboards_bump_version BEFORE UPDATE ON dashboards FOR EACH ROW EXECUTE FUNCTION app.bump_version();
CREATE TRIGGER widgets_bump_version BEFORE UPDATE ON widgets FOR EACH ROW EXECUTE FUNCTION app.bump_version();

-- ---------------------------------------------------------------------------
-- Request context
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app.current_team_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.team_id', true), '')::uuid $$;

-- The caller's role in the selected context, or NULL if they hold no such membership
-- (so forged or stale settings grant nothing). SECURITY DEFINER lets it read memberships
-- without recursing into memberships' own RLS policy.
CREATE FUNCTION app.active_role() RETURNS member_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.role
    FROM memberships m
    WHERE m.user_id = app.current_user_id()
      AND m.org_id = app.current_org_id()
      AND m.team_id IS NOT DISTINCT FROM app.current_team_id()
  $$;

-- Is a row owned by (p_org, p_team) inside the selected context? Never NULL.
-- Team session: exactly that team. Super-admin session: any team in the org.
CREATE FUNCTION app.in_scope(p_org uuid, p_team uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(p_org = app.current_org_id()
       AND (app.current_team_id() IS NULL OR p_team = app.current_team_id()), false)
  $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- (SELECT app.active_role()) is evaluated once per statement, not once per row.
-- FORCE makes policies apply to the table owner too.
-- ---------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_read ON organizations FOR SELECT
  USING (id = app.current_org_id() AND (SELECT app.active_role()) IS NOT NULL);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
CREATE POLICY teams_read ON teams FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, id));
CREATE POLICY teams_write ON teams FOR ALL
  USING ((SELECT app.active_role()) = 'super_admin' AND org_id = app.current_org_id())
  WITH CHECK ((SELECT app.active_role()) = 'super_admin' AND org_id = app.current_org_id());

-- Not FORCEd: app.active_role() runs as the owner and must read memberships without
-- re-entering this policy (which calls app.active_role() itself). aafm_app is still bound by it.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON memberships FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));
-- super_admin manages the whole org; a team admin manages members of their own team only
-- (the table CHECK already stops a team membership from carrying the super_admin role).
CREATE POLICY memberships_write ON memberships FOR ALL
  USING (
    ((SELECT app.active_role()) = 'super_admin' AND org_id = app.current_org_id())
    OR ((SELECT app.active_role()) = 'admin' AND team_id = app.current_team_id())
  )
  WITH CHECK (
    ((SELECT app.active_role()) = 'super_admin' AND org_id = app.current_org_id())
    OR ((SELECT app.active_role()) = 'admin' AND team_id = app.current_team_id())
  );

-- Users: yourself, plus anyone sharing a visible membership (memberships' RLS applies inside).
-- Updating is limited to your own row and, by column grants below, to the password fields.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT
  USING (org_id = app.current_org_id()
         AND (id = app.current_user_id() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)));
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = app.current_user_id() AND org_id = app.current_org_id())
  WITH CHECK (id = app.current_user_id() AND org_id = app.current_org_id());

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboards_read ON dashboards FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));
CREATE POLICY dashboards_insert ON dashboards FOR INSERT
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id));
CREATE POLICY dashboards_update ON dashboards FOR UPDATE
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id))
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id));
-- Deleting a whole dashboard is admin-only ("Admin = full access", "Editor = create/edit").
CREATE POLICY dashboards_delete ON dashboards FOR DELETE
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin') AND app.in_scope(org_id, team_id));

ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY widgets_read ON widgets FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));
-- Adding, moving and removing widgets is dashboard editing, so editors may do all three.
CREATE POLICY widgets_write ON widgets FOR ALL
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id))
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id));

ALTER TABLE metric_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_points FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_points_read ON metric_points FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));

-- ---------------------------------------------------------------------------
-- Auth functions. They run before a team context exists (or reach across it), so each is a
-- narrow SECURITY DEFINER entry point instead of giving aafm_app broad table access.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.login_lookup(p_slug text, p_email text)
  RETURNS TABLE (user_id uuid, org_id uuid, password_hash text, must_change_password boolean, locked boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.org_id, u.password_hash, u.must_change_password, coalesce(u.locked_until > now(), false)
    FROM users u JOIN organizations o ON o.id = u.org_id
    WHERE o.slug = lower(trim(p_slug)) AND u.email = lower(trim(p_email))
  $$;

-- 10 consecutive failures lock the account for 15 minutes (OWASP WSTG-ATHN-03: 5-10 is typical).
-- The first failure after a lock expires starts a fresh count.
CREATE FUNCTION app.record_login(p_user_id uuid, p_success boolean) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE users SET
      failed_login_count = CASE WHEN p_success THEN 0
                                WHEN locked_until <= now() THEN 1
                                ELSE failed_login_count + 1 END,
      locked_until = CASE WHEN p_success THEN NULL
                          WHEN locked_until > now() THEN locked_until
                          WHEN (CASE WHEN locked_until <= now() THEN 1 ELSE failed_login_count + 1 END) >= 10
                            THEN now() + interval '15 minutes'
                          ELSE NULL END
    WHERE id = p_user_id
  $$;

-- Valid session -> its context. Enforces idle + absolute timeouts server-side and refreshes
-- last_seen_at at most once a minute to avoid a write on every request.
CREATE FUNCTION app.resolve_session(p_token_hash bytea, p_idle interval)
  RETURNS TABLE (user_id uuid, org_id uuid, team_id uuid, membership_id uuid, role member_role,
                 must_change_password boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    UPDATE sessions s SET last_seen_at = now()
    WHERE s.token_hash = p_token_hash AND s.expires_at > now()
      AND s.last_seen_at > now() - p_idle AND s.last_seen_at < now() - interval '1 minute';

    RETURN QUERY
      SELECT s.user_id, s.org_id, m.team_id, s.membership_id, m.role, u.must_change_password
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN memberships m ON m.id = s.membership_id
      WHERE s.token_hash = p_token_hash AND s.expires_at > now() AND s.last_seen_at > now() - p_idle;
  END $$;

-- The current user's memberships, for the login picker (no team context exists yet).
CREATE FUNCTION app.my_memberships()
  RETURNS TABLE (id uuid, role member_role, team_id uuid, team_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.role, m.team_id, t.name
    FROM memberships m LEFT JOIN teams t ON t.id = m.team_id
    WHERE m.user_id = app.current_user_id() AND m.org_id = app.current_org_id()
    ORDER BY m.team_id IS NOT NULL, t.name
  $$;

-- Public sign-up: a new org, its first account, and that account's super_admin membership.
CREATE FUNCTION app.signup(p_slug text, p_org_name text, p_email text, p_name text, p_password_hash text)
  RETURNS TABLE (user_id uuid, org_id uuid, membership_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_org uuid; v_user uuid; v_membership uuid;
  BEGIN
    INSERT INTO organizations (slug, name) VALUES (p_slug, p_org_name) RETURNING id INTO v_org;
    INSERT INTO users (org_id, email, name, password_hash) VALUES (v_org, p_email, p_name, p_password_hash)
      RETURNING id INTO v_user;
    INSERT INTO memberships (user_id, org_id, role) VALUES (v_user, v_org, 'super_admin')
      RETURNING id INTO v_membership;
    RETURN QUERY SELECT v_user, v_org, v_membership;
  END $$;

-- IAM-style "create user": adds a team membership, creating the org account if the email is new
-- (the given hash becomes a one-time password). Team admins cannot see other teams' users, so
-- the lookup happens here, scoped to the caller's org.
CREATE FUNCTION app.add_member(p_team_id uuid, p_email text, p_name text, p_role member_role, p_password_hash text)
  RETURNS TABLE (membership_id uuid, user_id uuid, created boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_user uuid; v_created boolean := false; v_membership uuid;
  BEGIN
    IF NOT coalesce(
         (app.active_role() = 'super_admin'
            AND EXISTS (SELECT 1 FROM teams t WHERE t.id = p_team_id AND t.org_id = app.current_org_id()))
         OR (app.active_role() = 'admin' AND p_team_id = app.current_team_id()), false) THEN
      RAISE EXCEPTION 'not allowed to add members to this team' USING ERRCODE = '42501';
    END IF;

    SELECT u.id INTO v_user FROM users u
    WHERE u.org_id = app.current_org_id() AND u.email = lower(trim(p_email));

    IF v_user IS NULL THEN
      INSERT INTO users (org_id, email, name, password_hash, must_change_password)
      VALUES (app.current_org_id(), lower(trim(p_email)), p_name, p_password_hash, true)
      RETURNING id INTO v_user;
      v_created := true;
    END IF;

    INSERT INTO memberships (user_id, org_id, team_id, role)
    VALUES (v_user, app.current_org_id(), p_team_id, p_role)
    RETURNING id INTO v_membership;
    RETURN QUERY SELECT v_membership, v_user, v_created;
  END $$;

-- Admin password reset with the escalation guard (plan section 8): the target must have at least
-- one membership in the caller's scope and none outside it, so a Finance admin can't take over
-- someone who is also a Marketing admin. Ends all of the target's sessions.
CREATE FUNCTION app.reset_password(p_user_id uuid, p_password_hash text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NOT coalesce(app.active_role() IN ('super_admin', 'admin'), false)
       OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user_id AND app.in_scope(m.org_id, m.team_id))
       OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user_id AND NOT app.in_scope(m.org_id, m.team_id)) THEN
      RETURN false;
    END IF;

    UPDATE users SET password_hash = p_password_hash, must_change_password = true,
                     failed_login_count = 0, locked_until = NULL
    WHERE id = p_user_id;
    DELETE FROM sessions WHERE user_id = p_user_id;
    RETURN true;
  END $$;

-- ---------------------------------------------------------------------------
-- Privileges for the request role (created by src/db/migrate.js)
-- metric_points is read-only for the app: the simulator writes as the owner.
-- sessions has no RLS: it holds only token hashes and is reached by token hash or user id.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public, app TO aafm_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO aafm_app;
GRANT SELECT ON organizations, users, metric_points TO aafm_app;
GRANT UPDATE (password_hash, must_change_password) ON users TO aafm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, memberships, dashboards, widgets, sessions TO aafm_app;
