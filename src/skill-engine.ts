import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  created: string;
  updated: string;
  source: 'autonomous' | 'manual';
  trigger_count: number;
  tags: string[];
  [key: string]: unknown;
}

export interface SkillEntry {
  name: string;
  description: string;
  category: string;
  /** Absolute path to the skill folder */
  folderPath: string;
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface SkillIndexItem {
  name: string;
  description: string;
  category: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const SKILLS_DIR = path.resolve(PROJECT_ROOT, 'skills');

// ---------------------------------------------------------------------------
// YAML frontmatter parser (no external deps)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();

  // Booleans
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;

  // Numbers
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // Inline arrays: [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    if (inner.trim() === '') return [];
    return inner.split(',').map((item) => {
      const s = item.trim();
      // Strip surrounding quotes
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
      }
      return s;
    });
  }

  // Quoted strings
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error('SKILL.md missing YAML frontmatter (--- delimiters)');
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const result: Record<string, unknown> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1);
    if (!key) continue;
    result[key] = parseYamlValue(value);
  }

  // Ensure required fields have defaults
  const fm: SkillFrontmatter = {
    name: (result.name as string) || 'unknown',
    description: (result.description as string) || '',
    version: (result.version as string) || '1.0.0',
    created: (result.created as string) || new Date().toISOString(),
    updated: (result.updated as string) || new Date().toISOString(),
    source: (result.source as 'autonomous' | 'manual') || 'manual',
    trigger_count: (result.trigger_count as number) ?? 0,
    tags: Array.isArray(result.tags) ? (result.tags as string[]) : [],
    ...result,
  };

  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// In-memory index
// ---------------------------------------------------------------------------

/** name → SkillEntry */
const skillIndex = new Map<string, SkillEntry>();

function scanSkillsDir(): void {
  skillIndex.clear();

  if (!fs.existsSync(SKILLS_DIR)) {
    logger.debug('Skills directory does not exist, skipping scan');
    return;
  }

  let categories: string[];
  try {
    categories = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    logger.warn('Failed to read skills directory');
    return;
  }

  for (const category of categories) {
    const categoryPath = path.join(SKILLS_DIR, category);
    let skillFolders: string[];
    try {
      skillFolders = fs
        .readdirSync(categoryPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const skillName of skillFolders) {
      const folderPath = path.join(categoryPath, skillName);
      const skillMdPath = path.join(folderPath, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const raw = fs.readFileSync(skillMdPath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);

        skillIndex.set(frontmatter.name, {
          name: frontmatter.name,
          description: frontmatter.description,
          category,
          folderPath,
          frontmatter,
          body,
        });
      } catch (err) {
        logger.warn(
          { err, skill: skillName },
          `Failed to parse SKILL.md for ${category}/${skillName}`,
        );
      }
    }
  }

  logger.info({ count: skillIndex.size }, 'Skill index built');
}

// ---------------------------------------------------------------------------
// Filesystem watcher
// ---------------------------------------------------------------------------

let watcher: fs.FSWatcher | null = null;

function startWatcher(): void {
  if (watcher) return;
  if (!fs.existsSync(SKILLS_DIR)) return;

  try {
    watcher = fs.watch(SKILLS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Only react to SKILL.md changes
      if (filename.endsWith('SKILL.md') || eventType === 'rename') {
        logger.debug({ eventType, filename }, 'Skill filesystem change detected');
        scanSkillsDir();
      }
    });

    watcher.on('error', (err) => {
      logger.warn({ err }, 'Skills watcher error');
      watcher = null;
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to start skills watcher');
  }
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

// ---------------------------------------------------------------------------
// Public API — Discovery & Loading (3-level progressive)
// ---------------------------------------------------------------------------

/**
 * Level 0: Compact index of all skills (~50 tokens per skill).
 * Suitable for injection into system prompts.
 */
export function getSkillIndex(): SkillIndexItem[] {
  return Array.from(skillIndex.values()).map((s) => ({
    name: s.name,
    description: s.description,
    category: s.category,
    tags: s.frontmatter.tags,
  }));
}

/**
 * Level 1: Full SKILL.md content for a specific skill.
 * Returns null if the skill is not found.
 */
export function loadSkill(name: string): SkillEntry | null {
  return skillIndex.get(name) ?? null;
}

/**
 * Level 2: Load an optional reference file within a skill folder.
 * Returns null if the skill or file doesn't exist.
 */
export function loadSkillReference(name: string, refFile: string): string | null {
  const skill = skillIndex.get(name);
  if (!skill) return null;

  // Prevent path traversal
  const resolved = path.resolve(skill.folderPath, refFile);
  if (!resolved.startsWith(skill.folderPath)) {
    logger.warn({ name, refFile }, 'Path traversal attempt in loadSkillReference');
    return null;
  }

  try {
    return fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Force a full re-scan of the skills directory.
 */
export function refreshIndex(): void {
  scanSkillsDir();
}

// ---------------------------------------------------------------------------
// Public API — CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new skill. Writes the folder and SKILL.md.
 * Throws if the skill already exists.
 */
export function createSkill(category: string, name: string, content: string): SkillEntry {
  const folderPath = path.join(SKILLS_DIR, category, name);

  if (fs.existsSync(folderPath)) {
    throw new Error(`Skill already exists: ${category}/${name}`);
  }

  fs.mkdirSync(folderPath, { recursive: true });

  const skillMdPath = path.join(folderPath, 'SKILL.md');
  fs.writeFileSync(skillMdPath, content, 'utf-8');

  // Parse and index
  const { frontmatter, body } = parseFrontmatter(content);
  const entry: SkillEntry = {
    name: frontmatter.name,
    description: frontmatter.description,
    category,
    folderPath,
    frontmatter,
    body,
  };

  skillIndex.set(frontmatter.name, entry);
  logger.info({ category, name }, 'Skill created');
  return entry;
}

/**
 * Update an existing skill's SKILL.md.
 * Bumps the `updated` timestamp automatically.
 */
export function updateSkill(name: string, content: string): SkillEntry {
  const existing = skillIndex.get(name);
  if (!existing) {
    throw new Error(`Skill not found: ${name}`);
  }

  const { frontmatter, body } = parseFrontmatter(content);
  frontmatter.updated = new Date().toISOString();

  // Rebuild the file with the updated timestamp
  const updatedContent = rebuildSkillMd(frontmatter, body);
  const skillMdPath = path.join(existing.folderPath, 'SKILL.md');
  fs.writeFileSync(skillMdPath, updatedContent, 'utf-8');

  const entry: SkillEntry = {
    name: frontmatter.name,
    description: frontmatter.description,
    category: existing.category,
    folderPath: existing.folderPath,
    frontmatter,
    body,
  };

  skillIndex.set(frontmatter.name, entry);
  logger.info({ name }, 'Skill updated');
  return entry;
}

/**
 * Delete a skill folder and remove it from the index.
 */
export function deleteSkill(name: string): boolean {
  const existing = skillIndex.get(name);
  if (!existing) return false;

  fs.rmSync(existing.folderPath, { recursive: true, force: true });
  skillIndex.delete(name);
  logger.info({ name }, 'Skill deleted');
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => String(v)).join(', ')}]`;
  }
  return String(value ?? '');
}

function rebuildSkillMd(fm: SkillFrontmatter, body: string): string {
  const yamlLines: string[] = [];
  // Write known keys in a stable order
  const orderedKeys = [
    'name',
    'description',
    'version',
    'created',
    'updated',
    'source',
    'trigger_count',
    'tags',
  ];

  for (const key of orderedKeys) {
    if (key in fm) {
      yamlLines.push(`${key}: ${formatYamlValue(fm[key])}`);
    }
  }

  // Write any extra keys
  for (const [key, value] of Object.entries(fm)) {
    if (!orderedKeys.includes(key)) {
      yamlLines.push(`${key}: ${formatYamlValue(value)}`);
    }
  }

  return `---\n${yamlLines.join('\n')}\n---\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Init — call once at startup
// ---------------------------------------------------------------------------

export function initSkillEngine(): void {
  scanSkillsDir();
  startWatcher();
  logger.info('Skill engine initialized');
}
