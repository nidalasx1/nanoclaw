import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { logger } from './logger.js';

// --- Schema ---

export function initSkillTracking(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      success INTEGER DEFAULT 1,
      token_count INTEGER,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_tracking_group
      ON skill_tracking(group_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_skill_tracking_ts
      ON skill_tracking(timestamp);

    CREATE TABLE IF NOT EXISTS skill_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_hash TEXT NOT NULL UNIQUE,
      tool_sequence TEXT NOT NULL,
      skill_name TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

// --- Types ---

export interface SessionStats {
  toolCallCount: number;
  uniqueTools: string[];
  toolSequence: string[];
  successCount: number;
  failureCount: number;
  totalTokens: number;
}

export interface SessionSummary {
  groupId: string;
  sessionId: string;
  stats: SessionStats;
  outcome: 'success' | 'mixed' | 'failure';
  skillsCreated: string[];
  skillsImproved: string[];
  duration: { first: string; last: string } | null;
}

// --- SkillTracker ---

export class SkillTracker {
  private db: Database.Database;
  private threshold: number;

  constructor(db: Database.Database, threshold: number = 5) {
    this.db = db;
    this.threshold = threshold;
  }

  // --- Tool call recording ---

  recordToolCall(
    groupId: string,
    toolName: string,
    input?: string,
    output?: string,
    opts?: { sessionId?: string; success?: boolean; tokenCount?: number },
  ): void {
    const sessionId =
      opts?.sessionId ?? this.getOrCreateSessionId(groupId);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO skill_tracking (group_id, session_id, tool_name, input, output, success, token_count, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        sessionId,
        toolName,
        input ?? null,
        output ?? null,
        opts?.success === false ? 0 : 1,
        opts?.tokenCount ?? null,
        now,
      );
  }

  getSessionStats(groupId: string, sessionId?: string): SessionStats {
    const sid = sessionId ?? this.getOrCreateSessionId(groupId);
    const rows = this.db
      .prepare(
        `SELECT tool_name, success, token_count FROM skill_tracking
         WHERE group_id = ? AND session_id = ?
         ORDER BY timestamp`,
      )
      .all(groupId, sid) as Array<{
      tool_name: string;
      success: number;
      token_count: number | null;
    }>;

    const toolSequence: string[] = [];
    const toolSet = new Set<string>();
    let successCount = 0;
    let failureCount = 0;
    let totalTokens = 0;

    for (const row of rows) {
      toolSequence.push(row.tool_name);
      toolSet.add(row.tool_name);
      if (row.success) successCount++;
      else failureCount++;
      if (row.token_count) totalTokens += row.token_count;
    }

    return {
      toolCallCount: rows.length,
      uniqueTools: Array.from(toolSet),
      toolSequence,
      successCount,
      failureCount,
      totalTokens,
    };
  }

  // --- Complexity threshold ---

  shouldCreateSkill(groupId: string, sessionId?: string): boolean {
    const stats = this.getSessionStats(groupId, sessionId);

    // Must meet minimum tool call threshold
    if (stats.toolCallCount < this.threshold) return false;

    // Task must be mostly successful
    if (stats.failureCount > stats.successCount) return false;

    // Check if a similar pattern already produced a skill
    const hash = this.hashToolSequence(stats.toolSequence);
    const existing = this.db
      .prepare(
        `SELECT id FROM skill_patterns WHERE pattern_hash = ? AND skill_name IS NOT NULL`,
      )
      .get(hash) as { id: number } | undefined;
    if (existing) return false;

    // Also check fuzzy match (±1 tool)
    if (this.hasSimilarPattern(stats.toolSequence)) return false;

    return true;
  }

  // --- Skill creation prompt ---

  generateSkillPrompt(groupId: string, sessionId?: string): string {
    const stats = this.getSessionStats(groupId, sessionId);
    const sid = sessionId ?? this.getOrCreateSessionId(groupId);

    // Get the actual tool calls for context
    const rows = this.db
      .prepare(
        `SELECT tool_name, input, output FROM skill_tracking
         WHERE group_id = ? AND session_id = ?
         ORDER BY timestamp`,
      )
      .all(groupId, sid) as Array<{
      tool_name: string;
      input: string | null;
      output: string | null;
    }>;

    const toolSummary = rows
      .map(
        (r, i) =>
          `${i + 1}. ${r.tool_name}${r.input ? ` — input: ${r.input.slice(0, 200)}` : ''}`,
      )
      .join('\n');

    // Record the pattern (skill_name filled later when skill is saved)
    const hash = this.hashToolSequence(stats.toolSequence);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO skill_patterns (pattern_hash, tool_sequence, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(hash, JSON.stringify(stats.toolSequence), new Date().toISOString());

    return `You just completed a multi-step task using ${stats.toolCallCount} tool calls across ${stats.uniqueTools.length} different tools.

## Tool sequence used:
${toolSummary}

## Your task:
Analyze what you just did and create a reusable SKILL.md file that captures this workflow. The skill should:

1. Have a clear, descriptive name (kebab-case)
2. Define when this skill should trigger (trigger patterns)
3. List the step-by-step instructions so a future agent can replicate this exact workflow
4. Include any important context or edge cases you encountered

Write the SKILL.md following the standard NanoClaw skill format. Save it to the group's skills directory.`;
  }

  // --- Skill improvement ---

  shouldImproveSkill(
    groupId: string,
    skillName: string,
    sessionId?: string,
  ): boolean {
    const stats = this.getSessionStats(groupId, sessionId);

    // Need enough data to judge deviation
    if (stats.toolCallCount < 3) return false;

    // Find the original pattern for this skill
    const row = this.db
      .prepare(
        `SELECT tool_sequence FROM skill_patterns WHERE skill_name = ?`,
      )
      .get(skillName) as { tool_sequence: string } | undefined;
    if (!row) return false;

    const originalSequence = JSON.parse(row.tool_sequence) as string[];
    const currentSequence = stats.toolSequence;

    // Calculate deviation: how different is the current sequence from the original?
    const deviation = this.sequenceDeviation(
      originalSequence,
      currentSequence,
    );

    // If agent deviated significantly (>30% different tools), suggest improvement
    return deviation > 0.3;
  }

  generateImprovementPrompt(
    groupId: string,
    skillName: string,
    currentContent: string,
    sessionId?: string,
  ): string {
    const stats = this.getSessionStats(groupId, sessionId);

    return `You used the skill "${skillName}" but deviated from its documented workflow.

## Current skill content:
${currentContent}

## What you actually did this session:
- Tools used: ${stats.toolSequence.join(' → ')}
- Total calls: ${stats.toolCallCount}
- Success rate: ${Math.round((stats.successCount / stats.toolCallCount) * 100)}%

## Your task:
Review the current SKILL.md and update it based on what you learned this session. Consider:
1. Are there steps that should be added or removed?
2. Did you find a better order of operations?
3. Are there edge cases the skill should handle?

Update the SKILL.md with improved instructions.`;
  }

  // --- Session summary ---

  getSessionSummary(groupId: string, sessionId?: string): SessionSummary {
    const sid = sessionId ?? this.getOrCreateSessionId(groupId);
    const stats = this.getSessionStats(groupId, sid);

    // Determine outcome
    let outcome: 'success' | 'mixed' | 'failure';
    if (stats.failureCount === 0) outcome = 'success';
    else if (stats.successCount > stats.failureCount) outcome = 'mixed';
    else outcome = 'failure';

    // Get time range
    const timeRange = this.db
      .prepare(
        `SELECT MIN(timestamp) as first, MAX(timestamp) as last
         FROM skill_tracking
         WHERE group_id = ? AND session_id = ?`,
      )
      .get(groupId, sid) as { first: string | null; last: string | null };

    // Check if any skills were created/improved from this pattern
    const hash = this.hashToolSequence(stats.toolSequence);
    const patternRow = this.db
      .prepare(
        `SELECT skill_name FROM skill_patterns WHERE pattern_hash = ?`,
      )
      .get(hash) as { skill_name: string | null } | undefined;

    const skillsCreated = patternRow?.skill_name
      ? [patternRow.skill_name]
      : [];

    return {
      groupId,
      sessionId: sid,
      stats,
      outcome,
      skillsCreated,
      skillsImproved: [], // Populated externally when improvement is tracked
      duration:
        timeRange.first && timeRange.last
          ? { first: timeRange.first, last: timeRange.last }
          : null,
    };
  }

  // --- Mark a pattern as having produced a skill ---

  recordSkillCreated(toolSequence: string[], skillName: string): void {
    const hash = this.hashToolSequence(toolSequence);
    this.db
      .prepare(
        `UPDATE skill_patterns SET skill_name = ? WHERE pattern_hash = ?`,
      )
      .run(skillName, hash);
  }

  // --- Internal helpers ---

  private getOrCreateSessionId(groupId: string): string {
    // Use the most recent session for this group
    const row = this.db
      .prepare(
        `SELECT session_id FROM skill_tracking
         WHERE group_id = ?
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(groupId) as { session_id: string } | undefined;
    return row?.session_id ?? crypto.randomUUID();
  }

  private hashToolSequence(sequence: string[]): string {
    // Normalize: sort the unique tools and hash them
    // This way sequences with the same tools in slightly different order match
    const normalized = Array.from(new Set(sequence)).sort().join('|');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private hasSimilarPattern(sequence: string[]): boolean {
    const rows = this.db
      .prepare(
        `SELECT tool_sequence FROM skill_patterns WHERE skill_name IS NOT NULL`,
      )
      .all() as Array<{ tool_sequence: string }>;

    const currentTools = new Set(sequence);

    for (const row of rows) {
      const existingTools = new Set(
        JSON.parse(row.tool_sequence) as string[],
      );

      // Check if sets differ by at most 1 tool
      const allTools = new Set(Array.from(currentTools).concat(Array.from(existingTools)));
      const intersection = Array.from(currentTools).filter((t) =>
        existingTools.has(t),
      );
      const diff = allTools.size - intersection.length;

      if (diff <= 1) return true;
    }

    return false;
  }

  private sequenceDeviation(
    original: string[],
    current: string[],
  ): number {
    const origSet = new Set(original);
    const currSet = new Set(current);

    const allTools = new Set(Array.from(origSet).concat(Array.from(currSet)));
    const intersection = Array.from(origSet).filter((t) => currSet.has(t));

    if (allTools.size === 0) return 0;
    return 1 - intersection.length / allTools.size;
  }
}
