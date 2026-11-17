-- Tier 2 C (Prompts 37-41): KPI calculations. A widget now shows either a base metric or a
-- built-in KPI (ARPU = revenue / users, CTR = clicks / page_views, error rate = errors /
-- page_views). KPIs are computed on read from the base metrics; nothing extra is stored.

ALTER TABLE widgets
  ADD COLUMN kpi text CHECK (kpi IN ('arpu', 'ctr', 'error_rate')),
  ALTER COLUMN metric DROP NOT NULL,
  ADD CONSTRAINT widgets_one_source CHECK ((metric IS NULL) <> (kpi IS NULL));
