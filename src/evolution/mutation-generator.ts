import { logger } from '../logger.js';
import { loadSkill } from '../skill-engine.js';
import type { FailureReport, MutationCandidate } from './types.js';

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a Claude prompt that rewrites only the broken sections of a skill
 * while preserving working parts. Returns the prompt string — does NOT
 * call the LLM directly.
 */
export function buildMutationPrompt(
  skillName: string,
  currentContent: string,
  failures: FailureReport[],
): string {
  const failureSummaries = failures
    .map(
      (f, i) =>
        `### Failure ${i + 1}: ${f.category}
- **Evidence:** ${f.evidence.join('; ')}
- **Suggested fix:** ${f.suggestedFix}
- **Confidence:** ${(f.confidence * 100).toFixed(0)}%
- **Traces:** ${f.traceIds.length} execution(s)`,
    )
    .join('\n\n');

  return `You are a skill surgeon. Your job is to fix a broken SKILL.md while preserving everything that works.

## Skill: ${skillName}

## Current SKILL.md content:
\`\`\`
${currentContent}
\`\`\`

## Detected failures:
${failureSummaries}

## Rules:
1. **Preserve the YAML frontmatter** — bump the version patch number only
2. **Only modify sections related to the failures** — do not rewrite working steps
3. **Keep the same structure** (headings, step numbering, trigger patterns)
4. **Add edge-case handling** if the failure was an edge case
5. **Update outdated information** if the failure was outdated info
6. **Fix the step sequence** if the failure was a wrong sequence or missing step
7. **Add a fallback** if a tool was unavailable

## Output:
Return ONLY the complete updated SKILL.md content (including frontmatter). No explanation, no code fences.`;
}

// ---------------------------------------------------------------------------
// Mutation generator
// ---------------------------------------------------------------------------

/**
 * Generate a mutation candidate for a skill based on failure reports.
 * Returns a MutationCandidate with the prompt as mutatedContent (the caller
 * sends the prompt to the LLM and replaces mutatedContent with the response).
 */
export function generateMutation(
  skillName: string,
  currentContent: string,
  failureReport: FailureReport,
): MutationCandidate | null {
  const skill = loadSkill(skillName);
  if (!skill) {
    logger.warn({ skillName }, 'Cannot generate mutation: skill not found');
    return null;
  }

  // Use the actual on-disk content if available, fall back to provided content
  const content = skill.body
    ? `---\n${formatFrontmatter(skill.frontmatter)}\n---\n${skill.body}`
    : currentContent;

  const prompt = buildMutationPrompt(skillName, content, [failureReport]);

  const diffSummary = buildDiffSummary(failureReport);

  logger.info(
    { skillName, category: failureReport.category },
    'Mutation candidate generated',
  );

  return {
    skillName,
    originalContent: content,
    mutatedContent: prompt, // Caller sends this to LLM, replaces with response
    reason: `Fix ${failureReport.category}: ${failureReport.suggestedFix}`,
    failureReport,
    diffSummary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDiffSummary(report: FailureReport): string {
  const parts: string[] = [`Category: ${report.category}`];

  switch (report.category) {
    case 'wrong_sequence':
      parts.push('Steps need reordering to match successful execution patterns');
      break;
    case 'missing_step':
      parts.push('Adding missing step(s) observed in successful traces');
      break;
    case 'outdated_info':
      parts.push('Updating stale information based on recent execution data');
      break;
    case 'edge_case':
      parts.push('Adding edge-case handling for previously unhandled scenario');
      break;
    case 'tool_unavailable':
      parts.push('Adding fallback path for unavailable tool');
      break;
    default:
      parts.push('General fix based on execution trace analysis');
  }

  parts.push(`Confidence: ${(report.confidence * 100).toFixed(0)}%`);
  parts.push(`Based on ${report.traceIds.length} trace(s)`);

  return parts.join('\n');
}

function formatFrontmatter(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
      return `${k}: ${String(v ?? '')}`;
    })
    .join('\n');
}
