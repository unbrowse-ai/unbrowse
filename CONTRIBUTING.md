# Contributing to Unbrowse

Thanks for your interest in contributing! Unbrowse helps AI agents work with any website by capturing and reverse-engineering internal APIs.

## Development Setup

### Prerequisites

- **Node.js** 18+ or Bun
- **Playwright** (`npx playwright install chromium`)
- **SQLite3** (usually pre-installed on macOS/Linux)

### Quick Setup

```bash
# Clone the repo
git clone https://github.com/lekt9/unbrowse-openclaw.git
cd unbrowse-openclaw

# Install dependencies
npm install

# Build TypeScript
npm run build
```

### Running with OpenClaw

```bash
# Start the gateway
openclaw gateway restart

# Check status
openclaw gateway status

# View logs
tail -f ~/.openclaw/logs/gateway.log
```

## Project Structure

```
unbrowse-openclaw/
├── index.ts                  # Plugin entry point (11 tools)
├── src/
│   ├── har-parser.ts         # HAR → API endpoints
│   ├── skill-generator.ts    # Endpoints → SKILL.md + auth.json + api.ts
│   ├── profile-capture.ts    # Playwright-based network capture
│   ├── session-login.ts      # Credential login + session capture
│   ├── cdp-capture.ts        # Live CDP network capture
│   ├── skill-index.ts        # Cloud marketplace client (x402 payments)
│   ├── vault.ts              # Encrypted credential storage
│   ├── wallet.ts             # Ed25519 wallet for marketplace signing
│   └── ...
└── hooks/                    # Auto-discovery hooks
```

## Code Style Guide

### TypeScript

- Use **strict TypeScript** — enable all strict flags
- Prefer `interface` over `type` for object shapes
- Use explicit return types on exported functions
- Document public APIs with JSDoc comments

```typescript
// Good
export interface SkillConfig {
  name: string;
  timeout?: number;
}

/** Generate a skill from captured API data. */
export async function generateSkill(
  data: ApiData,
  outputDir?: string
): Promise<SkillResult> {
  // ...
}

// Avoid
export type Config = { name: string };
export function makeSkill(data: any) {
  // implicit return type
}
```

### Error Handling

- Use descriptive error messages
- Include context for failures
- Never expose internal details in production errors

```typescript
// Good
if (!resp.ok) {
  const text = await resp.text().catch(() => "");
  throw new Error(`Skill download failed (${resp.status}): ${text}`);
}

// Avoid
if (!resp.ok) throw new Error("Failed");
```

## Testing

### Type Checking

```bash
npm run build       # Full build
npx tsc --noEmit    # Type check only
```

### Manual Testing

Since this is a browser automation tool, most testing is manual:

1. Start the gateway: `openclaw gateway restart`
2. Use the tools in an OpenClaw session
3. Verify HAR capture, skill generation, and replay work

### Test Sites

Good sites to test with:
- `https://httpbin.org` — Simple API responses
- `https://jsonplaceholder.typicode.com` — Mock REST API

## Submitting PRs

1. **Fork** the repository
2. **Create a feature branch**: `git checkout -b feature/your-feature`
3. **Make your changes** following the style guide
4. **Test thoroughly**:
   - Run `npm run build` to verify TypeScript compiles
   - Test your changes with the actual gateway
5. **Commit** with clear messages:
   ```
   feat: add workflow recording support
   fix: handle missing auth headers gracefully
   docs: update API reference
   ```
6. **Push** to your fork: `git push origin feature/your-feature`
7. **Open a Pull Request** with:
   - Clear description of what changed and why
   - Any breaking changes
   - Screenshots/GIFs if UI-related

## PR Review Process

- All PRs require at least one review
- CI must pass (type check, build)
- Address review feedback promptly
- Squash commits before merge if requested

## Areas That Need Help

- **More auth methods** — OAuth2 flows, JWT refresh
- **Better parameter inference** — Detect path/body/query params from examples
- **Workflow learning** — Improve pattern detection in recordings
- **Documentation** — More examples, tutorials
- **Tests** — Unit tests for pure functions

## Security

- Never commit real credentials
- Use the vault for all auth storage
- Sanitize sensitive data before logging
- Report security issues privately to: security@unbrowse.ai

## Code of Conduct

- Be respectful and constructive
- Focus on the code, not the person
- Help newcomers learn
- Assume good intent

## Questions?

- Open a [Discussion](https://github.com/lekt9/unbrowse-openclaw/discussions) for questions
- Open an [Issue](https://github.com/lekt9/unbrowse-openclaw/issues) for bugs
- Join our [Discord](https://discord.gg/unbrowse) for real-time chat

Thanks for contributing! 🚀
