# Skill Engine Security Specification

## Overview

The skill engine extends NanoClaw's container agents with loadable capabilities (skills). Skills are **markdown-only instruction files** — they contain no executable code. The host validates all skill operations before they take effect.

This document covers the security boundaries for skills, memory, and IPC.

---

## 1. Skill Sandboxing

### Principle: Skills Are Data, Not Code

Skills are `.md` files read into the agent's context window. They cannot:
- Execute shell commands directly
- Import or require modules
- Modify host filesystem
- Access credentials or environment variables

The agent *interprets* skill instructions, but the host controls what the agent can actually do (via container mounts, IPC authorization, and OneCLI credential proxying).

### Mount Rules

| Path | Access | What |
|------|--------|------|
| `/workspace/skills/` | Read-only | Global skills directory |
| `/workspace/group/` | Read-write | Group-specific memory and config |
| `/workspace/project/` | Read-only | Project root (main group only) |

Skills are mounted **read-only** into all containers. The agent cannot modify skill files. Skill creation and updates happen exclusively through IPC, validated by the host.

### Host Validates Before Writing

When an agent proposes a new skill or skill update via IPC:
1. Host receives the IPC message
2. `validateSkillContent()` checks for violations (see Section 2)
3. Only if validation passes does the host write the file
4. The agent never writes skill files directly

---

## 2. Skill Validation Rules

All skill content is validated by `src/skill-validator.ts` before being written to disk.

### Content Restrictions

| Rule | Limit | Rationale |
|------|-------|-----------|
| Max file size | 10 KB | Prevents context window bloat |
| No credential references | Regex-detected | Prevents secret leakage into shared files |
| No shell escape patterns | Pattern-matched | Skills are instructions, not scripts |
| Must be valid Markdown | Structure check | Ensures parseable content |

### Credential Detection

The validator rejects content containing patterns that match:
- API keys: `sk-`, `pk_`, `key-`, `api_key`, `apikey`
- AWS keys: `AKIA`, `aws_secret_access_key`, `aws_access_key_id`
- Tokens: `Bearer `, `token=`, `access_token`, `refresh_token`
- Passwords: `password=`, `passwd=`, `secret=`
- Generic secrets: base64-encoded strings that look like keys (40+ chars of `[A-Za-z0-9+/=]`)
- URLs with embedded credentials: `://user:pass@`

### Shell Escape Detection

Skills must not contain patterns that look like executable injections:
- Backtick command substitution: `` `command` ``
- `$(command)` substitution
- Pipe chains designed to exfiltrate: `| curl`, `| wget`, `| nc`
- Direct credential file references: `~/.ssh/`, `~/.aws/`, `~/.env`

### Rate Limiting (Specification)

Skill creation is rate-limited to prevent abuse:
- **3 skill proposals per hour per group**
- Main group is exempt from rate limits
- Rate limit state tracked in memory (not persisted)

---

## 3. Memory Security

Each group has a `MEMORY.md` file for persistent context across sessions.

### Constraints

| Rule | Limit | Rationale |
|------|-------|-----------|
| Max memory size | 50 KB | Prevents unbounded growth |
| No credentials | Same regex as skills | Prevents secret persistence |
| Backup before compaction | Host creates `.bak` | Recovery from bad compaction |

### Memory Update Flow

1. Agent writes updated memory content to IPC
2. Host runs `validateMemoryContent()` — strips any detected credentials
3. Host checks size limit — truncates with warning if exceeded
4. Host backs up existing `MEMORY.md` to `MEMORY.md.bak`
5. Host writes sanitized content

### Isolation

- Each group's memory is isolated to its own directory
- Groups cannot read other groups' memory files
- The global `MEMORY.md` (project root) is read-only for all groups
- Memory files are never shared between containers

---

## 4. IPC Security

All agent-to-host communication goes through the IPC file-based protocol. The host is the sole authority.

### Message Validation

Every IPC message is validated by `validateIPCMessage()`:

1. **Type check** — message `type` must be in the known set
2. **Payload schema** — each type has required and optional fields
3. **Credential stripping** — all string values in the payload are scanned for credential patterns; matches are replaced with `[REDACTED]`
4. **Size limit** — total serialized payload must not exceed 100 KB
5. **Source identity** — determined by IPC directory path (cannot be spoofed by agent)

### Known IPC Types

| Type | Required Fields | Authorization |
|------|----------------|---------------|
| `message` | `chatJid`, `text` | Main: any chat. Others: own chat only |
| `schedule_task` | `prompt`, `schedule_type`, `schedule_value`, `targetJid` | Main: any target. Others: self only |
| `pause_task` | `taskId` | Main: any. Others: own tasks only |
| `resume_task` | `taskId` | Main: any. Others: own tasks only |
| `cancel_task` | `taskId` | Main: any. Others: own tasks only |
| `update_task` | `taskId` | Main: any. Others: own tasks only |
| `refresh_groups` | — | Main only |
| `register_group` | `jid`, `name`, `folder`, `trigger` | Main only |
| `propose_skill` | `name`, `content` | Any (rate-limited) |
| `update_memory` | `content` | Any (own group only) |
| `search_sessions` | `query` | Any (own group only) |

### Defense in Depth

- Agents cannot set `isMain` via IPC (host preserves existing value)
- Invalid IPC files are moved to `data/ipc/errors/` for forensic review
- All validation failures are logged with full context

---

## 5. Group Isolation

### Skills: Global Read-Only

Skills are stored in a single directory and mounted read-only into all containers. This means:
- All groups see the same skills
- No group can modify skills at runtime
- Skill updates go through host validation

### Memory: Per-Group Isolated

Each group's writable state is confined to its own directory:
```
groups/
├── main-group/
│   ├── CLAUDE.md          # Group-specific instructions
│   └── MEMORY.md          # Group-specific memory
├── sales-team/
│   ├── CLAUDE.md
│   └── MEMORY.md
└── support/
    ├── CLAUDE.md
    └── MEMORY.md
```

No container can access another group's directory. The mount configuration enforces this — each container only receives its own group folder as a writable mount.

### Session Search: Per-Group Scoped

When an agent searches past sessions, results are scoped to that group's session data only (`data/sessions/{group}/`). Cross-group session access is architecturally impossible because:
1. Session directories are mounted per-group
2. The search tool operates on the mounted path
3. No mount path exposes other groups' sessions

---

## Threat Model Summary

| Threat | Mitigation |
|--------|------------|
| Skill contains credentials | Credential regex detection in validator |
| Skill contains shell injection | Shell escape pattern detection |
| Agent modifies skill files directly | Skills mounted read-only |
| Agent escalates to main group | `isMain` cannot be set via IPC |
| Memory grows unbounded | 50 KB limit enforced by host |
| Cross-group data leakage | Per-group mount isolation |
| IPC message spoofing | Identity from directory path, not message content |
| Credential exfiltration via IPC | All IPC payloads scanned and stripped |
| Skill spam / abuse | Rate limit: 3/hr/group |
