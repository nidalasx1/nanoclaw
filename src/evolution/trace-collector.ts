import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { logger } from '../logger.js';
import { getSkillIndex } from '../skill-engine.js';
import type { SkillTracker } from '../skill-tracker.js';
import type { ExecutionTrace } from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initTraceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_traces (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tool_calls TEXT NOT NULL,
      skills_loaded TEXT NOT NULL,
      skills_deviated TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_execution_traces_group
      ON execution_traces(group_id);
    CREATE INDEX IF NOT EXISTS idx_execution_traces_ts
      ON execution_traces(timestamp);
  `);
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

export function collectTrace(
  db: Database.Database,
  groupId: string,
  sessionId: string,
  tracker: SkillTracker,
): ExecutionTrace {
  const stats = tracker.getSessionStats(groupId, sessionId);

  // Build tool calls array from the session stats
  const toolCalls = stats.toolSequence.map((name) => ({
    name,
    success: true, // individual success not tracked in sequence; default true
  }));

  // Determine which skills were active during this session
  const allSkills = getSkillIndex();
  const skillsLoaded = allSkills
    .filter((s) => stats.uniqueTools.some((t) => t.includes(s.name)))
    .map((s) => s.name);

  // Detect deviations — skills that were loaded but the agent diverged from
  const skillsDeviated: ExecutionTrace['skillsDeviated'] = [];

  // Determine outcome from stats
  let outcome: ExecutionTrace['outcome'];
  if (stats.failureCount === 0) {
    outcome = 'success';
  } else if (stats.successCount > stats.failureCount) {
    outcome = 'partial';
  } else {
    outcome = 'failure';
  }

  const trace: ExecutionTrace = {
    id: crypto.randomUUID(),
    groupId,
    sessionId,
    timestamp: new Date().toISOString(),
    toolCalls,
    skillsLoaded,
    skillsDeviated,
    outcome,
    summary: `${stats.toolCallCount} tool calls, ${stats.successCount} succeeded, ${stats.failureCount} failed`,
  };

  // Persist
  db.prepare(
    `INSERT INTO execution_traces (id, group_id, session_id, timestamp, tool_calls, skills_loaded, skills_deviated, outcome, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trace.id,
    trace.groupId,
    trace.sessionId,
    trace.timestamp,
    JSON.stringify(trace.toolCalls),
    JSON.stringify(trace.skillsLoaded),
    JSON.stringify(trace.skillsDeviated),
    trace.outcome,
    trace.summary ?? null,
  );

  logger.info(
    { traceId: trace.id, groupId, outcome: trace.outcome },
    'Execution trace collected',
  );

  return trace;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function rowToTrace(row: Record<string, unknown>): ExecutionTrace {
  return {
    id: row.id as string,
    groupId: row.group_id as string,
    sessionId: row.session_id as string,
    timestamp: row.timestamp as string,
    toolCalls: JSON.parse(row.tool_calls as string),
    skillsLoaded: JSON.parse(row.skills_loaded as string),
    skillsDeviated: JSON.parse(row.skills_deviated as string),
    outcome: row.outcome as ExecutionTrace['outcome'],
    summary: (row.summary as string) ?? undefined,
  };
}

export function getRecentTraces(
  db: Database.Database,
  limit: number = 50,
): ExecutionTrace[] {
  const rows = db
    .prepare(
      `SELECT * FROM execution_traces ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map(rowToTrace);
}

export function getTracesForSkill(
  db: Database.Database,
  skillName: string,
  limit: number = 50,
): ExecutionTrace[] {
  const rows = db
    .prepare(
      `SELECT * FROM execution_traces
       WHERE skills_loaded LIKE ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(`%"${skillName}"%`, limit) as Record<string, unknown>[];

  return rows.map(rowToTrace);
}

export function getTraceById(
  db: Database.Database,
  id: string,
): ExecutionTrace | null {
  const row = db
    .prepare(`SELECT * FROM execution_traces WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  return row ? rowToTrace(row) : null;
}
