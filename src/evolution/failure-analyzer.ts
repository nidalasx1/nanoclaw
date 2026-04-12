import Database from 'better-sqlite3';

import { logger } from '../logger.js';
import type { ExecutionTrace, FailureCategory, FailureReport } from './types.js';

// ---------------------------------------------------------------------------
// Procedure parsing
// ---------------------------------------------------------------------------

/**
 * Extract numbered procedure steps from a SKILL.md body.
 * Looks for a "## Procedure" section and pulls out numbered items.
 */
function parseProcedureSteps(skillBody: string): string[] {
  const lines = skillBody.split('\n');
  let inProcedure = false;
  const steps: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Start capturing after ## Procedure heading
    if (/^##\s+Procedure/i.test(trimmed)) {
      inProcedure = true;
      continue;
    }

    // Stop at the next heading
    if (inProcedure && /^##\s+/.test(trimmed)) {
      break;
    }

    if (inProcedure) {
      // Match numbered items like "1. Do something" or "1) Do something"
      const match = trimmed.match(/^\d+[.)]\s+(.+)/);
      if (match) {
        steps.push(match[1]);
      }
    }
  }

  return steps;
}

/**
 * Extract tool names mentioned in a procedure step.
 * Looks for backtick-wrapped tool names or common patterns like "use X", "call X", "run X".
 */
function extractToolsFromStep(step: string): string[] {
  const tools: string[] = [];

  // Match backtick-wrapped names (e.g., `Bash`, `Read`)
  const backtickMatches = step.matchAll(/`(\w+)`/g);
  for (const m of backtickMatches) {
    tools.push(m[1]);
  }

  // Match "use/call/run/invoke <ToolName>" patterns
  const verbMatches = step.matchAll(/(?:use|call|run|invoke)\s+(\w+)/gi);
  for (const m of verbMatches) {
    tools.push(m[1]);
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Sequence comparison (Levenshtein-style)
// ---------------------------------------------------------------------------

/**
 * Compute edit distance between two string sequences.
 * Used for comparing tool call order vs documented procedure.
 */
function sequenceEditDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,     // deletion
        dp[i][j - 1] + 1,     // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Helpers to extract info from ExecutionTrace
// ---------------------------------------------------------------------------

/** Extract flat tool name sequence from trace's toolCalls array. */
function getToolSequence(trace: ExecutionTrace): string[] {
  return trace.toolCalls.map((tc) => tc.name);
}

/** Count failed tool calls in a trace. */
function getFailureCount(trace: ExecutionTrace): number {
  return trace.toolCalls.filter((tc) => !tc.success).length;
}

/** Check if the trace had any deviation from skill procedures. */
function hasDeviation(trace: ExecutionTrace): boolean {
  return trace.skillsDeviated.length > 0;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Categorize a failure by comparing the actual tool sequence against
 * the documented procedure steps.
 */
export function categorizeFailure(
  toolSequence: string[],
  procedureSteps: string[],
): FailureCategory {
  if (toolSequence.length === 0) return 'edge_case';

  // Extract expected tools from procedure steps
  const expectedTools: string[] = [];
  for (const step of procedureSteps) {
    expectedTools.push(...extractToolsFromStep(step));
  }

  // If no tools could be extracted from procedure, it's an edge case
  if (expectedTools.length === 0) return 'edge_case';

  // Check for tool_unavailable: a tool in the procedure wasn't used at all
  const usedSet = new Set(toolSequence.map((t) => t.toLowerCase()));
  const expectedSet = new Set(expectedTools.map((t) => t.toLowerCase()));
  const missingTools = [...expectedSet].filter((t) => !usedSet.has(t));

  // Check for tools that returned errors (heuristic: if expected tool is missing, it may be unavailable)
  if (missingTools.length > 0 && missingTools.length === expectedSet.size) {
    return 'tool_unavailable';
  }

  // Check for missing_step: procedure has steps the agent skipped
  if (missingTools.length > 0) {
    return 'missing_step';
  }

  // Check for wrong_sequence: tools called in different order
  const distance = sequenceEditDistance(
    toolSequence.map((t) => t.toLowerCase()),
    expectedTools.map((t) => t.toLowerCase()),
  );
  const maxLen = Math.max(toolSequence.length, expectedTools.length);
  const normalizedDistance = maxLen > 0 ? distance / maxLen : 0;

  if (normalizedDistance > 0.3) {
    return 'wrong_sequence';
  }

  // Default: edge case the procedure doesn't cover
  return 'edge_case';
}

/**
 * Analyze a single execution trace against a skill's content.
 * Returns null if the trace shows success with no deviation.
 */
export function analyzeTrace(
  trace: ExecutionTrace,
  skillContent: string,
): FailureReport | null {
  const deviation = hasDeviation(trace);
  const failureCount = getFailureCount(trace);

  // No failure to analyze if outcome is success and no deviation
  if (trace.outcome === 'success' && !deviation) {
    return null;
  }

  const toolSequence = getToolSequence(trace);
  const procedureSteps = parseProcedureSteps(skillContent);
  const category = categorizeFailure(toolSequence, procedureSteps);

  // Build evidence from the trace
  const evidence: string[] = [];

  if (trace.outcome !== 'success') {
    evidence.push(`Outcome: ${trace.outcome}`);
  }
  if (deviation) {
    evidence.push(`Deviation detected: agent diverged from documented procedure`);
  }
  if (failureCount > 0) {
    evidence.push(`${failureCount} tool call(s) failed`);
  }

  // Build a suggested fix based on category
  let suggestedFix: string = '';
  switch (category) {
    case 'wrong_sequence':
      suggestedFix = `Reorder procedure steps to match the actual successful tool sequence: ${toolSequence.join(' → ')}`;
      break;
    case 'missing_step':
      suggestedFix = `Add missing steps to the procedure. Agent used: ${toolSequence.join(', ')}`;
      break;
    case 'outdated_info':
      suggestedFix = `Update tool references and expected outputs in the procedure — tool behavior may have changed`;
      break;
    case 'edge_case':
      suggestedFix = `Add handling for this scenario to the procedure. Evidence: ${evidence.join('; ')}`;
      break;
    case 'tool_unavailable':
      suggestedFix = `Replace unavailable tool(s) in procedure with alternatives the agent actually used`;
      break;
  }

  // Determine skill name from the first deviated skill, or first loaded skill
  const skillName =
    trace.skillsDeviated[0]?.skillName ??
    trace.skillsLoaded[0] ??
    'unknown';

  // Confidence based on evidence strength
  const confidence = Math.min(
    0.5 + (evidence.length * 0.15) + (failureCount > 0 ? 0.1 : 0),
    1.0,
  );

  return {
    skillName,
    category,
    evidence,
    suggestedFix,
    traceIds: [trace.id],
    confidence,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Aggregation across multiple traces
// ---------------------------------------------------------------------------

/**
 * Aggregate failures across multiple traces for the same skill.
 * Only returns a report if there are >= minTraces failures.
 */
export function getFailureReport(
  db: Database.Database,
  skillName: string,
  minTraces: number = 2,
): FailureReport | null {
  // Get recent traces for this skill that had failures
  const rows = db
    .prepare(
      `SELECT * FROM execution_traces
       WHERE skills_loaded LIKE ? AND outcome != 'success'
       ORDER BY timestamp DESC
       LIMIT 20`,
    )
    .all(`%"${skillName}"%`) as Array<Record<string, unknown>>;

  if (rows.length < minTraces) {
    return null;
  }

  // Rebuild traces and categorize each
  const categoryCounts = new Map<FailureCategory, number>();
  const allEvidence: string[] = [];
  const traceIds: string[] = [];

  for (const row of rows) {
    const toolCalls = JSON.parse(row.tool_calls as string) as Array<{ name: string; success: boolean }>;
    const toolSequence = toolCalls.map((tc) => tc.name);

    // Categorize from sequence alone (no skill content available here)
    const category = categorizeFailure(toolSequence, []);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    traceIds.push(row.id as string);

    if ((row.outcome as string) !== 'success') {
      const failCount = toolCalls.filter((tc) => !tc.success).length;
      allEvidence.push(`Trace ${row.id}: outcome=${row.outcome}, failures=${failCount}`);
    }
  }

  // Pick the most common failure category
  let topCategory: FailureCategory = 'edge_case';
  let topCount = 0;
  for (const [cat, count] of categoryCounts) {
    if (count > topCount) {
      topCategory = cat;
      topCount = count;
    }
  }

  return {
    skillName,
    category: topCategory,
    evidence: allEvidence.slice(0, 10),
    suggestedFix: `Skill "${skillName}" has failed ${rows.length} times (most common: ${topCategory}). Review and update the procedure.`,
    traceIds,
    confidence: Math.min(0.5 + (rows.length * 0.1), 1.0),
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Evolution gate
// ---------------------------------------------------------------------------

/**
 * Returns true if a skill has accumulated enough failures to warrant evolution.
 * Won't trigger if the skill was evolved in the last hour.
 */
export function shouldEvolve(
  db: Database.Database,
  skillName: string,
  minFailures: number = 2,
): boolean {
  // Count recent failures for this skill
  const countRow = db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM execution_traces
       WHERE skills_loaded LIKE ? AND outcome != 'success'`,
    )
    .get(`%"${skillName}"%`) as { cnt: number };

  if (countRow.cnt < minFailures) {
    return false;
  }

  // Check if skill was evolved recently (within the last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentEvolution = db
    .prepare(
      `SELECT id FROM evolution_log
       WHERE skill_name = ? AND mutated_at > ?
       LIMIT 1`,
    )
    .get(skillName, oneHourAgo) as { id: number } | undefined;

  if (recentEvolution) {
    logger.debug(
      { skillName },
      'Skipping evolution — skill was evolved within the last hour',
    );
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// LLM analysis prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a prompt that asks Claude to analyze WHY a skill failed.
 * Returns a string prompt — the caller handles LLM invocation.
 */
export function buildAnalysisPrompt(
  trace: ExecutionTrace,
  skillContent: string,
): string {
  const procedureSteps = parseProcedureSteps(skillContent);
  const toolSequence = getToolSequence(trace);
  const deviation = hasDeviation(trace);
  const failureCount = getFailureCount(trace);
  const skillName =
    trace.skillsDeviated[0]?.skillName ??
    trace.skillsLoaded[0] ??
    'unknown';

  return `You are analyzing why a skill execution failed. Return a JSON object matching the FailureReport shape.

## Skill content:
${skillContent}

## Extracted procedure steps:
${procedureSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Execution trace:
- Tool sequence: ${toolSequence.join(' → ')}
- Outcome: ${trace.outcome}
- Deviation from procedure: ${deviation ? 'yes' : 'no'}
- Failed tool calls: ${failureCount}
${skillName !== 'unknown' ? `- Skill: ${skillName}` : ''}

## Your task:
Analyze the gap between the documented procedure and what actually happened. Return a JSON object with these fields:

\`\`\`json
{
  "skillName": "${skillName}",
  "category": "wrong_sequence" | "missing_step" | "outdated_info" | "edge_case" | "tool_unavailable",
  "evidence": ["array of specific observations"],
  "suggestedFix": "concrete suggestion for how to update the skill",
  "traceIds": ["${trace.id}"],
  "confidence": 0.8,
  "timestamp": "${new Date().toISOString()}"
}
\`\`\`

Be specific about what went wrong and what concrete change to the SKILL.md would prevent this failure in the future.`;
}
