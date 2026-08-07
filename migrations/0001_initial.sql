PRAGMA foreign_keys = ON;

CREATE TABLE plans (
  id TEXT PRIMARY KEY NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'antigravity')),
  slug TEXT NOT NULL,
  object_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent, slug)
);

CREATE TABLE plan_versions (
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, version),
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);

CREATE INDEX idx_plans_agent_updated_at
  ON plans(agent, updated_at DESC);

