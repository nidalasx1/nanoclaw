import Database from 'better-sqlite3';

import { logger } from '../logger.js';
import { loadSkill } from '../skill-engine.js';
import type { SkillTracker } from '../skill-tracker.js';
import { getRecentTraces } from './trace-collector.js';
import { analyzeTrace, shouldEvolve } from './failure-analyzer.js';
import { generateMutation } from './mutation-generator.js';
import { testMutation } from './mutation-tester.js';
import { commitMutation, getRecentEvolutionCount } from './auto-committer.js';
import { initTraceSchema } from './trace-collector.js';
import { initEvolutionSchema } from './auto-committer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 60_000; // 60 seconds after last session ends
const MAX_EVOLUTIONS_PER_HOUR = 3;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDb: Database.Database | null = null;
let pendingTracker: SkillTracker | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called after each agent session completes.
 * Debounces: resets a 60-second timer each call.
 * When the timer fires, runs the full evolution cycle.
 */
export function scheduleEvolution(
  db: Database.Database,
  tracker: SkillTracker,
  _groupId: string,
  _sessionId: string,
): void {
  // Stash references for when the timer fires
  pendingDb = db;
  pendingTracker = tracker;

  // Reset the debounce timer
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    if (!pendingDb || !pendingTracker) return;

    try {
      const result = await runEvolutionCycle(pendingDb);
      logger.info(
        {
          evolved: result.evolved.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
        },
        'Evolution cycle complete',
      );
    } catch (err) {
      logger.error({ err }, 'Evolution cycle failed');
    }
  }, DEBOUNCE_MS);

  logger.debug(
    { groupId: _groupId, sessionId: _sessionId },
    'Evolution scheduled (debounce reset)',
  );
}

/**
 * Run the full evolution pipeline on accumulated traces.
 */
export async function runEvolutionCycle(
  db: Database.Database,
): Promise<{ evolved: string[]; skipped: string[]; errors: string[] }> {
  const evolved: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  // Check rate limit first
  if (isRateLimited(db)) {
    logger.info('Evolution rate-limited, skipping cycle');
    return { evolved, skipped: ['rate-limited'], errors };
  }

  // Get recent unchecked traces
  const traces = getRecentTraces(db, 50);
  if (traces.length === 0) {
    logger.debug('No recent traces to process');
    return { evolved, skipped, errors };
  }

  for (const trace of traces) {
    // Only process traces that loaded skills
    if (trace.skillsLoaded.length === 0) continue;

    for (const deviation of trace.skillsDeviated) {
      const skillName = deviation.skillName;

      try {
        // Check if this skill should evolve
        if (!shouldEvolve(db, skillName)) {
          skipped.push(skillName);
          continue;
        }

        // Re-check rate limit before each evolution
        if (isRateLimited(db)) {
          skipped.push(`${skillName} (rate-limited)`);
          continue;
        }

        // Load the skill content for analysis
        const skill = loadSkill(skillName);
        if (!skill) {
          skipped.push(`${skillName} (not found)`);
          continue;
        }

        const skillContent = skill.body
          ? `---\n${Object.entries(skill.frontmatter).map(([k, v]) => `${k}: ${String(v ?? '')}`).join('\n')}\n---\n${skill.body}`
          : '';

        // Analyze the trace to produce a failure report
        const failureReport = analyzeTrace(trace, skillContent);
        if (!failureReport) {
          skipped.push(skillName);
          continue;
        }

        // Generate a mutation candidate
        const mutation = generateMutation(skillName, skillContent, failureReport);
        if (!mutation) {
          skipped.push(skillName);
          continue;
        }

        // Test the mutation before committing
        const validated = testMutation(mutation.originalContent, mutation.mutatedContent);
        if (!validated.passed) {
          logger.warn(
            { skillName, errors: validated.errors },
            'Mutation failed validation',
          );
          errors.push(`${skillName}: ${(validated.errors ?? []).join(', ')}`);
          continue;
        }

        // Commit the mutation
        commitMutation(
          db,
          skillName,
          validated.content,
          validated.reason,
          failureReport.category,
          mutation.originalContent,
          validated.previousVersion,
        );
        evolved.push(skillName);

        logger.info(
          { skillName, reason: failureReport.suggestedFix },
          'Skill evolved',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, skillName }, 'Evolution failed for skill');
        errors.push(`${skillName}: ${msg}`);
      }
    }
  }

  return { evolved, skipped, errors };
}

/**
 * Check if we've hit the rate limit (3 evolutions per hour).
 */
export function isRateLimited(db: Database.Database): boolean {
  const count = getRecentEvolutionCount(db, 60 * 60 * 1000); // last 60 minutes in ms
  return count >= MAX_EVOLUTIONS_PER_HOUR;
}

/**
 * One-time setup: initialize trace and evolution DB schemas.
 */
export function initEvolution(db: Database.Database): void {
  initTraceSchema(db);
  initEvolutionSchema(db);
  logger.info('Evolution pipeline initialized');
}

/**
 * Clear any pending debounce timers for graceful shutdown.
 */
export function stopEvolution(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingDb = null;
  pendingTracker = null;
  logger.debug('Evolution scheduler stopped');
}
