#!/bin/bash
# Setup P0/P1 Testing Infrastructure
# Run once to initialize full testing pipeline with git hooks

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "📦 P0/P1 Testing Infrastructure Setup"
echo "======================================"
echo ""

# Step 1: Ensure kuri submodule is present
echo "1️⃣  Checking kuri submodule..."
if [ ! -f "submodules/kuri/build.zig" ]; then
  echo "   Initializing submodules..."
  git submodule update --init --recursive submodules/kuri 2>/dev/null || true
else
  echo "   ✅ Kuri submodule ready"
fi

# Step 2: Verify kuri will be vendored
echo ""
echo "2️⃣  Verifying kuri vendoring..."
if grep -q "vendor/kuri" packages/skill/package.json; then
  echo "   ✅ Kuri is in package.json files list"
else
  echo "   ⚠️  Warning: vendor/kuri may not be packaged"
fi

# Step 3: Install/update husky
echo ""
echo "3️⃣  Setting up git hooks..."
if [ -d ".husky" ]; then
  echo "   ✅ Husky directory exists"
else
  echo "   Creating .husky directory..."
  mkdir -p .husky
fi

# Make hooks executable
chmod +x .husky/post-commit 2>/dev/null || true
chmod +x .husky/pre-push 2>/dev/null || true

# Initialize husky if package.json has husky script
if grep -q '"prepare": "husky"' package.json; then
  echo "   ✅ Husky configured in package.json"
fi

# Step 4: Generate initial analyses
echo ""
echo "4️⃣  Generating P0/P1 issue analyses..."
if bun scripts/analyze-p0-p1-issues.ts 2>/dev/null; then
  ISSUES=$(jq 'length' tests/p0-p1-analyses.json 2>/dev/null || echo 0)
  echo "   ✅ Generated analyses for $ISSUES issues"
  echo "      Output: tests/p0-p1-analyses.json"
else
  echo "   ⚠️  Could not fetch from GitHub (network/auth)"
  echo "      You can run manually: bun test:p0-p1:analyze"
fi

# Step 5: Summary
echo ""
echo "======================================"
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Review analysis: jq . tests/p0-p1-analyses.json | head -20"
echo "  2. Run unit tests: bun test:p0-p1:unit"
echo "  3. Run CLI tests:  bun test:p0-p1:cli"
echo "  4. View all tests: bun test:p0-p1"
echo ""
echo "Git hooks are now active:"
echo "  • post-commit  → runs P0 CLI tests after commit"
echo "  • pre-push     → runs full test suite before push"
echo ""
echo "Skip hooks if needed:"
echo "  SKIP_P0_P1_TESTS=1 git commit ..."
echo "  git push --no-verify"
echo ""
echo "Learn more: cat P0-P1-TESTING.md"
