# Lessons Learned

Rules and patterns discovered during development.
Agents read this at the start of each session.

## Codebase Conventions
- Import paths use `.js` extensions (ESM): `import { foo } from "./bar.js"`
- Test framework: `bun:test` with `describe/it/expect`
- `parseHar()` ALWAYS needs `seedUrl` parameter for correct service name
- Set-Cookie headers must NOT be split on commas (date values contain commas)
- Auth header detection uses pattern matching, not exact names
- Mastra routes on backend are at root level (not /api/*)

## Testing Rules
- No mocking the code under test — ever
- Use test builders from `src/__tests__/helpers.ts`
- Tests run with `bun test` (currently 611 tests, 0 failures)
- Both `bun test` and `npx tsc --noEmit` must pass before completing any task

## Known Bugs
- generateVersionHash() produces identical hashes (Object.keys as replacer)

## Mistakes to Avoid
- Adding new Drizzle columns without making them nullable (breaks all queries pre-migration)
- Logging auth tokens at info level (security risk — use debug)
- Forgetting to wrap new DB table operations in try/catch for backward compatibility
