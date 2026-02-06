# Unbrowse Agent Orientation

## What is Unbrowse?
Unbrowse reverse-engineers internal APIs from any website by capturing XHR/Fetch traffic during normal browsing sessions. It extracts endpoints, authentication tokens, session cookies, and request patterns, then generates callable skills (SKILL.md + auth.json + api.ts) that AI agents can use to interact with sites programmatically without official API access. It runs as a plugin for OpenClaw.

## Repository Layout
```
unbrowse-openclaw/              # Plugin repo (primary)
├── index.ts                    # Plugin entry point (5,510 lines)
├── src/                        # Core modules (39 files, 17,852 lines)
│   ├── types.ts                # All TypeScript interfaces
│   ├── har-parser.ts           # HAR → parsed requests
│   ├── endpoint-analyzer.ts    # Requests → endpoint groups
│   ├── skill-generator.ts      # Endpoint groups → SKILL.md + api.ts
│   ├── auth-extractor.ts       # Auth token/cookie detection
│   ├── noise-filter.ts         # Filter analytics/third-party noise
│   ├── path-normalizer.ts      # /users/123 → /users/{userId}
│   ├── schema-inferrer.ts      # JSON → schema
│   ├── type-inferrer.ts        # Schema → TypeScript types
│   ├── skill-validator.ts      # Validate endpoints before publish
│   ├── skill-index.ts          # Marketplace client (search, publish, download)
│   └── ...28 more modules
├── src/__tests__/
│   ├── helpers.ts              # Test builders: makeHarEntry, makeParsedRequest, makeApiData
│   ├── harness.ts              # Real OpenClaw integration harness
│   ├── fixtures/               # 4 HAR fixture files
│   ├── unit/                   # 9 unit test files (611 tests total)
│   └── integration/            # 4 integration test files
├── server/web/                 # Frontend (React/Vite, Vercel deploy)
├── tasks/                      # Task backlog and lessons
├── package.json                # bun test, tsc
└── CLAUDE.md                   # Project instructions
```

## Data Flow
```
HAR file or CDP capture
  → parseHar(har, seedUrl) [har-parser.ts]
  → enrichApiData() [har-parser.ts]
  → analyzeEndpoints() [endpoint-analyzer.ts]
  → generateSkill(data, outputDir) [skill-generator.ts]
  → SKILL.md + auth.json + scripts/api.ts
```

## Key Commands
- `bun test` — Run all 611 tests (MUST pass before completing any task)
- `npx tsc --noEmit` — Type check (MUST pass before completing any task)
- `bun test src/__tests__/unit/<name>.test.ts` — Run specific test file
- `bun test --timeout 60000` — Run with extended timeout for integration tests

## Conventions
- ESM imports with `.js` extensions: `import { foo } from "./bar.js"`
- Test framework: `bun:test` with `describe/it/expect`
- File naming: kebab-case (e.g., `skill-generator.ts`)
- Function naming: camelCase
- Type/interface naming: PascalCase
- Test files: `src/__tests__/unit/<module>.test.ts` or `src/__tests__/integration/<name>.test.ts`
- Test builders available in `src/__tests__/helpers.ts`: makeHarEntry, makeParsedRequest, makeApiData, makeEndpointGroup

## Known Issues
- `generateVersionHash()` in skill-generator.ts produces identical hashes for all inputs
  (Object.keys passed as JSON.stringify replacer — documented in test)
- 29 source files have no test coverage (see tasks/todo.md for list)
- index.ts is 5,510 lines and needs decomposition

## Architecture Decisions
- No mocking in tests — use real code with real data
- HAR fixtures stored as JSON files in src/__tests__/fixtures/
- Auth detection uses heuristic pattern matching, not exact header names
- `parseHar()` should ALWAYS receive `seedUrl` parameter for correct service name
- Set-Cookie headers must NOT be split on commas (date values contain commas)
- Mastra routes on backend are at root level (not /api/*)
- Plugin builds with `npx tsc`, deployed via `npm publish`
- Backend at /Users/lekt9/Projects/unbrowseys/reverse-engineer/ (separate repo)

## Agent Workflow Loop
1. Read this file and tasks/lessons.md for orientation
2. Call TaskList to find unclaimed, unblocked tasks matching your role
3. Claim task via TaskUpdate(taskId, owner: "your-name", status: "in_progress")
4. Work the task: implement, test, verify
5. Run `bun test` and `npx tsc --noEmit` — both MUST pass
6. Mark complete: TaskUpdate(taskId, status: "completed")
7. If issues found during work, create new tasks with TaskCreate
8. Loop back to step 2
