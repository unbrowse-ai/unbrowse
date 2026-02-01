# Agent Skills Specification (agentskills.io)

**Stored:** 2026-02-01
**Context:** Standard for generating skills in unbrowse extension
**Tags:** agent-skills, skill-generation, specification, agentskills.io

## Overview

A skill is a directory containing a SKILL.md file with YAML frontmatter and Markdown instructions. This is the open standard used by Claude Code, Cursor, VS Code Copilot, Gemini CLI, and other AI agent products.

## Directory Structure

```
skill-name/
├── SKILL.md          # Required: instructions + metadata
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

## SKILL.md Format

```yaml
---
name: skill-name          # Required: 1-64 chars, lowercase, hyphens only
description: What it does and when to use it  # Required: 1-1024 chars
license: Apache-2.0       # Optional
compatibility: Requires git, docker  # Optional: 1-500 chars
metadata:                 # Optional: arbitrary key-value
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read  # Optional: pre-approved tools (experimental)
---

# Skill Instructions (Markdown body)
...
```

## Name Field Rules

- 1-64 characters
- Only lowercase alphanumeric and hyphens (a-z, 0-9, -)
- Cannot start/end with hyphen
- No consecutive hyphens (--)
- Must match parent directory name

## Description Best Practice

**Good:** "Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction."

**Bad:** "Helps with PDFs."

## Progressive Disclosure

1. **Metadata (~100 tokens):** name/description loaded at startup
2. **Instructions (<5000 tokens recommended):** full SKILL.md loaded when activated
3. **Resources (as needed):** scripts/references/assets loaded on demand

## Best Practices

- Keep SKILL.md under 500 lines
- Move detailed reference to separate files
- Use relative paths from skill root
- Keep file references one level deep

## Implementation Notes for Unbrowse

When generating skills from captured API traffic:
- Ensure skill names are derived from service names (lowercase, hyphenated)
- Description should explain what the API does AND when to use it
- API client code should go in `scripts/` directory
- Auth configuration should be included but credentials should be referenced securely
- HAR captures and API docs can go in `references/` if needed
- Keep the main SKILL.md focused and concise

## Related Files in Unbrowse

- `src/skill-generator.ts` - Generates skills from captured endpoints
- `src/har-parser.ts` - Parses HAR files to extract API endpoints
- SKILL.md output should follow this specification exactly
