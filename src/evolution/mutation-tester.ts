/**
 * Mutation Tester — validates proposed skill mutations before commit.
 *
 * Checks structural validity, YAML frontmatter, required sections,
 * and semantic drift between original and mutated content.
 */
import { validateSkillContent } from '../skill-validator.js';
import { logger } from '../logger.js';
import type { ValidatedMutation } from './types.js';

// ---------------------------------------------------------------------------
// YAML frontmatter regex (mirrors skill-engine.ts)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const REQUIRED_FRONTMATTER_FIELDS = ['name', 'description', 'version'];
const REQUIRED_SECTIONS = ['## When to Use', '## Procedure'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full validation pipeline for a proposed mutation.
 * Runs skill-validator checks, structural checks, and semantic drift.
 */
export function testMutation(
  original: string,
  mutated: string,
): ValidatedMutation {
  const errors: string[] = [];

  // 1. Run skill-validator content checks (size, credentials, shell escapes)
  const contentValidation = validateSkillContent(mutated);
  if (!contentValidation.valid) {
    errors.push(...contentValidation.errors);
  }

  // 2. Structural validation (frontmatter + required sections)
  const structureResult = validateStructure(mutated);
  if (!structureResult.valid) {
    errors.push(...structureResult.errors);
  }

  // 3. Semantic drift check
  const driftResult = checkSemanticDrift(original, mutated);
  if (!driftResult.acceptable) {
    errors.push(
      `Semantic drift too high: ${(driftResult.driftScore * 100).toFixed(1)}% (max 60%)`,
    );
  }

  // Extract version info from frontmatter
  const originalVersion = extractFrontmatterField(original, 'version') || '0.0.0';
  const newVersion = extractFrontmatterField(mutated, 'version') || '0.0.0';
  const skillName = extractFrontmatterField(mutated, 'name') || 'unknown';
  const reason = `Mutation tested — ${errors.length === 0 ? 'passed' : `${errors.length} error(s)`}`;

  const passed = errors.length === 0;

  if (!passed) {
    logger.warn(
      { skillName, errors, driftScore: driftResult.driftScore },
      'Mutation validation failed',
    );
  } else {
    logger.info({ skillName, driftScore: driftResult.driftScore }, 'Mutation validation passed');
  }

  return {
    skillName,
    content: mutated,
    reason,
    version: newVersion,
    previousVersion: originalVersion,
    passed,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Validate structural requirements of a skill SKILL.md file.
 * Checks YAML frontmatter fields and required markdown sections.
 */
export function validateStructure(
  content: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check frontmatter exists
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    errors.push('Missing YAML frontmatter (--- delimiters)');
    return { valid: false, errors };
  }

  const yamlBlock = match[1];
  const body = match[2];

  // Parse frontmatter fields
  const fields = new Map<string, string>();
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) fields.set(key, value);
  }

  // Check required frontmatter fields
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!fields.has(field) || !fields.get(field)) {
      errors.push(`Missing required frontmatter field: ${field}`);
    }
  }

  // Check body isn't empty
  if (!body.trim()) {
    errors.push('Content is empty after frontmatter');
  }

  // Check required sections exist in body
  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      errors.push(`Missing required section: "${section}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check semantic drift between original and mutated content.
 * Uses Jaccard similarity on word sets.
 *
 * driftScore 0 = identical, 1 = completely different.
 * Acceptable if driftScore < 0.6.
 */
export function checkSemanticDrift(
  original: string,
  mutated: string,
): { driftScore: number; acceptable: boolean } {
  const originalWords = extractWords(original);
  const mutatedWords = extractWords(mutated);

  // Handle edge cases
  if (originalWords.size === 0 && mutatedWords.size === 0) {
    return { driftScore: 0, acceptable: true };
  }
  if (originalWords.size === 0 || mutatedWords.size === 0) {
    return { driftScore: 1, acceptable: false };
  }

  // Jaccard similarity = |intersection| / |union|
  let intersectionSize = 0;
  for (const word of originalWords) {
    if (mutatedWords.has(word)) intersectionSize++;
  }

  const unionSize = new Set([...originalWords, ...mutatedWords]).size;
  const similarity = intersectionSize / unionSize;
  const driftScore = 1 - similarity;

  return {
    driftScore: Math.round(driftScore * 1000) / 1000, // 3 decimal places
    acceptable: driftScore < 0.6,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract unique lowercase words from content (strip punctuation). */
function extractWords(content: string): Set<string> {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return new Set(words);
}

/** Extract a single frontmatter field value from content. */
function extractFrontmatterField(
  content: string,
  field: string,
): string | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === field) {
      return line.slice(colonIdx + 1).trim() || null;
    }
  }
  return null;
}
