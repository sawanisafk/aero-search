-- M4-A: PageRank persistence (ARCHITECTURE §6 — offline authority signal).
-- A run records the full parameter set + convergence outcome for the evidence
-- rule; scores are url-keyed (normalized URL = documents PK = corpus id), so
-- fusion/evaluation joins them onto segment docIds without touching the
-- query hot path (ADR-003: read once offline, pass into the run config).

CREATE TABLE IF NOT EXISTS pagerank_runs (
  run_id         BIGSERIAL PRIMARY KEY,
  damping        DOUBLE PRECISION NOT NULL,
  tolerance      DOUBLE PRECISION NOT NULL,
  max_iterations INTEGER NOT NULL,
  iterations     INTEGER NOT NULL,
  converged      BOOLEAN NOT NULL,
  residual       DOUBLE PRECISION NOT NULL,
  node_count     INTEGER NOT NULL,
  edge_count     INTEGER NOT NULL,
  graph_hash     TEXT NOT NULL,
  git_sha        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pagerank_scores (
  run_id BIGINT NOT NULL REFERENCES pagerank_runs (run_id) ON DELETE CASCADE,
  url    TEXT NOT NULL,
  value  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (run_id, url)
);
