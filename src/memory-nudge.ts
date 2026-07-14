import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFile {
  /** Relative filename within the group folder (e.g. CLAUDE.md) */
  filename: string;
  content: string;
  /** Approximate token count (words × 1.3) */
  tokens: number;
}

export interface MemoryBundle {
  /** Group-level memory files injected into the system prompt */
  files: MemoryFile[];
  /** Total approximate tokens across all files */
  totalTokens: number;
  /** Whether the nudge system thinks memory should be refreshed */
  nudge: boolean;
  nudgeReason?: string;
}

export interface SessionSearchResult {
  groupFolder: string;
  content: string;
  timestamp: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files loaded from each group folder, in priority order */
const MEMORY_FILES = ['CLAUDE.md', 'MEMORY.md', 'SKILLS_INDEX.md'] as const;

/** Default token budget for memory injection */
const DEFAULT_TOKEN_BUDGET = 4000;

/** Nudge every N messages if no keyword triggers */
const NUDGE_INTERVAL_MESSAGES = 25;

/** Keywords that trigger an immediate memory nudge */
const NUDGE_KEYWORDS = [
  'remember',
  'don\'t forget',
  'note that',
  'always do',
  'never do',
  'from now on',
  'update memory',
  'save this',
];

// ---------------------------------------------------------------------------
// SQLite — session search with FTS5
// ---------------------------------------------------------------------------

let memDb: Database.Database;

function initMemoryDb(): void {
  const dbPath = path.join(STORE_DIR, 'memory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  memDb = new Database(dbPath);

  memDb.exec(`
    CREATE TABLE IF NOT EXISTS session_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_group ON session_logs(group_folder);
    CREATE INDEX IF NOT EXISTS idx_session_ts ON session_logs(timestamp);
  `);

  // Create FTS5 virtual table if it doesn't exist
  try {
    memDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_logs_fts USING fts5(
        content,
        group_folder,
        content=session_logs,
        content_rowid=id
      );
    `);
  } catch {
    // FTS5 table already exists or FTS5 not available
    logger.debug('FTS5 table creation skipped (may already exist)');
  }

  // Triggers to keep FTS in sync
  try {
    memDb.exec(`
      CREATE TRIGGER IF NOT EXISTS session_logs_ai AFTER INSERT ON session_logs BEGIN
        INSERT INTO session_logs_fts(rowid, content, group_folder)
        VALUES (new.id, new.content, new.group_folder);
      END;
      CREATE TRIGGER IF NOT EXISTS session_logs_ad AFTER DELETE ON session_logs BEGIN
        INSERT INTO session_logs_fts(session_logs_fts, rowid, content, group_folder)
        VALUES ('delete', old.id, old.content, old.group_folder);
      END;
    `);
  } catch {
    logger.debug('FTS5 triggers already exist');
  }

  // Compaction metadata
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS compaction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      compacted_at TEXT NOT NULL,
      rows_before INTEGER NOT NULL,
      rows_after INTEGER NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Session log CRUD
// ---------------------------------------------------------------------------

/**
 * Log a session exchange (user message + agent response summary) for a group.
 */
export function logSession(groupFolder: string, content: string): void {
  ensureDb();
  memDb
    .prepare(
      'INSERT INTO session_logs (group_folder, content, timestamp) VALUES (?, ?, ?)',
    )
    .run(groupFolder, content, new Date().toISOString());
}

/**
 * Full-text search across session logs. Returns ranked results.
 */
export function searchSessions(
  query: string,
  groupFolder?: string,
  limit: number = 20,
): SessionSearchResult[] {
  ensureDb();

  if (groupFolder) {
    return memDb
      .prepare(
        `SELECT s.group_folder, s.content, s.timestamp, f.rank
         FROM session_logs_fts f
         JOIN session_logs s ON s.id = f.rowid
         WHERE session_logs_fts MATCH ? AND s.group_folder = ?
         ORDER BY f.rank
         LIMIT ?`,
      )
      .all(query, groupFolder, limit) as SessionSearchResult[];
  }

  return memDb
    .prepare(
      `SELECT s.group_folder, s.content, s.timestamp, f.rank
       FROM session_logs_fts f
       JOIN session_logs s ON s.id = f.rowid
       WHERE session_logs_fts MATCH ?
       ORDER BY f.rank
       LIMIT ?`,
    )
    .all(query, limit) as SessionSearchResult[];
}

// ---------------------------------------------------------------------------
// Memory compaction
// ---------------------------------------------------------------------------

/**
 * Compact old session logs for a group. Keeps the most recent `keepCount` rows,
 * deletes the rest, and rebuilds the FTS index.
 */
export function compactSessionLogs(
  groupFolder: string,
  keepCount: number = 500,
): { rowsBefore: number; rowsAfter: number } {
  ensureDb();

  const countRow = memDb
    .prepare('SELECT COUNT(*) as cnt FROM session_logs WHERE group_folder = ?')
    .get(groupFolder) as { cnt: number };

  const rowsBefore = countRow.cnt;

  if (rowsBefore <= keepCount) {
    return { rowsBefore, rowsAfter: rowsBefore };
  }

  // Delete oldest rows beyond keepCount
  memDb
    .prepare(
      `DELETE FROM session_logs
       WHERE group_folder = ? AND id NOT IN (
         SELECT id FROM session_logs
         WHERE group_folder = ?
         ORDER BY timestamp DESC
         LIMIT ?
       )`,
    )
    .run(groupFolder, groupFolder, keepCount);

  // Rebuild FTS index
  try {
    memDb.exec(`INSERT INTO session_logs_fts(session_logs_fts) VALUES ('rebuild')`);
  } catch {
    logger.debug('FTS rebuild skipped');
  }

  const afterRow = memDb
    .prepare('SELECT COUNT(*) as cnt FROM session_logs WHERE group_folder = ?')
    .get(groupFolder) as { cnt: number };

  const rowsAfter = afterRow.cnt;

  // Log compaction
  memDb
    .prepare(
      'INSERT INTO compaction_log (group_folder, compacted_at, rows_before, rows_after) VALUES (?, ?, ?, ?)',
    )
    .run(groupFolder, new Date().toISOString(), rowsBefore, rowsAfter);

  logger.info(
    { groupFolder, rowsBefore, rowsAfter },
    'Session logs compacted',
  );

  return { rowsBefore, rowsAfter };
}

// ---------------------------------------------------------------------------
// Memory file loading
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  // Rough approximation: ~1.3 tokens per word
  const words = text.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

/**
 * Load structured memory files for a group, respecting a token budget.
 * Files are loaded in priority order (CLAUDE.md first) and truncated if
 * the budget is exceeded.
 */
export function loadGroupMemory(
  groupFolder: string,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): MemoryFile[] {
  const groupPath = path.join(GROUPS_DIR, groupFolder);
  const files: MemoryFile[] = [];
  let remaining = tokenBudget;

  for (const filename of MEMORY_FILES) {
    const filePath = path.join(groupPath, filename);

    if (!fs.existsSync(filePath)) continue;

    try {
      let content = fs.readFileSync(filePath, 'utf-8');
      let tokens = estimateTokens(content);

      // Truncate if over budget
      if (tokens > remaining && remaining > 0) {
        const ratio = remaining / tokens;
        const cutIdx = Math.floor(content.length * ratio);
        content = content.slice(0, cutIdx) + '\n\n[...truncated to fit token budget]';
        tokens = remaining;
      } else if (remaining <= 0) {
        break;
      }

      files.push({ filename, content, tokens });
      remaining -= tokens;
    } catch {
      // File unreadable, skip
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Nudge system
// ---------------------------------------------------------------------------

/** Per-group message counters for nudge timing */
const messageCounters = new Map<string, number>();

/**
 * Record that a message was processed for a group.
 * Returns true if a memory nudge should be triggered.
 */
export function tickMessage(groupFolder: string, messageContent: string): boolean {
  const count = (messageCounters.get(groupFolder) ?? 0) + 1;
  messageCounters.set(groupFolder, count);

  // Check keyword triggers
  const lower = messageContent.toLowerCase();
  for (const kw of NUDGE_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  // Check interval trigger
  if (count >= NUDGE_INTERVAL_MESSAGES) {
    messageCounters.set(groupFolder, 0);
    return true;
  }

  return false;
}

/**
 * Reset the nudge counter for a group (e.g. after memory was written).
 */
export function resetNudgeCounter(groupFolder: string): void {
  messageCounters.set(groupFolder, 0);
}

/**
 * Build a complete memory bundle for injection into the system prompt.
 * Combines file loading + nudge state.
 */
export function getMemoryBundle(
  groupFolder: string,
  tokenBudget?: number,
): MemoryBundle {
  const files = loadGroupMemory(groupFolder, tokenBudget);
  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const count = messageCounters.get(groupFolder) ?? 0;

  let nudge = false;
  let nudgeReason: string | undefined;

  if (count >= NUDGE_INTERVAL_MESSAGES) {
    nudge = true;
    nudgeReason = `${NUDGE_INTERVAL_MESSAGES} messages since last memory check`;
  }

  return { files, totalTokens, nudge, nudgeReason };
}

// ---------------------------------------------------------------------------
// Memory file writers
// ---------------------------------------------------------------------------

/**
 * Write or update a memory file for a group.
 */
export function writeMemoryFile(
  groupFolder: string,
  filename: string,
  content: string,
): void {
  // Only allow known memory files
  if (!MEMORY_FILES.includes(filename as (typeof MEMORY_FILES)[number])) {
    throw new Error(`Unknown memory file: ${filename}`);
  }

  const groupPath = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(groupPath, { recursive: true });

  const filePath = path.join(groupPath, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.debug({ groupFolder, filename }, 'Memory file written');
}

/**
 * Append content to a memory file (useful for incremental MEMORY.md updates).
 */
export function appendMemoryFile(
  groupFolder: string,
  filename: string,
  content: string,
): void {
  if (!MEMORY_FILES.includes(filename as (typeof MEMORY_FILES)[number])) {
    throw new Error(`Unknown memory file: ${filename}`);
  }

  const groupPath = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(groupPath, { recursive: true });

  const filePath = path.join(groupPath, filename);
  fs.appendFileSync(filePath, '\n' + content, 'utf-8');
  logger.debug({ groupFolder, filename }, 'Memory file appended');
}

// ---------------------------------------------------------------------------
// Init / cleanup
// ---------------------------------------------------------------------------

function ensureDb(): void {
  if (!memDb) initMemoryDb();
}

export function initMemoryNudge(): void {
  initMemoryDb();
  logger.info('Memory nudge system initialized');
}

export function closeMemoryDb(): void {
  if (memDb) {
    memDb.close();
  }
}
