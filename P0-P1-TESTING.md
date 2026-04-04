# P0/P1 Regression Testing

Automated regression testing for closed P0/P1 GitHub issues from unbrowse-ai/unbrowse-dev. Validates that critical fixes are working and prevents regressions.

## Quick Start

```bash
# 1. Analyze all closed P0/P1 issues from GitHub
bun test:p0-p1:analyze

# 2. Run all automated regression tests
bun test:p0-p1

# 3. Run specific test category
bun test:p0-p1:unit           # Unit tests (code logic)
bun test:p0-p1:cli            # CLI tests (unbrowse resolve/execute)
bun test:p0-p1:integration    # Integration test guide (auth, servers)
```

## System Overview

The testing framework:
1. **Fetches closed P0/P1 issues** from unbrowse-ai/unbrowse-dev on GitHub
2. **Analyzes each issue** to extract bug/feature and determine test approach
3. **Classifies by test type** based on what needs to be tested
4. **Runs regression tests** one by one via the local unbrowse CLI
5. **Tracks results** in JSON for trend analysis and CI/CD

All with **zero external dependencies** — kuri is already bundled into the CLI.

## Test Categories

### `unit_testable`
Tests code logic directly via `bun:test`:
- Schema merging (no silent field drops)
- Path template mining (correct variable extraction)
- Endpoint deduplication (merging richer metadata)
- URL parsing, validation, filtering

Example: `assert(mergeEndpoints(ep1, ep2).properties.includes(ep1.properties[0]))`

### `cli_testable`
Tests unbrowse CLI commands:
- `unbrowse resolve --intent "..." --url "..." --force-capture`
- `unbrowse execute --skill "..." --endpoint "..."`
- `unbrowse health` and `unbrowse login`

These test the full CLI pipeline without requiring live servers.

### `integration_testable`
## Kuri Integration

**Kuri is already bundled** into the unbrowse CLI — no external installation required.

Location: `packages/skill/vendor/kuri/`

Build process:
1. On pack: `scripts/build-kuri-binaries.mjs` compiles from `submodules/kuri/`
2. Binaries vendored for macOS arm64/x64, Linux arm64/x64
3. Shipped with npm package in `vendor/kuri/`

The CLI works out of the box with zero external dependencies.

## Implementation Details

### Analysis Script (`scripts/analyze-p0-p1-issues.ts`)

Fetches closed issues via GitHub API, extracts:
- **Bug/Feature Summary** — from "What happened" or "Scope" sections
- **Test Category** — heuristic classification based on title/body keywords
- **Test Description** — one-liner assertion for test writers

Classifiers:
- `unit_testable`: merge, schema, path, parse, util, validation, dedup
- `cli_testable`: resolve, execute, capture
- `integration_testable`: auth, browser, cookie, login, server
- `not_testable`: doc, whitepaper, marketing, roadmap, epic

### Test Runner (`scripts/p0-p1-test-runner.ts`)

Runs tests by category:
- **Unit tests**: `bun test tests/`
- **CLI tests**: `bun src/cli.ts health` for each issue (verifies CLI works)
- **Integration tests**: Print guide with test descriptions

Results written to `evals/p0-p1-test-results.json`.

## Repository

All issues analyzed from: `unbrowse-ai/unbrowse-dev`
- Search: `is:closed label:priority:p0 OR label:priority:p1`
- Filters: Closed issues only, excludes P2+
- Update frequency: Manual (run `bun test:p0-p1:analyze`)

## Commands Reference

| Command | Purpose |
|---------|---------|
| `bun test:p0-p1:analyze` | Fetch and analyze all closed P0/P1 issues |
| `bun test:p0-p1` | Run all automated tests |
| `bun test:p0-p1:unit` | Run unit tests only |
| `bun test:p0-p1:cli` | Run CLI tests only |
| `bun test:p0-p1:integration` | Show integration test guide |
| `bun test:p0-p1:generate` | Legacy: generate test cases (old system) |

## Troubleshooting

### "No analyses found"
```bash
bun test:p0-p1:analyze  # Generate first
```

### GitHub API rate limit
```bash
export GITHUB_TOKEN=ghp_xxxx
bun test:p0-p1:analyze
```

### Tests fail with "CLI exited with code X"
```bash
# Run CLI manually to debug
bun src/cli.ts health
bun src/cli.ts resolve --intent "test" --url "https://example.com"
```

### Kuri binary not found
```bash
# Rebuild from source
cd packages/skill
npm pack

# Or check vendored binaries exist
ls packages/skill/vendor/kuri/*/kuri
```

## Next Steps

1. **Run analysis**: `bun test:p0-p1:analyze`
2. **Check results**: `cat tests/p0-p1-analyses.json | head`
3. **Run tests**: `bun test:p0-p1:unit` (start with unit tests)
4. **Review failures**: `cat evals/p0-p1-test-results.json`
5. **Add to CI**: Copy GitHub Actions example above

---

**Last Updated**: 2026-03-31  
**System**: P0/P1 Regression Testing v2 with native analysis  
### Parallel Testing

Tests run sequentially by default. For faster testing:

```bash
# Run with parallelization (if bun supports it in your version)
bun test tests/p0-p1-issues.test.ts --parallel
```

### Caching Results

Test results are cached:

```bash
# View cached results
cat evals/p0-p1-test-results.json
```

### Skip Full Generation

If you already have test cases:

```bash
# Skip generation, just run tests
bun run test:p0-p1
```

## Monitoring

### View Test Metrics

```bash
# Get summary stats
cat evals/p0-p1-test-results.json | jq '
  {
    total: length,
    passed: [.[] | select(.passed)] | length,
    failed: [.[] | select(.passed == false)] | length
  }
'
```

### Track Over Time

```bash
# Archive results with timestamp
cp evals/p0-p1-test-results.json "evals/p0-p1-results-$(date +%Y%m%d-%H%M%S).json"
```

## Best Practices

1. **Run Before Pushing**: Always run tests before pushing to remote
2. **Update Regularly**: Regenerate test cases monthly to catch new issues
3. **Review Failures**: Investigate failed tests immediately
4. **Keep Intents Clear**: Intents should describe what's being tested
5. **Version Control**: Commit `tests/p0-p1-issues.json` to track changes

## Contributing

To add more sophisticated validators:

1. Edit `tests/p0-p1-issues.test.ts`
2. Enhance the `expectedSignals` interface
3. Add validation logic in `runUnbrowseTest()`
4. Document the new signals

## Support

For issues with the testing framework:

1. Check the troubleshooting section above
2. Review test output in `evals/p0-p1-test-results.json`
3. Run CLI manually to verify it works
4. Check GitHub token permissions if regenerating

---

**Last Updated**: 2026-03-31
**Framework Version**: 1.0
