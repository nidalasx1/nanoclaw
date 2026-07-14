# Integration Patches for Skill Engine

This document describes exactly what needs to change in existing files to integrate the skill engine (`src/skill-ipc.ts`, `src/skill-engine.ts`, `src/skill-tracker.ts`, `src/memory-nudge.ts`, `src/skill-validator.ts`) into the NanoClaw core.

---

## 1. `src/container-runner.ts` — Add Skill Mounts & Prompt Injection

### Patch 1a: Import skill-ipc

**Location:** Top of file, after existing imports (line ~29)

**Context:**
```typescript
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
```

**Add after:**
```typescript
import { getSkillMounts, buildSkillSystemPrompt } from './skill-ipc.js';
```

**Why:** The container runner needs access to skill mount generation and system prompt injection.

---

### Patch 1b: Add skill mounts in `buildVolumeMounts()`

**Location:** `buildVolumeMounts()` function, after the `additionalMounts` block (line ~239), just before `return mounts;`

**Context (line ~232-242):**
```typescript
  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
```

**Add between the `additionalMounts` block and `return mounts;`:**
```typescript
  // Skill engine mounts: skills directory (ro), MEMORY.md (rw), SKILLS_INDEX.md (ro)
  try {
    const skillMounts = getSkillMounts(group.folder);
    mounts.push(...skillMounts);
  } catch (err) {
    logger.warn(
      { group: group.name, err },
      'Failed to compute skill mounts, skipping',
    );
  }
```

**Why:** Every container needs the skill files mounted so agents can read skill definitions and update their memory.

---

### Patch 1c: Add `ContainerInput.skillPrompt` field

**Location:** `ContainerInput` interface definition (line ~37-46)

**Context:**
```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}
```

**Add new optional field:**
```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  skillPrompt?: string; // Injected skill index + memory context
}
```

**Why:** The container's agent-runner needs the skill system prompt to prepend to the agent's context.

---

### Patch 1d: Inject skill prompt when building container input

**Location:** `runContainerAgent()` function, just before `container.stdin.write(JSON.stringify(input))` (line ~358)

**Context (line ~346-359):**
```typescript
  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
```

**Change `container.stdin.write(JSON.stringify(input));` to:**
```typescript
    // Inject skill system prompt into the container input
    const enrichedInput = {
      ...input,
      skillPrompt: buildSkillSystemPrompt(input.groupFolder),
    };
    container.stdin.write(JSON.stringify(enrichedInput));
```

**Why:** The skill system prompt (skill index + memory) is computed on the host and sent to the container alongside the user prompt. The agent-runner inside the container will prepend it to the agent's system prompt.

---

## 2. `src/index.ts` — Init Skill System on Startup

### Patch 2a: Import skill modules

**Location:** Top of file, after existing imports (line ~67)

**Context:**
```typescript
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
```

**Add after:**
```typescript
import { rebuildSkillsIndex } from './skill-ipc.js';
```

**Why:** Skill indexes need to be built at startup so containers always have an up-to-date SKILLS_INDEX.md.

---

### Patch 2b: Rebuild skill indexes on startup

**Location:** `main()` function, after `loadState()` (line ~575) and the OneCLI agent loop (line ~581)

**Context (line ~573-582):**
```typescript
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }
```

**Add after the OneCLI agent loop:**
```typescript
  // Rebuild skill indexes for all registered groups
  for (const group of Object.values(registeredGroups)) {
    try {
      rebuildSkillsIndex(group.folder);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to rebuild skills index on startup',
      );
    }
  }
  logger.info('Skill indexes rebuilt');
```

**Why:** On startup, ensure every group has an up-to-date SKILLS_INDEX.md. This handles the case where skills were added while the process was down, or after a code update.

---

### Patch 2c: Rebuild skill index on group registration

**Location:** `registerGroup()` function (line ~146-190), after the CLAUDE.md template copy and OneCLI agent ensure

**Context (line ~183-190):**
```typescript
  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
```

**Add before the logger.info:**
```typescript
  // Build initial skills index for this group
  try {
    rebuildSkillsIndex(group.folder);
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      'Failed to build initial skills index',
    );
  }
```

**Why:** New groups need a SKILLS_INDEX.md from the start so their first agent invocation has access to skill definitions.

---

## 3. `src/ipc.ts` — Register Skill IPC Message Types

### Patch 3a: Import skill IPC handler

**Location:** Top of file, after existing imports (line ~11)

**Context:**
```typescript
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
```

**Add after:**
```typescript
import { processSkillIpc, SkillIpcMessage } from './skill-ipc.js';
```

**Why:** The IPC watcher needs to recognize and route skill-related messages to the skill IPC handler.

---

### Patch 3b: Add skill IPC directory processing in `processIpcFiles()`

**Location:** Inside the `for (const sourceGroup of groupFolders)` loop in `processIpcFiles()`, after the tasks processing block (line ~147, after the tasks try/catch), before the closing of the for loop.

**Context (line ~119-148):**
```typescript
      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          // ... task processing ...
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }  // <-- end of for loop
```

**Add before the closing of the for loop (after the tasks block):**
```typescript
      // Process skill IPC commands from this group's IPC directory
      const skillsDir = path.join(ipcBaseDir, sourceGroup, 'skills');
      try {
        if (fs.existsSync(skillsDir)) {
          const skillFiles = fs
            .readdirSync(skillsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of skillFiles) {
            const filePath = path.join(skillsDir, file);
            try {
              const data = JSON.parse(
                fs.readFileSync(filePath, 'utf-8'),
              ) as SkillIpcMessage;
              await processSkillIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing skill IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC skills directory',
        );
      }
```

**Why:** Containers write skill IPC commands (skill:create, skill:update, skill:search, memory:update) as JSON files in `data/ipc/<group>/skills/`. The IPC watcher needs to scan this directory and route messages to `processSkillIpc()`.

---

### Patch 3c: Create skills IPC directory in `container-runner.ts`

**Location:** In `buildVolumeMounts()`, where IPC subdirectories are created (line ~190-192)

**Context:**
```typescript
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
```

**Add after the existing mkdirSync calls:**
```typescript
  fs.mkdirSync(path.join(groupIpcDir, 'skills'), { recursive: true });
```

**Why:** The skills IPC directory must exist before the container starts writing to it. This follows the same pattern as messages, tasks, and input directories.

---

## 4. `src/db.ts` — New Tables for Skill Tracking

### Patch 4a: Add skill_tracking table

**Location:** `createSchema()` function, after the existing table definitions (line ~84, after the registered_groups table)

**Context (line ~76-85):**
```typescript
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);
```

**Add a new `database.exec()` block after the main schema block:**
```typescript
  // Skill engine tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS skill_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      context TEXT,
      UNIQUE(group_folder, skill_name, triggered_at)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_tracking_group
      ON skill_tracking(group_folder, triggered_at);
    CREATE INDEX IF NOT EXISTS idx_skill_tracking_name
      ON skill_tracking(skill_name, triggered_at);
  `);
```

**Why:** The `skill_tracking` table records when skills are triggered (by tool calls, keywords, or explicit invocation). This enables the skill engine to track usage patterns and optimize skill recommendations. Fields:
- `group_folder`: Which group triggered the skill
- `skill_name`: The skill that was triggered
- `trigger_type`: How it was triggered (`tool_call`, `keyword`, `explicit`, `auto`)
- `triggered_at`: ISO timestamp
- `context`: Optional JSON blob with additional context (tool name, matched keyword, etc.)

---

### Patch 4b: Add session_search FTS5 virtual table

**Location:** Same area, after the skill_tracking table creation

**Add after the skill_tracking block:**
```typescript
  // Full-text search over session content for skill matching
  // FTS5 virtual table — allows fast text search across agent conversations
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_search
        USING fts5(group_folder, content, timestamp, tokenize='porter');
    `);
  } catch {
    // FTS5 may not be available in all SQLite builds — degrade gracefully
    logger.warn('FTS5 not available, session_search table not created');
  }
```

**Why:** The `session_search` FTS5 table enables full-text search over agent session content. This powers:
- Skill search by natural language query
- Memory nudge system (find relevant past context)
- Usage analytics (what topics come up frequently)

FTS5 uses Porter stemming so "running" matches "run", "runs", etc. The table is wrapped in try/catch because FTS5 is a compile-time SQLite extension that may not be available in all environments.

---

### Patch 4c: Add helper functions for skill tracking

**Location:** After the existing `logTaskRun()` function (line ~548)

**Add new exported functions:**
```typescript
// --- Skill tracking accessors ---

export function trackSkillTrigger(
  groupFolder: string,
  skillName: string,
  triggerType: string,
  context?: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO skill_tracking (group_folder, skill_name, trigger_type, triggered_at, context)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(groupFolder, skillName, triggerType, new Date().toISOString(), context || null);
}

export function getSkillUsage(
  groupFolder: string,
  since?: string,
): Array<{ skill_name: string; count: number; last_used: string }> {
  const sinceTs = since || '1970-01-01T00:00:00.000Z';
  return db
    .prepare(
      `SELECT skill_name, COUNT(*) as count, MAX(triggered_at) as last_used
       FROM skill_tracking
       WHERE group_folder = ? AND triggered_at > ?
       GROUP BY skill_name
       ORDER BY count DESC`,
    )
    .all(groupFolder, sinceTs) as Array<{
    skill_name: string;
    count: number;
    last_used: string;
  }>;
}

export function indexSessionContent(
  groupFolder: string,
  content: string,
): void {
  try {
    db.prepare(
      `INSERT INTO session_search (group_folder, content, timestamp) VALUES (?, ?, ?)`,
    ).run(groupFolder, content, new Date().toISOString());
  } catch {
    // FTS5 table may not exist — degrade gracefully
  }
}

export function searchSessionContent(
  query: string,
  groupFolder?: string,
  limit: number = 10,
): Array<{ group_folder: string; content: string; timestamp: string }> {
  try {
    if (groupFolder) {
      return db
        .prepare(
          `SELECT group_folder, content, timestamp FROM session_search
           WHERE session_search MATCH ? AND group_folder = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(query, groupFolder, limit) as Array<{
        group_folder: string;
        content: string;
        timestamp: string;
      }>;
    }
    return db
      .prepare(
        `SELECT group_folder, content, timestamp FROM session_search
         WHERE session_search MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Array<{
      group_folder: string;
      content: string;
      timestamp: string;
    }>;
  } catch {
    // FTS5 not available
    return [];
  }
}
```

**Why:** These functions provide the interface for other skill engine modules:
- `trackSkillTrigger()` — called by `skill-tracker.ts` when a skill is triggered
- `getSkillUsage()` — used by `memory-nudge.ts` to find frequently-used skills
- `indexSessionContent()` — called after agent responses to build the FTS index
- `searchSessionContent()` — used by `skill-ipc.ts` for skill:search and by the memory nudge system

---

## Summary of All Changed Files

| File | Changes | New Imports |
|------|---------|-------------|
| `src/container-runner.ts` | Add skill mounts, inject skill prompt, create skills IPC dir, extend `ContainerInput` | `skill-ipc.js` |
| `src/index.ts` | Rebuild skill indexes on startup and group registration | `skill-ipc.js` |
| `src/ipc.ts` | Add skill IPC directory scanning and routing | `skill-ipc.js` |
| `src/db.ts` | Add `skill_tracking` table, `session_search` FTS5 table, 4 new accessor functions | (none — self-contained) |

## New Files Created

| File | Purpose |
|------|---------|
| `src/skill-ipc.ts` | Skill mounts, IPC command handlers, system prompt builder, index builder |
| `src/skill-engine.ts` | Core skill engine (created by Agent 1) |
| `src/skill-tracker.ts` | Tool call tracking and auto-skill triggers (created by Agent 2) |
| `src/memory-nudge.ts` | Memory persistence and nudge system (created by Agent 3) |
| `src/skill-validator.ts` | Security hardening and validation (created by Agent 5) |
