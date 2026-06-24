-- Socratic AI - Database Schema for Neon Postgres
-- Run this script once to initialize the database tables.

CREATE TABLE IF NOT EXISTS whitelist_users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'student')),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS misconception_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    session_start_time TIMESTAMPTZ,
    session_end_time TIMESTAMPTZ,
    turn_count INTEGER DEFAULT 0,
    direct_answer_pct NUMERIC(6,2) DEFAULT 0,
    reasoning_pct NUMERIC(6,2) DEFAULT 0,
    off_topic_count INTEGER DEFAULT 0,
    misconceptions_resolved INTEGER DEFAULT 0,
    misconceptions_active INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_turns (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES misconception_sessions(session_id) ON DELETE CASCADE,
    query_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    user_message TEXT,
    file_context TEXT,
    question TEXT,
    targeted_misconception TEXT,
    classifier_certainty NUMERIC(4,3),
    raw_verdicts JSONB,
    confidence_deltas JSONB,
    resolution_events JSONB,
    misconception_confidence_before NUMERIC(4,3),
    misconception_confidence_after NUMERIC(4,3),
    misconception_resolved BOOLEAN DEFAULT false,
    resolution_source TEXT,
    intent TEXT,
    strategy TEXT,
    hint_level INTEGER,
    learner_confidence NUMERIC(4,3),
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    resolution_score NUMERIC(5,3),
    resolution_status TEXT,
    resolution_signals JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_summaries (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    query_id TEXT NOT NULL,
    user_id TEXT,
    summary JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_training_data (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    query_id TEXT NOT NULL,
    user_id TEXT,
    label TEXT,
    history JSONB,
    summary JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_metrics (
    id SERIAL PRIMARY KEY,
    user_id TEXT,
    path TEXT,
    status_code INTEGER,
    latency_ms INTEGER,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    model_status TEXT,
    model_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_query_turns_session ON query_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_query_turns_query ON query_turns(query_id);
CREATE INDEX IF NOT EXISTS idx_query_turns_misconception ON query_turns(targeted_misconception);
CREATE INDEX IF NOT EXISTS idx_whitelist_token ON whitelist_users(token);
CREATE INDEX IF NOT EXISTS idx_request_metrics_created ON request_metrics(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON misconception_sessions(user_id);

-- ---------------------------------------------------------------------------
-- Migration 002: automatic resolution tracking.
-- Idempotent ALTERs so existing deployments pick up the new columns by simply
-- re-running this script (the whole file is safe to run repeatedly).
-- ---------------------------------------------------------------------------
ALTER TABLE query_turns ADD COLUMN IF NOT EXISTS resolution_score NUMERIC(5,3);
ALTER TABLE query_turns ADD COLUMN IF NOT EXISTS resolution_status TEXT;
ALTER TABLE query_turns ADD COLUMN IF NOT EXISTS resolution_signals JSONB;
CREATE INDEX IF NOT EXISTS idx_query_turns_resolution_status ON query_turns(resolution_status);

-- ---------------------------------------------------------------------------
-- Migration 003: durable working state for restart / cache-eviction recovery.
-- Holds only the live pedagogical state per query (full transcripts stay in
-- query_turns). Lets a redeploy resume in-flight conversations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS query_state (
    session_id TEXT NOT NULL,
    query_id TEXT NOT NULL,
    user_id TEXT,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, query_id)
);
CREATE INDEX IF NOT EXISTS idx_query_state_updated ON query_state(updated_at);
