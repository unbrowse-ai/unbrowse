#!/usr/bin/env node
import fs from 'node:fs';
import { execSync } from 'node:child_process';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function tryRun(cmd, fallback = '') {
  try {
    return run(cmd);
  } catch {
    return fallback;
  }
}

function truncateBlock(text, maxLines = 220) {
  const lines = (text || '').split('\n');
  if (lines.length <= maxLines) return text || '';
  return `${lines.slice(0, maxLines).join('\n')}\n... (truncated ${lines.length - maxLines} lines)`;
}

function parseArgs(argv) {
  const out = { version: '', from: '', mode: 'draft' };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') {
      out.from = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--mode') {
      out.mode = argv[i + 1] ?? 'draft';
      i += 1;
    } else {
      positional.push(a);
    }
  }

  out.version = positional[0] ?? '';
  return out;
}

function getChangelogSection(version) {
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(`## \\\[${escaped}\\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\\[|$)`);
  const match = changelog.match(sectionRegex);
  if (!match) {
    throw new Error(`Could not find CHANGELOG section for version ${version}`);
  }
  return match[1].trim();
}

function inferPrevious(version) {
  const parts = version.split('.');
  const patch = Number.parseInt(parts[2] ?? '0', 10);
  return Number.isFinite(patch) && patch > 0 ? `${parts[0]}.${parts[1]}.${patch - 1}` : 'X.Y.Z-1';
}

function collectContext(fromTag, toTag) {
  const fromRef = `v${fromTag}`;
  const toRef = `v${toTag}`;
  const range = `${fromRef}...${toRef}`;

  const commits =
    tryRun(`git log --pretty=format:'- %s (%h)' ${range}`) ||
    tryRun("git log -n 20 --pretty=format:'- %s (%h)'") ||
    '- <unable to read git log>';

  const mergedPrs =
    tryRun(`git log --merges --pretty=format:'- %s' ${range}`) ||
    tryRun("git log -n 20 --merges --pretty=format:'- %s'") ||
    '- <unable to read merged PRs>';

  const diffStat =
    tryRun(`git diff --stat ${range}`) || tryRun('git show --stat --pretty="" HEAD') || '- <unable to read diff stat>';

  const changedFiles =
    tryRun(`git diff --name-status ${range}`) ||
    tryRun('git show --name-status --pretty="" HEAD') ||
    '- <unable to read changed files>';

  const numStat =
    tryRun(`git diff --numstat ${range}`) || tryRun('git show --numstat --pretty="" HEAD') || '- <unable to read numstat>';

  const patch =
    tryRun(`git diff --unified=1 --no-color ${range}`) ||
    tryRun('git show --unified=1 --no-color --pretty="" HEAD') ||
    '- <unable to read patch>';

  return {
    range,
    commits: truncateBlock(commits, 120),
    mergedPrs: truncateBlock(mergedPrs, 80),
    diffStat: truncateBlock(diffStat, 120),
    changedFiles: truncateBlock(changedFiles, 200),
    numStat: truncateBlock(numStat, 200),
    patch: truncateBlock(patch, 260)
  };
}

function buildDraft(version, previousVersion, section) {
  return `# v${version}

## 🚀 Highlights
- <Summarize top user-facing outcomes from this release>
- <Summarize top user-facing outcomes from this release>
- <Summarize top user-facing outcomes from this release>

## 🔧 Upgrade / Migration Notes
- Breaking changes: none | <describe>
- Required actions: none | <describe>
- Rollback note: <optional>

## 🧭 Operator Notes
- <Optional operational/runtime notes>

## 🧪 Validation
- CI status: ✅
- Publish status: ✅

## 📚 Changelog Excerpt
${section}

## 📚 Full Details
- Changelog: https://github.com/lekt9/unbrowse-openclaw/blob/stable/CHANGELOG.md
- Compare: https://github.com/lekt9/unbrowse-openclaw/compare/v${previousVersion}...v${version}
`;
}

function buildLlmPrompt(version, previousVersion, section, context) {
  return `You are preparing polished GitHub release notes for unbrowse-openclaw.

Goal:
- Produce concise, user-facing release notes for v${version}.
- Prioritize outcomes and workflow impact over low-level implementation detail.
- Keep technical specifics only when they matter for upgrade or operations.

Output format:
- Use this structure exactly:
  1) 🚀 Highlights (3-5 bullets)
  2) 🔧 Upgrade / Migration Notes
  3) 🧭 Operator Notes
  4) 📚 Full Details (keep links as provided)

Context:
- Release version: v${version}
- Compare range: ${context.range}
- Compare link: https://github.com/lekt9/unbrowse-openclaw/compare/v${previousVersion}...v${version}

Canonical changelog excerpt:
${section}

Merged PR titles in range:
${context.mergedPrs}

Commit subjects in range:
${context.commits}

Code-level diff summary (git diff --stat):
${context.diffStat}

Changed files (git diff --name-status):
${context.changedFiles}

Line deltas (git diff --numstat):
${context.numStat}

Patch excerpt (git diff --unified=1):
${context.patch}

Constraints:
- Do not invent features.
- Mention breaking changes only if clearly present.
- If uncertain, phrase conservatively.
- Use the code-level diff above to justify each highlight.
`;
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  if (Array.isArray(data?.output)) {
    const chunks = [];
    for (const item of data.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const c of item.content) {
        if (typeof c?.text === 'string' && c.text.trim()) chunks.push(c.text.trim());
      }
    }
    if (chunks.length > 0) return chunks.join('\n\n');
  }
  return '';
}

async function generateWithLlm(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for --mode llm');
  }

  const model = process.env.RELEASE_NOTES_MODEL || 'gpt-5-mini';
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: prompt
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`LLM request failed (${resp.status}): ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('LLM response was not valid JSON');
  }

  const output = extractResponseText(data);
  if (!output) {
    throw new Error('LLM response did not contain output text');
  }
  return output;
}

async function main() {
  const { version, from, mode } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error('Usage: node tasks/generate-release-notes.mjs <version> [--from <previous-version>] [--mode draft|llm-prompt|llm]');
    process.exit(1);
  }

  if (!['draft', 'llm-prompt', 'llm'].includes(mode)) {
    console.error('Invalid --mode. Use: draft | llm-prompt | llm');
    process.exit(1);
  }

  const section = getChangelogSection(version);
  const previousVersion = from || inferPrevious(version);
  const context = collectContext(previousVersion, version);

  if (mode === 'draft') {
    process.stdout.write(buildDraft(version, previousVersion, section));
    return;
  }

  const prompt = buildLlmPrompt(version, previousVersion, section, context);
  if (mode === 'llm-prompt') {
    process.stdout.write(prompt);
    return;
  }

  const generated = await generateWithLlm(prompt);
  process.stdout.write(generated.endsWith('\n') ? generated : `${generated}\n`);
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
