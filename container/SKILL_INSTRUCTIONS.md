# Skills & Memory — Agent Instructions

You have access to a skill system that extends your capabilities. Skills are instruction files that teach you how to perform specific tasks.

## Checking Available Skills

Read the file at `/workspace/skills/SKILLS_INDEX.md` to see all available skills. The index lists each skill's name, description, and when to use it.

```
cat /workspace/skills/SKILLS_INDEX.md
```

## Loading a Skill

To use a skill, read its full file:

```
cat /workspace/skills/{skill-name}.md
```

Follow the instructions in the skill file. Skills may include step-by-step workflows, templates, or decision trees.

## Proposing a New Skill

If you discover a repeatable workflow that would be useful across sessions, you can propose it as a new skill. Write a JSON file to your IPC directory:

```json
{
  "type": "propose_skill",
  "name": "skill-name",
  "content": "# Skill Title\n\nSkill instructions in Markdown..."
}
```

Write this to: `/workspace/ipc/messages/{timestamp}-propose-skill.json`

The host will validate your proposal. Skills must be:
- Pure Markdown (no executable code)
- Under 10 KB
- Free of credentials or secrets
- Free of shell escape patterns

You are rate-limited to 3 skill proposals per hour.

## Updating Memory

Your group has a persistent `MEMORY.md` file at `/workspace/group/MEMORY.md`. To request an update, write an IPC message:

```json
{
  "type": "update_memory",
  "content": "# Memory\n\nUpdated memory content..."
}
```

Write this to: `/workspace/ipc/messages/{timestamp}-update-memory.json`

The host will validate and write the update. Memory is limited to 50 KB.

### What to put in memory:
- Key decisions and their rationale
- User preferences discovered during conversations
- Important context that should persist across sessions
- Recurring patterns and workflows

### What NOT to put in memory:
- API keys, tokens, passwords, or any credentials
- Session-specific temporary state
- Large data dumps or logs
- Information that duplicates skill content

## Searching Past Sessions

To search your group's conversation history, write an IPC message:

```json
{
  "type": "search_sessions",
  "query": "your search terms"
}
```

Write this to: `/workspace/ipc/messages/{timestamp}-search-sessions.json`

Results are scoped to your group only — you cannot search other groups' sessions.

## What NOT to Put in Skills or Memory

Never include any of the following in skill proposals or memory updates. The host will reject content containing:

- **API keys** — `sk-...`, `pk_...`, `AKIA...`, any key-like strings
- **Tokens** — `Bearer ...`, access tokens, refresh tokens, OAuth tokens
- **Passwords** — plaintext passwords, password hashes, connection strings with credentials
- **Secret references** — paths to `.ssh/`, `.aws/`, `.env`, credential files
- **Shell injections** — backtick commands, `$(...)` substitutions, pipe chains to network tools

The host automatically scans all content for these patterns. Violations are logged and the request is rejected.

## Important Constraints

- Skills are **read-only** — you cannot modify skill files directly
- Memory is **per-group** — you only see your own group's memory
- IPC is **validated** — all messages are checked before processing
- Credentials are **never in your environment** — API calls go through the OneCLI proxy
