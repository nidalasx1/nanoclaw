# Wiki Maintenance — Nidalas Operations

You maintain a persistent knowledge wiki. This is not RAG. You build and maintain structured, interlinked markdown pages that compound over time.

## Layout

```
sources/          # Raw files. Read-only. Never modify.
wiki/             # Your pages. You own everything here.
wiki/index.md     # Master catalog — update on every change.
wiki/log.md       # Append-only activity log.
```

## Operations

### Ingest

When Chris sends a source (URL, PDF, image, voice note, text):

1. Save raw source to `sources/` (download URLs with `curl -sLo sources/filename.ext "URL"`)
2. Read the source fully. For URLs, use bash curl to get full content, not WebFetch (which summarizes)
3. Discuss key takeaways with Chris
4. Create or update wiki pages:
   - **Summary page**: `wiki/summaries/SOURCE_NAME.md` — full summary with key points
   - **Entity pages**: `wiki/entities/ENTITY_NAME.md` — one per person, company, product, system
   - **Concept pages**: `wiki/concepts/CONCEPT.md` — one per idea, technique, pattern
   - Cross-reference between pages using `[[page-name]]` links
   - Flag contradictions with existing wiki content
5. Update `wiki/index.md` — add new pages with one-line descriptions
6. Append to `wiki/log.md` — `## [DATE] ingest | SOURCE_TITLE`

**CRITICAL: Process sources one at a time.** Read one file, discuss it, create/update all wiki pages for it, finish completely, then move to the next. Never batch-read multiple files and process them together.

### Query

When Chris asks a question:

1. Read `wiki/index.md` first to find relevant pages
2. Read those pages
3. Synthesize an answer with citations to wiki pages
4. If the answer is substantial, offer to save it as a new wiki page

### Lint

Health-check the wiki:

- Contradictions between pages
- Orphan pages (no inbound links)
- Stale content superseded by newer sources
- Important entities mentioned but lacking dedicated pages
- Missing cross-references
- Data gaps worth investigating

Report findings and offer fixes.

## Page Format

Every wiki page starts with YAML frontmatter:

```yaml
---
title: Page Title
type: entity | concept | summary | comparison | exploration
created: 2026-04-10
updated: 2026-04-10
sources: [source-filename.md]
related: [other-page, another-page]
---
```

## Categories

Organize pages under these wiki subdirectories:
- `wiki/summaries/` — source summaries
- `wiki/entities/` — people, companies, products, systems
- `wiki/concepts/` — ideas, patterns, techniques
- `wiki/comparisons/` — side-by-side analysis
- `wiki/explorations/` — deep dives, research findings

## Conventions

- Filenames: lowercase, hyphens, no spaces (`nidalas-print.md`)
- Cross-references: `[[page-name]]` syntax
- Dates: ISO 8601 (`2026-04-10`)
- When updating an existing page, update the `updated` field in frontmatter
- Keep pages focused. Split long pages into linked sub-pages.
