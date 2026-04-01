# P0/P1 Testing — Ready to Activate

Everything is set up. **Copy and paste these commands to activate.**

## Status
- ✅ Analysis script created: `scripts/analyze-p0-p1-issues.ts`
- ✅ Test runner created: `scripts/p0-p1-test-runner.ts`
- ✅ Git hooks created: `.husky/post-commit` and `.husky/pre-push`
- ✅ Kuri packaged: `vendor/kuri` in `packages/skill/package.json` files list
- ✅ Package.json updated: 5 new `test:p0-p1:*` commands

## Activate (Run These)

```bash
# 1. Make hooks executable
chmod +x .husky/post-commit .husky/pre-push scripts/setup-p0-p1-testing.sh

# 2. Initialize submodules (if not already done)
git submodule update --init --recursive submodules/kuri

# 3. Generate P0/P1 issue analysis from GitHub
bun test:p0-p1:analyze

# 4. Verify unit tests work
bun test:p0-p1:unit

# 5. Make initial commit (triggers post-commit hook)
git add .
git commit -m "feat: activate p0-p1 testing with kuri bundling"
```

## What Happens After Activation

### Automatic (via Git Hooks)

**After every `git commit`:**
- Runs P0 CLI tests to validate fixes
- Takes ~30 seconds
- Non-blocking (doesn't prevent commit)

**Before every `git push`:**
- Fetches latest P0/P1 issues from GitHub
- Runs full test suite (unit + CLI)
- Takes ~1-2 minutes
- **Blocks push if tests fail** (use `git push --no-verify` to skip)

### Manual Commands Available

```bash
# Fetch & analyze latest closed P0/P1 issues
bun test:p0-p1:analyze

# Run specific test categories
bun test:p0-p1:unit           # 5-10s
bun test:p0-p1:cli            # 30-60s
bun test:p0-p1:integration    # Show guide only

# Run all automated tests
bun test:p0-p1
```

## How It Works

### 1. Analysis Phase
`bun test:p0-p1:analyze` fetches all closed P0/P1 issues from GitHub and:
- Extracts bug/feature summary from each issue
- Classifies test type: `unit_testable` | `cli_testable` | `integration_testable` | `not_testable`
- Generates one-liner test descriptions
- Writes to `tests/p0-p1-analyses.json`

### 2. Test Phase
`bun test:p0-p1` runs tests by category:
- **Unit tests**: `bun test tests/` (code logic)
- **CLI tests**: `bun src/cli.ts health` per issue (unbrowse CLI)
- **Integration tests**: Prints manual test guide (auth, servers)
- Writes results to `evals/p0-p1-test-results.json`

### 3. Regression Prevention
- Git hooks automatically test after commits/before pushes
- Failed tests block pushes (prevents shipping broken fixes)
- Results tracked in JSON for trend analysis

## Test Categories

| Category | What It Tests | Example |
|----------|---------------|---------|
| `unit_testable` | Code logic directly | Schema merging, path parsing |
| `cli_testable` | unbrowse CLI commands | `unbrowse resolve --intent ... --url ...` |
| `integration_testable` | Live infrastructure | Auth flows, cookie extraction, servers |
| `not_testable` | Non-code issues | Docs, marketing, roadmaps |

## Kuri Integration

**Fully bundled** — no installation needed:
- Location: `packages/skill/vendor/kuri/`
- Includes: darwin-arm64, darwin-x64, linux-arm64, linux-x64
- Shipped with: npm package
- Build: Pre-compiled binaries (rebuild on `npm pack` if source present)

## Output Files

After running tests:

**`tests/p0-p1-analyses.json`** — Issue catalog
```json
[
  {
    "number": 89,
    "title": "Retrieval runtime: restore route cache...",
    "priority": "P0",
    "category": "unit_testable",
    "bug_feature": "Cache correctness and marketplace hydration",
    "test_description": "Assert that route cache + marketplace hydration...",
    "labels": ["cache", "marketplace"]
  },
  ...
]
```

**`evals/p0-p1-test-results.json`** — Test results
```json
[
  {
    "issueNumber": 89,
    "title": "Retrieval runtime...",
    "category": "unit_testable",
    "passed": true,
    "duration": 250,
    "timestamp": "2026-03-31T21:42:00.000Z"
  },
  ...
]
```

## Skip Hooks If Needed

```bash
# Skip tests for one commit
SKIP_P0_P1_TESTS=1 git commit -m "message"

# Skip tests for push
git push --no-verify
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Hooks not running" | Run: `chmod +x .husky/*` |
| "GitHub API rate limited" | Set: `export GITHUB_TOKEN=ghp_xxx` |
| "No analyses found" | Run: `bun test:p0-p1:analyze` |
| "Kuri binary not found" | Run: `cd packages/skill && npm pack` |

## Read More

- `P0-P1-TESTING.md` — Full user guide with workflows
- `SETUP-P0-P1-TESTING.md` — Detailed setup instructions
- `scripts/analyze-p0-p1-issues.ts` — Analysis implementation
- `scripts/p0-p1-test-runner.ts` — Test runner implementation

---

**Ready to go!** Just run the 5 commands in the "Activate" section above.
