/**
 * Skill IPC Bridge
 *
 * Handles skill-related container mounts, IPC commands from containers,
 * and system prompt injection for the skill engine.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/** Payload shapes for skill IPC commands written by containers */
export interface SkillCreatePayload {
  category: string;
  name: string;
  content: string;
}

export interface SkillUpdatePayload {
  name: string;
  content: string;
}

export interface SkillSearchPayload {
  query: string;
  limit?: number;
}

export interface MemoryUpdatePayload {
  content: string;
}

export type SkillIpcMessage =
  | { type: 'skill:create'; payload: SkillCreatePayload }
  | { type: 'skill:update'; payload: SkillUpdatePayload }
  | { type: 'skill:search'; payload: SkillSearchPayload }
  | { type: 'memory:update'; payload: MemoryUpdatePayload };

// ---------------------------------------------------------------------------
// 1. Skill Mounts — extra volume mounts for skill files
// ---------------------------------------------------------------------------

/**
 * Return additional VolumeMount[] that expose skills and memory files
 * into the container for a given group.
 *
 * - `skills/` directory (project-root) → /workspace/skills (read-only)
 * - `groups/<groupId>/MEMORY.md`       → /workspace/group/MEMORY.md (read-write)
 * - `groups/<groupId>/SKILLS_INDEX.md` → /workspace/group/SKILLS_INDEX.md (read-only)
 */
export function getSkillMounts(groupId: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Mount the shared skills directory read-only so agents can read skill definitions
  const skillsDir = path.join(projectRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    mounts.push({
      hostPath: skillsDir,
      containerPath: '/workspace/skills',
      readonly: true,
    });
  }

  // Mount per-group MEMORY.md read-write so agents can update their memory
  const groupDir = resolveGroupFolderPath(groupId);
  const memoryFile = path.join(groupDir, 'MEMORY.md');
  // Ensure the file exists so we can mount it (Docker requires the host path to exist)
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, '');
  }
  mounts.push({
    hostPath: memoryFile,
    containerPath: '/workspace/group/MEMORY.md',
    readonly: false,
  });

  // Mount per-group SKILLS_INDEX.md read-only so agents know what skills are available
  const skillsIndexFile = path.join(groupDir, 'SKILLS_INDEX.md');
  if (fs.existsSync(skillsIndexFile)) {
    mounts.push({
      hostPath: skillsIndexFile,
      containerPath: '/workspace/group/SKILLS_INDEX.md',
      readonly: true,
    });
  }

  return mounts;
}

// ---------------------------------------------------------------------------
// 2. IPC Command Handlers — process skill: and memory: IPC messages
// ---------------------------------------------------------------------------

/**
 * Process a skill-related IPC message from a container.
 *
 * @param data       Parsed JSON from the IPC file
 * @param groupId    Source group folder (verified from IPC directory name)
 * @param isMain     Whether the source group is the main group
 */
export async function processSkillIpc(
  data: SkillIpcMessage,
  groupId: string,
  isMain: boolean,
): Promise<void> {
  switch (data.type) {
    case 'skill:create':
      handleSkillCreate(data.payload, groupId, isMain);
      break;
    case 'skill:update':
      handleSkillUpdate(data.payload, groupId, isMain);
      break;
    case 'skill:search':
      handleSkillSearch(data.payload, groupId);
      break;
    case 'memory:update':
      handleMemoryUpdate(data.payload, groupId);
      break;
    default:
      logger.warn(
        { type: (data as { type: string }).type, groupId },
        'Unknown skill IPC type',
      );
  }
}

function handleSkillCreate(
  payload: SkillCreatePayload,
  groupId: string,
  isMain: boolean,
): void {
  // Validate inputs
  if (!payload.category || !payload.name || !payload.content) {
    logger.warn({ groupId }, 'skill:create missing required fields');
    return;
  }

  // Sanitize category and name to prevent path traversal
  const category = sanitizeName(payload.category);
  const name = sanitizeName(payload.name);
  if (!category || !name) {
    logger.warn(
      { groupId, category: payload.category, name: payload.name },
      'skill:create invalid category or name',
    );
    return;
  }

  // Non-main groups can only create skills in their own namespace
  const skillsDir = isMain
    ? path.join(process.cwd(), 'skills', category)
    : path.join(resolveGroupFolderPath(groupId), 'skills', category);

  fs.mkdirSync(skillsDir, { recursive: true });
  const skillFile = path.join(skillsDir, `${name}.md`);
  fs.writeFileSync(skillFile, payload.content);

  logger.info(
    { groupId, category, name, isMain, path: skillFile },
    'Skill created via IPC',
  );

  // Rebuild the skills index for this group
  rebuildSkillsIndex(groupId);
}

function handleSkillUpdate(
  payload: SkillUpdatePayload,
  groupId: string,
  isMain: boolean,
): void {
  if (!payload.name || !payload.content) {
    logger.warn({ groupId }, 'skill:update missing required fields');
    return;
  }

  const name = sanitizeName(payload.name);
  if (!name) {
    logger.warn({ groupId, name: payload.name }, 'skill:update invalid name');
    return;
  }

  // Search for the skill file in global skills first, then group-local
  const globalPath = findSkillFile(path.join(process.cwd(), 'skills'), name);
  const groupPath = findSkillFile(
    path.join(resolveGroupFolderPath(groupId), 'skills'),
    name,
  );

  // Non-main can only update group-local skills
  const targetPath = isMain
    ? globalPath || groupPath
    : groupPath;

  if (!targetPath) {
    logger.warn(
      { groupId, name, isMain },
      'skill:update skill not found',
    );
    return;
  }

  fs.writeFileSync(targetPath, payload.content);
  logger.info({ groupId, name, path: targetPath }, 'Skill updated via IPC');

  rebuildSkillsIndex(groupId);
}

function handleSkillSearch(
  payload: SkillSearchPayload,
  groupId: string,
): void {
  if (!payload.query) {
    logger.warn({ groupId }, 'skill:search missing query');
    return;
  }

  const limit = Math.min(payload.limit || 10, 50);
  const query = payload.query.toLowerCase();

  // Collect skills from global and group-local directories
  const results: Array<{ name: string; category: string; path: string }> = [];

  const globalSkillsDir = path.join(process.cwd(), 'skills');
  collectMatchingSkills(globalSkillsDir, query, results);

  const groupSkillsDir = path.join(
    resolveGroupFolderPath(groupId),
    'skills',
  );
  collectMatchingSkills(groupSkillsDir, query, results);

  // Write search results to the group's IPC input directory for the container to read
  const ipcInputDir = path.join(DATA_DIR, 'ipc', groupId, 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });
  const resultFile = path.join(
    ipcInputDir,
    `skill-search-${Date.now()}.json`,
  );
  fs.writeFileSync(
    resultFile,
    JSON.stringify({ type: 'skill:search_result', results: results.slice(0, limit) }),
  );

  logger.info(
    { groupId, query, resultCount: Math.min(results.length, limit) },
    'Skill search completed via IPC',
  );
}

function handleMemoryUpdate(
  payload: MemoryUpdatePayload,
  groupId: string,
): void {
  if (payload.content === undefined || payload.content === null) {
    logger.warn({ groupId }, 'memory:update missing content');
    return;
  }

  const groupDir = resolveGroupFolderPath(groupId);
  const memoryFile = path.join(groupDir, 'MEMORY.md');
  fs.writeFileSync(memoryFile, payload.content);

  logger.info(
    { groupId, size: payload.content.length },
    'Memory updated via IPC',
  );
}

// ---------------------------------------------------------------------------
// 3. System Prompt Injection
// ---------------------------------------------------------------------------

/**
 * Build additional system prompt content that injects skill index and memory
 * context for a group's agent.
 *
 * Returns an empty string if neither file exists.
 */
export function buildSkillSystemPrompt(groupId: string): string {
  const groupDir = resolveGroupFolderPath(groupId);
  const sections: string[] = [];

  // Skill index
  const skillsIndexFile = path.join(groupDir, 'SKILLS_INDEX.md');
  if (fs.existsSync(skillsIndexFile)) {
    const content = fs.readFileSync(skillsIndexFile, 'utf-8').trim();
    if (content) {
      sections.push(
        '<skills-index>',
        content,
        '</skills-index>',
      );
    }
  }

  // Group memory
  const memoryFile = path.join(groupDir, 'MEMORY.md');
  if (fs.existsSync(memoryFile)) {
    const content = fs.readFileSync(memoryFile, 'utf-8').trim();
    if (content) {
      sections.push(
        '<group-memory>',
        content,
        '</group-memory>',
      );
    }
  }

  return sections.length > 0 ? '\n\n' + sections.join('\n') : '';
}

// ---------------------------------------------------------------------------
// 4. Skills Index Builder
// ---------------------------------------------------------------------------

/**
 * Rebuild the SKILLS_INDEX.md file for a group.
 * Combines global skills + group-local skills into a single index.
 */
export function rebuildSkillsIndex(groupId: string): void {
  const groupDir = resolveGroupFolderPath(groupId);
  const lines: string[] = ['# Available Skills', ''];

  // Global skills
  const globalSkillsDir = path.join(process.cwd(), 'skills');
  if (fs.existsSync(globalSkillsDir)) {
    const categories = listCategories(globalSkillsDir);
    if (categories.length > 0) {
      lines.push('## Global Skills', '');
      for (const cat of categories) {
        lines.push(`### ${cat}`);
        const skills = listSkillsInCategory(globalSkillsDir, cat);
        for (const skill of skills) {
          lines.push(`- ${skill}`);
        }
        lines.push('');
      }
    }
  }

  // Group-local skills
  const groupSkillsDir = path.join(groupDir, 'skills');
  if (fs.existsSync(groupSkillsDir)) {
    const categories = listCategories(groupSkillsDir);
    if (categories.length > 0) {
      lines.push('## Group Skills', '');
      for (const cat of categories) {
        lines.push(`### ${cat}`);
        const skills = listSkillsInCategory(groupSkillsDir, cat);
        for (const skill of skills) {
          lines.push(`- ${skill}`);
        }
        lines.push('');
      }
    }
  }

  const indexFile = path.join(groupDir, 'SKILLS_INDEX.md');
  fs.writeFileSync(indexFile, lines.join('\n'));
  logger.debug({ groupId, indexFile }, 'Skills index rebuilt');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a name to prevent path traversal — alphanumeric, hyphens, underscores only */
function sanitizeName(name: string): string | null {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned || cleaned !== name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '')) {
    // If cleaning changed the name significantly, it may be suspicious
    // Accept the cleaned version only if it's non-empty
    return cleaned || null;
  }
  return cleaned;
}

/** Recursively find a skill file by name (without extension) */
function findSkillFile(baseDir: string, name: string): string | null {
  if (!fs.existsSync(baseDir)) return null;
  try {
    for (const category of fs.readdirSync(baseDir)) {
      const catDir = path.join(baseDir, category);
      if (!fs.statSync(catDir).isDirectory()) continue;
      const skillFile = path.join(catDir, `${name}.md`);
      if (fs.existsSync(skillFile)) return skillFile;
    }
  } catch {
    // Directory read error — ignore
  }
  return null;
}

/** Collect skills matching a query string */
function collectMatchingSkills(
  baseDir: string,
  query: string,
  results: Array<{ name: string; category: string; path: string }>,
): void {
  if (!fs.existsSync(baseDir)) return;
  try {
    for (const category of fs.readdirSync(baseDir)) {
      const catDir = path.join(baseDir, category);
      if (!fs.statSync(catDir).isDirectory()) continue;
      for (const file of fs.readdirSync(catDir)) {
        if (!file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        if (
          name.toLowerCase().includes(query) ||
          category.toLowerCase().includes(query)
        ) {
          results.push({ name, category, path: path.join(catDir, file) });
        }
      }
    }
  } catch {
    // Directory read error — ignore
  }
}

/** List category subdirectories */
function listCategories(baseDir: string): string[] {
  try {
    return fs
      .readdirSync(baseDir)
      .filter((f) => fs.statSync(path.join(baseDir, f)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/** List skill names within a category */
function listSkillsInCategory(baseDir: string, category: string): string[] {
  const catDir = path.join(baseDir, category);
  try {
    return fs
      .readdirSync(catDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}
