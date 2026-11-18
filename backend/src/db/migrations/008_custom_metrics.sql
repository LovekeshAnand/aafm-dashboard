-- Tier 3 D (Prompts 47-49): custom metric definitions.
-- A team defines a formula over the base metrics (+ - * / and parentheses, e.g.
-- "(clicks - errors) / page_views * 100"). The formula is parsed and validated by the API
-- (src/utils/formula.js) and only ever turned into SQL from the parsed tree, never pasted.
-- Like the built-in KPIs it is evaluated per bucket on the sums of each metric.

CREATE TABLE custom_metrics (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  team_id    uuid NOT NULL,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  formula    text NOT NULL CHECK (length(formula) BETWEEN 1 AND 200),
  unit       text NOT NULL DEFAULT 'number' CHECK (unit IN ('number', 'currency', 'percent')),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    integer NOT NULL DEFAULT 1,
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  UNIQUE (team_id, name),
  UNIQUE (id, team_id, org_id)
);
CREATE TRIGGER custom_metrics_bump_version BEFORE UPDATE ON custom_metrics
  FOR EACH ROW EXECUTE FUNCTION app.bump_version();

ALTER TABLE custom_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_metrics_read ON custom_metrics FOR SELECT
  USING ((SELECT app.active_role()) IS NOT NULL AND app.in_scope(org_id, team_id));
-- Defining metrics is like building dashboards: Editors and up.
CREATE POLICY custom_metrics_write ON custom_metrics FOR ALL
  USING ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id))
  WITH CHECK ((SELECT app.active_role()) IN ('super_admin', 'admin', 'editor') AND app.in_scope(org_id, team_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_metrics TO aafm_app;

-- A widget's source is now exactly one of: base metric, built-in KPI, custom metric.
-- The composite FK keeps a widget on a custom metric of its own team. The default NO ACTION
-- (checked at statement end, so deleting a team still cascades) stops a metric from being
-- deleted while widgets still show it; the API names those widgets in the 409.
ALTER TABLE widgets
  ADD COLUMN custom_metric_id uuid,
  ADD FOREIGN KEY (custom_metric_id, team_id, org_id)
    REFERENCES custom_metrics (id, team_id, org_id),
  DROP CONSTRAINT widgets_one_source,
  ADD CONSTRAINT widgets_one_source CHECK (num_nonnulls(metric, kpi, custom_metric_id) = 1);
CREATE INDEX widgets_custom_metric_idx ON widgets (custom_metric_id) WHERE custom_metric_id IS NOT NULL;
