-- dlab SQLite schema (Phase 1 skeleton)
-- Columns mirror @dsh-lab/shared types; ids are strings (ULID-based).
-- All timestamps are integer epoch ms unless noted.

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    root_path       TEXT NOT NULL,
    main_solution_id TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS solutions (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    slug                TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    description         TEXT,
    hypothesis          TEXT,
    conclusion          TEXT,
    role                TEXT NOT NULL,          -- main | experiment
    status              TEXT NOT NULL,          -- active | archived | merged | broken
    branch              TEXT NOT NULL UNIQUE,
    worktree_path       TEXT,
    workspace_id        TEXT,
    parent_solution_id  TEXT,
    fork_commit         TEXT,
    head_commit         TEXT NOT NULL,
    merged_into_solution_id TEXT,
    merge_commit        TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    archived_at         INTEGER,
    merged_at           INTEGER,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS solution_relations (
    id                  TEXT PRIMARY KEY,
    source_solution_id  TEXT NOT NULL,
    target_solution_id  TEXT NOT NULL,
    relation_type       TEXT NOT NULL,          -- forked_from | merged_into
    git_commit          TEXT,
    created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    solution_id         TEXT NOT NULL,
    snapshot_commit     TEXT NOT NULL,
    source_head_commit  TEXT NOT NULL,
    status              TEXT NOT NULL,
    title               TEXT,
    description         TEXT,
    run_profile_id      TEXT,
    command_json        TEXT NOT NULL,
    resources_json      TEXT NOT NULL,
    environment_fingerprint TEXT,
    run_dir             TEXT NOT NULL,
    worktree_path       TEXT,
    pid                 INTEGER,
    pgid                INTEGER,
    exit_code           INTEGER,
    created_at          INTEGER NOT NULL,
    started_at          INTEGER,
    finished_at         INTEGER,
    FOREIGN KEY (solution_id) REFERENCES solutions(id)
);

CREATE TABLE IF NOT EXISTS run_metrics (
    run_id   TEXT NOT NULL,
    name     TEXT NOT NULL,
    value    REAL NOT NULL,
    dataset  TEXT,
    split    TEXT,
    PRIMARY KEY (run_id, name, dataset, split)
);

CREATE TABLE IF NOT EXISTS run_tags (
    run_id TEXT NOT NULL,
    tag    TEXT NOT NULL,
    PRIMARY KEY (run_id, tag)
);

CREATE TABLE IF NOT EXISTS run_profiles (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    command_json           TEXT NOT NULL,
    default_resources_json TEXT,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS environment_snapshots (
    fingerprint     TEXT PRIMARY KEY,
    python_version  TEXT,
    torch_version   TEXT,
    cuda_version    TEXT,
    pip_freeze      TEXT,
    system_json     TEXT,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gpu_reservations (
    gpu_id      INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL,
    reserved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    payload_json TEXT,
    created_at  INTEGER NOT NULL
);
