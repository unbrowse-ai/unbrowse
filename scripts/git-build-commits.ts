/**
 * Build commits for 5 fix branches from main using git plumbing.
 * Each branch adds specific files on top of main's tree.
 */
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";

const REPO = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse";
const MAIN_COMMIT = "01e411a682be30392c4b8ba819740b72aa0c53df";
const MAIN_TREE = "f00b6fca2dfeeecc6db6f151a24a4574533f1208";

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch (e: any) {
    console.error(`ERROR: git ${args.join(" ")}`);
    console.error(e.stderr?.toString() ?? e.message);
    process.exit(1);
  }
}

function gitEnv(env: Record<string, string>, ...args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  } catch (e: any) {
    console.error(`ERROR (env): git ${args.join(" ")}`);
    console.error(e.stderr?.toString() ?? e.message);
    process.exit(1);
  }
}

function createCommit(
  branch: string,
  files: Array<[string, string]>,
  message: string
): string {
  const tmpIdx = `/tmp/git-idx-${branch.replace(/\//g, "-")}`;

  const env: Record<string, string> = {
    GIT_INDEX_FILE: tmpIdx,
    GIT_DIR: join(REPO, ".git"),
    GIT_WORK_TREE: REPO,
  };

  // Load main tree into temp index
  gitEnv(env, "read-tree", MAIN_TREE);

  // Hash each file and add to index
  for (const [repoPath, absPath] of files) {
    const blobSha = gitEnv(env, "hash-object", "-w", absPath);
    gitEnv(env, "update-index", "--add", "--cacheinfo", `100644,${blobSha},${repoPath}`);
  }

  // Write tree
  const treeSha = gitEnv(env, "write-tree");

  // Create commit
  const authorEnv: Record<string, string> = {
    ...env,
    GIT_AUTHOR_NAME: "lewistham9x",
    GIT_AUTHOR_EMAIL: "lewistham9x@gmail.com",
    GIT_COMMITTER_NAME: "lewistham9x",
    GIT_COMMITTER_EMAIL: "lewistham9x@gmail.com",
  };

  const commitSha = gitEnv(authorEnv, "commit-tree", treeSha, "-p", MAIN_COMMIT, "-m", message);

  // Update local branch ref
  const refFile = join(REPO, ".git", "refs", "heads", branch);
  mkdirSync(dirname(refFile), { recursive: true });
  writeFileSync(refFile, commitSha + "\n");

  console.log(`Created commit ${commitSha} on ${branch}`);

  // Cleanup temp index
  if (existsSync(tmpIdx)) unlinkSync(tmpIdx);

  return commitSha;
}

const BASE = REPO;

// Branch 1: fix/99-cache-stats
const commit1 = createCommit(
  "fix/99-cache-stats",
  [
    ["src/cache-stats.ts", `${BASE}/src/cache-stats.ts`],
    ["tests/cache-stats.test.ts", `${BASE}/tests/cache-stats.test.ts`],
  ],
  "feat(#99): add cache hit/miss statistics for skill caching layer\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
);

// Branch 2: fix/101-schema-drift-deprecation
const commit2 = createCommit(
  "fix/101-schema-drift-deprecation",
  [
    ["src/verification/index.ts", `${BASE}/src/verification/index.ts`],
    ["tests/schema-drift-deprecation.test.ts", `${BASE}/tests/schema-drift-deprecation.test.ts`],
  ],
  "feat(#101): mark critical drift as failed and include pending in scheduler\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
);

// Branch 3: fix/103-composite-search-scoring
const commit3 = createCommit(
  "fix/103-composite-search-scoring",
  [
    ["backend/src/services/search.ts", `${BASE}/backend/src/services/search.ts`],
    ["backend/tests/composite-scoring.test.ts", `${BASE}/backend/tests/composite-scoring.test.ts`],
  ],
  "feat(#103): add composite search scoring combining vector, reliability, freshness, verification\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
);

// Branch 4: fix/87-unsafe-action-scoring
const commit4 = createCommit(
  "fix/87-unsafe-action-scoring",
  [
    ["src/router.ts", `${BASE}/src/router.ts`],
    ["tests/unsafe-action-score.test.ts", `${BASE}/tests/unsafe-action-score.test.ts`],
    ["src/orchestrator/index.ts", `${BASE}/src/orchestrator/index.ts`],
  ],
  "feat(#87): add unsafe action score gate to auto-execution\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
);

// Branch 5: fix/120-capture-prefetch
const commit5 = createCommit(
  "fix/120-capture-prefetch",
  [
    ["src/capture/prefetch.ts", `${BASE}/src/capture/prefetch.ts`],
    ["tests/capture-dependency-prefetch.test.ts", `${BASE}/tests/capture-dependency-prefetch.test.ts`],
  ],
  "feat(#120): add dependency prefetch for capture phase\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
);

console.log("\nAll commits created:");
console.log(`fix/99-cache-stats: ${commit1}`);
console.log(`fix/101-schema-drift-deprecation: ${commit2}`);
console.log(`fix/103-composite-search-scoring: ${commit3}`);
console.log(`fix/87-unsafe-action-scoring: ${commit4}`);
console.log(`fix/120-capture-prefetch: ${commit5}`);
