#!/usr/bin/env python3
"""
Build commits for 5 fix branches from main, using git plumbing.
Each branch adds specific files on top of main's tree.
"""
import subprocess
import os
import sys

REPO = '/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse'
MAIN_COMMIT = '01e411a682be30392c4b8ba819740b72aa0c53df'
MAIN_TREE = 'f00b6fca2dfeeecc6db6f151a24a4574533f1208'

def git(*args):
    result = subprocess.run(['git'] + list(args), capture_output=True, text=True, cwd=REPO)
    if result.returncode != 0:
        print(f"ERROR: git {' '.join(args)}", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()

def git_ok(*args):
    """Run git, return (stdout, ok)"""
    result = subprocess.run(['git'] + list(args), capture_output=True, text=True, cwd=REPO)
    return result.stdout.strip(), result.returncode == 0

def hash_file(path):
    """Hash a file into the git object store and return its SHA."""
    result = subprocess.run(['git', 'hash-object', '-w', path], capture_output=True, text=True, cwd=REPO)
    if result.returncode != 0:
        print(f"ERROR hashing {path}: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()

def read_tree_entries(tree_sha):
    """Read tree entries recursively. Returns list of (mode, type, sha, path)."""
    result = subprocess.run(['git', 'ls-tree', '-r', '--full-tree', tree_sha],
                          capture_output=True, text=True, cwd=REPO)
    if result.returncode != 0:
        return []
    entries = []
    for line in result.stdout.splitlines():
        parts = line.split('\t', 1)
        meta = parts[0].split(' ')
        entries.append((meta[0], meta[1], meta[2], parts[1]))
    return entries

def build_tree_with_files(base_tree_entries, extra_files):
    """
    Build a new tree by updating base_tree_entries with extra_files.
    extra_files: list of (path, sha, mode) tuples
    Returns: new tree SHA
    """
    # Build a flat index of path -> (mode, sha)
    index = {}
    for (mode, typ, sha, path) in base_tree_entries:
        if typ == 'blob':
            index[path] = (mode, sha)
    
    # Apply extra files
    for (path, sha, mode) in extra_files:
        index[path] = (mode, sha)
    
    # Now build nested tree structure using git mktree
    # Group by directory
    dirs = {}
    for path, (mode, sha) in index.items():
        parts = path.split('/', 1)
        if len(parts) == 1:
            dirs.setdefault('', []).append(('blob', mode, sha, parts[0]))
        else:
            dirs.setdefault(parts[0], []).append(('blob', mode, sha, parts[1]))
    
    # This approach is too complex - use update-index + write-tree instead
    return None

def create_commit_via_index(branch, files, message):
    """
    Create a commit on 'branch' with the given files added to main's tree.
    Uses a temp index file to avoid affecting the main index.
    """
    import tempfile
    
    tmp_idx = f'/tmp/git-idx-{branch.replace("/", "-")}'
    
    env = os.environ.copy()
    env['GIT_INDEX_FILE'] = tmp_idx
    env['GIT_DIR'] = os.path.join(REPO, '.git')
    env['GIT_WORK_TREE'] = REPO
    
    # Load main tree into temp index
    r = subprocess.run(['git', 'read-tree', MAIN_TREE], env=env, capture_output=True, text=True, cwd=REPO)
    if r.returncode != 0:
        print(f"read-tree failed: {r.stderr}")
        return None
    
    # Hash and add each file
    for (filepath, abs_path) in files:
        # Hash the file
        r2 = subprocess.run(['git', 'hash-object', '-w', abs_path], env=env, capture_output=True, text=True, cwd=REPO)
        if r2.returncode != 0:
            print(f"hash-object failed: {r2.stderr}")
            return None
        blob_sha = r2.stdout.strip()
        
        # Add to index
        r3 = subprocess.run(['git', 'update-index', '--add', '--cacheinfo', f'100644,{blob_sha},{filepath}'],
                           env=env, capture_output=True, text=True, cwd=REPO)
        if r3.returncode != 0:
            print(f"update-index failed: {r3.stderr}")
            return None
    
    # Write tree
    r4 = subprocess.run(['git', 'write-tree'], env=env, capture_output=True, text=True, cwd=REPO)
    if r4.returncode != 0:
        print(f"write-tree failed: {r4.stderr}")
        return None
    tree_sha = r4.stdout.strip()
    
    # Create commit
    commit_env = env.copy()
    commit_env['GIT_AUTHOR_NAME'] = 'lewistham9x'
    commit_env['GIT_AUTHOR_EMAIL'] = 'lewistham9x@gmail.com'
    commit_env['GIT_COMMITTER_NAME'] = 'lewistham9x'
    commit_env['GIT_COMMITTER_EMAIL'] = 'lewistham9x@gmail.com'
    
    r5 = subprocess.run(
        ['git', 'commit-tree', tree_sha, '-p', MAIN_COMMIT, '-m', message],
        env=commit_env, capture_output=True, text=True, cwd=REPO
    )
    if r5.returncode != 0:
        print(f"commit-tree failed: {r5.stderr}")
        return None
    commit_sha = r5.stdout.strip()
    
    # Update branch ref
    ref_file = os.path.join(REPO, '.git', 'refs', 'heads', branch)
    os.makedirs(os.path.dirname(ref_file), exist_ok=True)
    with open(ref_file, 'w') as f:
        f.write(commit_sha + '\n')
    
    print(f"Created commit {commit_sha} on {branch}")
    
    # Cleanup temp index
    if os.path.exists(tmp_idx):
        os.unlink(tmp_idx)
    
    return commit_sha

BASE = REPO

# Branch 1: fix/99-cache-stats
commit1 = create_commit_via_index(
    'fix/99-cache-stats',
    [
        ('src/cache-stats.ts', f'{BASE}/src/cache-stats.ts'),
        ('tests/cache-stats.test.ts', f'{BASE}/tests/cache-stats.test.ts'),
    ],
    'feat(#99): add cache hit/miss statistics for skill caching layer\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'
)

# Branch 2: fix/101-schema-drift-deprecation
commit2 = create_commit_via_index(
    'fix/101-schema-drift-deprecation',
    [
        ('src/verification/index.ts', f'{BASE}/src/verification/index.ts'),
        ('tests/schema-drift-deprecation.test.ts', f'{BASE}/tests/schema-drift-deprecation.test.ts'),
    ],
    'feat(#101): mark critical drift as failed and include pending in scheduler\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'
)

# Branch 3: fix/103-composite-search-scoring
commit3 = create_commit_via_index(
    'fix/103-composite-search-scoring',
    [
        ('backend/src/services/search.ts', f'{BASE}/backend/src/services/search.ts'),
        ('backend/tests/composite-scoring.test.ts', f'{BASE}/backend/tests/composite-scoring.test.ts'),
    ],
    'feat(#103): add composite search scoring combining vector, reliability, freshness, verification\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'
)

# Branch 4: fix/87-unsafe-action-scoring
commit4 = create_commit_via_index(
    'fix/87-unsafe-action-scoring',
    [
        ('src/router.ts', f'{BASE}/src/router.ts'),
        ('tests/unsafe-action-score.test.ts', f'{BASE}/tests/unsafe-action-score.test.ts'),
        ('src/orchestrator/index.ts', f'{BASE}/src/orchestrator/index.ts'),
    ],
    'feat(#87): add unsafe action score gate to auto-execution\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'
)

# Branch 5: fix/120-capture-prefetch
commit5 = create_commit_via_index(
    'fix/120-capture-prefetch',
    [
        ('src/capture/prefetch.ts', f'{BASE}/src/capture/prefetch.ts'),
        ('tests/capture-dependency-prefetch.test.ts', f'{BASE}/tests/capture-dependency-prefetch.test.ts'),
    ],
    'feat(#120): add dependency prefetch for capture phase\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'
)

print("Done!")
print(f"Branch commits: {commit1}, {commit2}, {commit3}, {commit4}, {commit5}")
