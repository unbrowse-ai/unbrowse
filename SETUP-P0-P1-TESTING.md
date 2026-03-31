# P0/P1 Testing Setup Guide

Complete setup for automated P0/P1 regression testing with git hooks.

## What's Included

✅ **Issue Analysis** — Auto-fetch & classify all closed P0/P1 issues  
✅ **Test Runners** — Unit, CLI, and integration test categories  
✅ **Git Hooks** — Auto-run tests on commit and push  
✅ **Zero External Deps** — Kuri is pre-packaged in CLI  

## One-Time Setup

```bash
# Make setup script executable
chmod +x scripts/setup-p0-p1-testing.sh

# Run setup
bash scripts/setup-p0-p1-testing.sh
```

This will:
1. ✅ Initialize kuri submodule (if not present)
2. ✅ Verify kuri vendoring in package.json
3. ✅ Make git hooks executable
4. ✅ Generate initial P0/P1 analyses
5. ✅ Show quick start commands

## Manual Steps (If Needed)

### Step 1: Initialize Submodules
```bash
git submodule update --init --recursive submodules/kuri
```

### Step 2: Make Hooks Executable
```bash
chmod +x .husky/post-commit
chmod +x .husky/pre-push
```

### Step 3: Generate Initial Analysis
```bash
bun test:p0-p1:analyze
```

Expected output:
```
Analyzing closed P0/P1 issues from unbrowse-ai/unbrowse-dev...
Found X P0 issues and Y P1 issues
✅ Wrote Z issue analyses to tests/p0-p1-analyses.json
```

## Git Hooks (Automatic)

### Post-Commit Hook (`.husky/post-commit`)
Runs after each commit:
```bash
bun test:p0-p1:cli --priority P0
```
- Tests P0 CLI fixes only (~30s)
- Non-blocking (failures don't fail commit)
- Skip with: `SKIP_P0_P1_TESTS=1 git commit`

### Pre-Push Hook (`.husky/pre-push`)
Runs before pushing:
```bash
bun test:p0-p1:analyze   # Update analysis
bun test:p0-p1           # Run full test suite
```
- Fetches latest issues from GitHub
- Runs all automated tests
- **Blocking** (failed tests prevent push)
- Skip with: `git push --no-verify`

## Daily Workflow

### Morning (Fresh Analysis)
```bash
bun test:p0-p1:analyze
```
Updates `tests/p0-p1-analyses.json` with any new closed issues.

### While Coding (Quick Tests)
```bash
bun test:p0-p1:unit
```
Runs only unit tests (~5-10s). Good for frequent checks.

### Before Commit
```bash
bun test:p0-p1
```
Runs full suite. Pre-commit hook will also run P0 tests.

### Before Push (Automatic)
Pre-push hook runs automatically:
- Refreshes analysis
- Runs full test suite
- Shows pass/fail summary

## Kuri Integration

Kuri is **already bundled** — no installation needed.

### Structure
```
packages/skill/
├── vendor/kuri/          ← Pre-compiled binaries
│   ├── darwin-arm64/kuri
│   ├── darwin-x64/kuri
│   ├── linux-arm64/kuri
│   └── linux-x64/kuri
├── scripts/
│   └── build-kuri-binaries.mjs  ← Build from source (if needed)
└── package.json          ← vendor/kuri in "files"
```

### Build From Source (Optional)
```bash
# Only if you need to rebuild kuri
cd submodules/kuri
zig build -Doptimize=ReleaseFast

# Then repack the skill
cd ../../packages/skill
npm pack
```

## File Structure

```
unbrowse/
├── scripts/
│   ├── analyze-p0-p1-issues.ts      ← Fetch & analyze issues
│   ├── p0-p1-test-runner.ts         ← Run tests by category
│   ├── setup-p0-p1-testing.sh       ← One-time setup
│   └── build-kuri-binaries.mjs      ← Kuri compilation
├── tests/
│   ├── p0-p1-analyses.json          ← Issue catalog (generated)
│   ├── p0-p1-issues.json            ← Legacy test cases
│   └── p0-p1-issues.test.ts         ← Legacy test runner
├── evals/
│   └── p0-p1-test-results.json      ← Test results (generated)
├── .husky/
│   ├── post-commit                  ← After-commit tests
│   ├── pre-push                     ← Before-push tests
│   └── ...
├── package.json                     ← npm test:p0-p1:* commands
└── P0-P1-TESTING.md                 ← Full documentation
```

## Commands Reference

| Command | Purpose | Time |
|---------|---------|------|
| `bun test:p0-p1:analyze` | Fetch & analyze all closed P0/P1 issues | ~10-20s |
| `bun test:p0-p1:unit` | Run unit tests only | ~5-10s |
| `bun test:p0-p1:cli` | Run CLI tests only | ~30-60s |
| `bun test:p0-p1:integration` | Show integration test guide | ~1s |
| `bun test:p0-p1` | Run all automated tests | ~1-2m |
| `bash scripts/setup-p0-p1-testing.sh` | One-time setup | ~1m |

## Test Output

### Analysis Output (`tests/p0-p1-analyses.json`)
```json
[
  {
    "number": 89,
    "title": "Retrieval runtime: restore route cache...",
    "priority": "P0",
    "category": "unit_testable",
    "bug_feature": "Cache correctness and marketplace hydration",
    "test_description": "Assert that route cache + marketplace hydration produces correct results...",
    "labels": ["cache", "marketplace"]
  },
  ...
]
```

### Test Results (`evals/p0-p1-test-results.json`)
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

## Troubleshooting

### Hooks Not Running
```bash
# Make sure hooks are executable
chmod +x .husky/post-commit .husky/pre-push

# Check husky is set up
ls -la .husky/
```

### GitHub API Rate Limited
```bash
# Set token for higher rate limit (100 req/hour → 5000 req/hour)
export GITHUB_TOKEN=ghp_your_token_here
bun test:p0-p1:analyze
```

### "No analyses found"
```bash
# Generate first
bun test:p0-p1:analyze

# Or run setup script
bash scripts/setup-p0-p1-testing.sh
```

### Kuri Binary Not Found
```bash
# Check if binaries exist
ls packages/skill/vendor/kuri/*/kuri

# If missing, rebuild
cd packages/skill && npm pack
```

### Pre-push Hook Too Slow
The hook fetches latest issues and runs full tests (~2min). To speed up:
```bash
# Skip hook if time-constrained
git push --no-verify
```

## CI/CD Integration

### GitHub Actions
```yaml
name: P0/P1 Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          submodules: recursive
      
      - uses: oven-sh/setup-bun@v1
      
      - name: Setup P0/P1 tests
        run: bun test:p0-p1:analyze
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Run P0/P1 tests
        run: bun test:p0-p1
      
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: p0-p1-results
          path: evals/p0-p1-test-results.json
```

## Next Steps

1. Run setup:
   ```bash
   bash scripts/setup-p0-p1-testing.sh
   ```

2. Check analyses:
   ```bash
   jq . tests/p0-p1-analyses.json | head -50
   ```

3. Run unit tests:
   ```bash
   bun test:p0-p1:unit
   ```

4. Review results:
   ```bash
   cat evals/p0-p1-test-results.json
   ```

5. Make a commit (hook runs automatically):
   ```bash
   git add .
   git commit -m "feat: add p0-p1 testing"
   ```

---

**Last Updated**: 2026-03-31  
**Status**: Ready to use  
**Kuri**: Pre-packaged ✅
