/**
 * Auto-Committer — applies validated mutations and logs everything.
 *
 * Handles schema initialization, mutation commits with full audit trail,
 * rollback support, and evolution history queries.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { updateSkill } from '../skill-engine.js';
import { rebuildSkillsIndex } from '../skill-ipc.js';
import type { EvolutionLogEntry, FailureCategory } from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Create the evolution_log table if it doesn't exist.
 * Call once at startup alongside other schema migrations.
 */
export function initEvolutionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name      TEXT NOT NULL,
      previous_version TEXT NOT NULL,
      new_version     TEXT NOT NULL,
      reason          TEXT NOT NULL,
      category        TEXT NOT NULL,
      mutated_at      TEXT NOT NULL,
      rolled_back     INTEGER DEFAULT 0,
      previous_content TEXT NOT NULL,
      new_content     TEXT NOT NULL
    )
  `);

  logger.debug('Evolution schema initialized');
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Apply a validated mutation: update the skill on disk, log it, and rebuild indexes.
 */
export function commitMutation(
  db: Database.Database,
  skillName: string,
  content: string,
  reason: string,
  category: string,
  previousContent: string,
  previousVersion: string,
): EvolutionLogEntry {
  const mutatedAt = new Date().toISOString();

  // Extract new version from content frontmatter
  const newVersion = extractVersion(content) || previousVersion;

  // 1. Update the skill file on disk
  updateSkill(skillName, content);

  // 2. Insert audit log
  const stmt = db.prepare(`
    INSERT INTO evolution_log
      (skill_name, previous_version, new_version, reason, category, mutated_at, rolled_back, previous_content, new_content)
    VALUES
      (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const result = stmt.run(
    skillName,
    previousVersion,
    newVersion,
    reason,
    category,
    mutatedAt,
    previousContent,
    content,
  );

  // 3. Rebuild SKILLS_INDEX for all group folders
  rebuildAllGroupIndexes();

  // 4. Log the event
  logger.info(
    { skillName, previousVersion, newVersion, category, logId: result.lastInsertRowid },
    'Mutation committed',
  );

  return {
    id: String(result.lastInsertRowid),
    skillName,
    previousVersion,
    newVersion,
    reason,
    category: category as FailureCategory,
    mutatedAt,
    rolledBack: false,
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Get evolution history, optionally filtered by skill name.
 */
export function getEvolutionLog(
  db: Database.Database,
  skillName?: string,
  limit: number = 50,
): EvolutionLogEntry[] {
  const query = skillName
    ? `SELECT * FROM evolution_log WHERE skill_name = ? ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM evolution_log ORDER BY id DESC LIMIT ?`;

  const rows = skillName
    ? (db.prepare(query).all(skillName, limit) as EvolutionRow[])
    : (db.prepare(query).all(limit) as EvolutionRow[]);

  return rows.map(rowToEntry);
}

/**
 * Count evolutions within a time window (for rate limiting).
 */
export function getRecentEvolutionCount(
  db: Database.Database,
  windowMs: number,
): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM evolution_log WHERE mutated_at >= ? AND rolled_back = 0`,
    )
    .get(since) as { count: number } | undefined;

  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Roll back a mutation by restoring the previous content.
 * Marks the log entry as rolled_back = 1.
 */
export function rollbackMutation(
  db: Database.Database,
  skillName: string,
  logId: number,
): boolean {
  // Find the log entry
  const row = db
    .prepare(
      `SELECT * FROM evolution_log WHERE id = ? AND skill_name = ? AND rolled_back = 0`,
    )
    .get(logId, skillName) as EvolutionRow | undefined;

  if (!row) {
    logger.warn(
      { skillName, logId },
      'Rollback failed: log entry not found or already rolled back',
    );
    return false;
  }

  try {
    // Restore previous content
    updateSkill(skillName, row.previous_content);

    // Mark as rolled back
    db.prepare(`UPDATE evolution_log SET rolled_back = 1 WHERE id = ?`).run(
      logId,
    );

    // Rebuild indexes
    rebuildAllGroupIndexes();

    logger.info({ skillName, logId }, 'Mutation rolled back');
    return true;
  } catch (err) {
    logger.error(
      { err, skillName, logId },
      'Rollback failed: could not restore skill',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EvolutionRow {
  id: number;
  skill_name: string;
  previous_version: string;
  new_version: string;
  reason: string;
  category: string;
  mutated_at: string;
  rolled_back: number;
  previous_content: string;
  new_content: string;
}

function rowToEntry(row: EvolutionRow): EvolutionLogEntry {
  return {
    id: String(row.id),
    skillName: row.skill_name,
    previousVersion: row.previous_version,
    newVersion: row.new_version,
    reason: row.reason,
    category: row.category as FailureCategory,
    mutatedAt: row.mutated_at,
    rolledBack: row.rolled_back === 1,
  };
}

/** Extract version from YAML frontmatter. */
function extractVersion(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === 'version') {
      return line.slice(colonIdx + 1).trim() || null;
    }
  }
  return null;
}

/** Rebuild SKILLS_INDEX.md for every group folder in GROUPS_DIR. */
function rebuildAllGroupIndexes(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  try {
    const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        rebuildSkillsIndex(entry.name);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to rebuild group skill indexes');
  }
}
