# Unbrowse Self-Writing Architecture Plan

## Goal

Transform unbrowse from a "browser automation + skill capture" plugin into a **self-evolving agent enhancement system** that can:

1. **Observe what Clawdbot is trying to do** (via hooks)
2. **Write itself into achieving the task** — generating new tools, skills, hooks, and integrations dynamically
3. **Persist capabilities** — so future sessions automatically have access to learned behaviors

The primary goal: **do whatever it takes to get the job done**, whether through API reverse engineering, skill writing, or self-modification.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         UNBROWSE CORE                                │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Task Watcher │  │ Capability   │  │ Self-Writer  │               │
│  │  (Hooks)     │──▶│ Resolver     │──▶│  Engine      │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
│         │                 │                  │                       │
│         ▼                 ▼                  ▼                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    RESOLUTION STRATEGIES                      │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ 1. Skill Lookup    → Check existing skills                   │   │
│  │ 2. API Capture     → Reverse engineer the API                │   │
│  │ 3. Browser Agent   → Autonomous browser if no API            │   │
│  │ 4. Tool Generation → Write new tools dynamically             │   │
│  │ 5. Hook Injection  → Add new hooks for automation            │   │
│  │ 6. Desktop Integ   → macOS automation (AppleScript, etc.)    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                               │                                      │
│                               ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    PERSISTENCE LAYER                          │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ • Skills: ~/.clawdbot/skills/{service}/                      │   │
│  │ • Generated Tools: ~/.clawdbot/unbrowse/tools/               │   │
│  │ • Hook Configs: ~/.clawdbot/unbrowse/hooks/                  │   │
│  │ • Config Updates: clawdbot.json                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Files to Modify/Create

### Modify
- `index.ts` — Add new hooks, tool orchestration, capability resolver
- `src/auto-discover.ts` — Extend to detect task intent, not just browser traffic

### Create
- `src/task-watcher.ts` — Observe agent intent via hooks
- `src/capability-resolver.ts` — Decide how to achieve a task
- `src/self-writer.ts` — Generate tools, hooks, skills dynamically
- `src/desktop-automation.ts` — macOS integration (AppleScript, accessibility)
- `src/tool-generator.ts` — Dynamic tool creation from skills/specs
- `src/hook-generator.ts` — Create automation hooks on-the-fly

---

## Implementation Plan

### Phase 1: Task Watcher (Hook Enhancement)

**What it does**: Observe what the agent is trying to accomplish by watching:
- `before_agent_start` — Parse user's intent from prompt
- `before_tool_call` — See which tools agent wants to use
- `after_tool_call` — Detect failures (can we help?)
- `message_sending` — Monitor agent's responses for blockers

**Implementation**:

```typescript
// src/task-watcher.ts
export class TaskWatcher {
  private currentIntent: TaskIntent | null = null;

  // Called from before_agent_start hook
  parseIntent(prompt: string): TaskIntent {
    // Extract: domain (e.g., "twitter"), action (e.g., "post"),
    //          requirements (e.g., "auth needed")
    return {
      domain: extractDomain(prompt),
      action: extractAction(prompt),
      requirements: extractRequirements(prompt),
      rawPrompt: prompt,
    };
  }

  // Called from after_tool_call hook
  detectFailure(toolName: string, result: unknown, error?: string): FailureInfo | null {
    if (error) {
      return { toolName, error, canResolve: this.canWeHelp(error) };
    }
    // Detect soft failures (403, rate limit, auth expired)
    return this.detectSoftFailure(result);
  }

  // Is this something unbrowse can solve?
  canWeHelp(error: string): boolean {
    return (
      error.includes('auth') ||
      error.includes('401') ||
      error.includes('403') ||
      error.includes('not found') ||  // missing capability
      error.includes('tool not available')
    );
  }
}
```

### Phase 2: Capability Resolver

**What it does**: Given a task intent, determine the best way to achieve it.

```typescript
// src/capability-resolver.ts
export class CapabilityResolver {
  async resolve(intent: TaskIntent): Promise<Resolution> {
    // 1. Check existing skills
    const skill = await this.findSkill(intent.domain);
    if (skill) {
      return { strategy: 'skill', skill, confidence: 0.9 };
    }

    // 2. Check if we can capture the API
    const apiAvailable = await this.probeForApi(intent.domain);
    if (apiAvailable) {
      return { strategy: 'capture', domain: intent.domain, confidence: 0.7 };
    }

    // 3. Check desktop automation possibility
    const desktopApp = await this.findDesktopApp(intent.domain);
    if (desktopApp) {
      return { strategy: 'desktop', app: desktopApp, confidence: 0.6 };
    }

    // 4. Fall back to browser agent
    return { strategy: 'browser_agent', confidence: 0.5 };
  }
}
```

### Phase 3: Self-Writer Engine

**What it does**: Actually write the code to achieve the task.

```typescript
// src/self-writer.ts
export class SelfWriter {
  constructor(
    private api: ClawdbotPluginApi,
    private skillsDir: string,
    private toolsDir: string,
  ) {}

  // Generate a new tool from a captured skill
  async generateTool(skill: Skill): Promise<GeneratedTool> {
    const toolCode = this.buildToolFromSkill(skill);
    const toolPath = join(this.toolsDir, `${skill.name}.ts`);

    await writeFile(toolPath, toolCode);

    // Register the tool with clawdbot
    const tool = await import(toolPath);
    this.api.registerTool(tool.default);

    return { name: skill.name, path: toolPath };
  }

  // Generate automation hook for a specific trigger
  async generateHook(trigger: HookTrigger): Promise<GeneratedHook> {
    const hookCode = this.buildHook(trigger);
    const hookPath = join(this.hooksDir, `${trigger.name}.ts`);

    await writeFile(hookPath, hookCode);

    // Register the hook
    this.api.on(trigger.event, (event, ctx) => {
      return eval(hookCode)(event, ctx);
    });

    return { name: trigger.name, path: hookPath };
  }

  // Write new skill from scratch
  async writeSkill(domain: string, endpoints: Endpoint[]): Promise<string> {
    // This already exists in skill-generator.ts
    return generateSkill({ domain, endpoints }, this.skillsDir);
  }
}
```

### Phase 4: Desktop Integration

**What it does**: Control macOS apps when browser/API won't work.

```typescript
// src/desktop-automation.ts
export class DesktopAutomation {
  // Execute AppleScript
  async runAppleScript(script: string): Promise<string> {
    const result = await exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
    return result.stdout;
  }

  // Common app controls
  async openApp(appName: string): Promise<void> {
    await this.runAppleScript(`tell application "${appName}" to activate`);
  }

  async typeText(text: string): Promise<void> {
    await this.runAppleScript(`tell application "System Events" to keystroke "${text}"`);
  }

  // Chrome-specific: get cookies from running browser
  async getChromeCookies(domain: string): Promise<Cookie[]> {
    // Already have this in chrome-cookies.ts
    return fetchBrowserCookies(domain);
  }

  // Read clipboard
  async getClipboard(): Promise<string> {
    return this.runAppleScript('get the clipboard');
  }

  // Window management
  async focusWindow(appName: string, windowTitle?: string): Promise<void> {
    // AppleScript to focus specific window
  }
}
```

### Phase 5: Enhanced Tool Registration

**What it does**: Register a single "do_whatever" meta-tool that orchestrates everything.

```typescript
// In index.ts - new tool
const UNBROWSE_DO_SCHEMA = {
  type: "object" as const,
  properties: {
    task: {
      type: "string" as const,
      description: "What you want to accomplish. Unbrowse will figure out how to do it.",
    },
    domain: {
      type: "string" as const,
      description: "The service/website/app this relates to (e.g., 'twitter', 'linear', 'notion')",
    },
    context: {
      type: "string" as const,
      description: "Additional context about the task",
    },
  },
  required: ["task"],
};

async function unbrowse_do(params: { task: string; domain?: string; context?: string }) {
  const watcher = new TaskWatcher();
  const resolver = new CapabilityResolver();
  const writer = new SelfWriter(api, skillsDir, toolsDir);

  // 1. Parse intent
  const intent = watcher.parseIntent(params.task);
  if (params.domain) intent.domain = params.domain;

  // 2. Resolve capability
  const resolution = await resolver.resolve(intent);

  // 3. Execute based on strategy
  switch (resolution.strategy) {
    case 'skill':
      // Use existing skill
      return await executeSkill(resolution.skill, intent.action);

    case 'capture':
      // Capture the API first, then execute
      const skill = await captureAndLearn(resolution.domain);
      return await executeSkill(skill, intent.action);

    case 'desktop':
      // Use desktop automation
      return await desktopAutomation.execute(resolution.app, intent.action);

    case 'browser_agent':
      // Fall back to autonomous browser
      return await browserAgent.execute(intent);
  }
}
```

### Phase 6: Proactive Hook System

**What it does**: Automatically inject capabilities when agent starts.

```typescript
// Enhanced before_agent_start hook
api.on("before_agent_start", async (event, ctx) => {
  const watcher = new TaskWatcher();
  const resolver = new CapabilityResolver();

  // Parse what the agent is trying to do
  const intent = watcher.parseIntent(event.prompt);

  // Check if we can help
  const resolution = await resolver.resolve(intent);

  // Build enhanced context
  let context = `
## Unbrowse Capabilities Available

You have access to unbrowse_do — a meta-tool that can accomplish almost anything:
- API reverse engineering (automatic)
- Browser automation (when APIs fail)
- Desktop app control (macOS)
- Credential management (auto-login)

**For this task, unbrowse suggests**: ${resolution.strategy}
`;

  if (resolution.skill) {
    context += `
**Existing skill available**: ${resolution.skill.name}
Endpoints: ${resolution.skill.endpoints.map(e => e.method + ' ' + e.path).join(', ')}
`;
  }

  return { prependContext: context };
});
```

### Phase 7: Self-Healing on Failure

**What it does**: When tools fail, automatically try to fix.

```typescript
// Enhanced after_tool_call hook
api.on("after_tool_call", async (event, ctx) => {
  const watcher = new TaskWatcher();

  // Check for failure
  const failure = watcher.detectFailure(event.toolName, event.result, event.error);

  if (failure && failure.canResolve) {
    // Attempt to fix
    if (failure.error.includes('401') || failure.error.includes('auth')) {
      // Re-authenticate
      logger.info(`[unbrowse] Detected auth failure, attempting re-auth...`);
      await reauthenticate(event.toolName, event.params);
    }

    if (failure.error.includes('tool not available')) {
      // Try to generate the missing tool
      logger.info(`[unbrowse] Missing tool detected, attempting to generate...`);
      await generateMissingTool(failure.error);
    }
  }

  // Continue auto-discovery
  if (event.toolName?.startsWith("browser")) {
    await discovery.onBrowserToolCall();
  }
});
```

---

## New Tools Summary

| Tool | Purpose |
|------|---------|
| `unbrowse_do` | Meta-tool: "do whatever it takes" to accomplish a task |
| `unbrowse_generate_tool` | Create a new tool from a skill or spec |
| `unbrowse_desktop` | macOS desktop automation (AppleScript, accessibility) |
| `unbrowse_inject_hook` | Add a new automation hook at runtime |

---

## Data Flow

1. **User sends message** → `before_agent_start` hook
2. **Unbrowse parses intent** → TaskWatcher extracts domain/action
3. **Capability resolution** → Find skill, or decide how to acquire it
4. **Context injection** → Tell agent what's available
5. **Agent uses tools** → `before_tool_call` / `after_tool_call` hooks
6. **Failure detection** → If tool fails, unbrowse tries to help
7. **Auto-learning** → Browser activity generates skills automatically
8. **Persistence** → Skills, tools, hooks saved for future sessions

---

## Edge Cases & Considerations

1. **Security**: Generated tools run with full permissions — need sandboxing for untrusted skills
2. **Loops**: Prevent infinite loops where unbrowse tries to fix itself fixing itself
3. **Rate limits**: Don't auto-retry too aggressively
4. **Cost**: Stealth browser costs money — make it opt-in for heavy use
5. **Privacy**: Don't capture sensitive credentials without consent

---

## Success Criteria

- [ ] Agent can ask "post a tweet" and unbrowse figures out how (capture API, login, execute)
- [ ] Agent can ask "create a Linear ticket" and unbrowse auto-discovers Linear's API
- [ ] When a tool fails with 401, unbrowse automatically re-authenticates
- [ ] Skills learned in one session are available in the next
- [ ] Desktop apps (Finder, Notes, etc.) can be controlled when web won't work
- [ ] New tools can be generated at runtime without gateway restart

---

---

## Integration with Unlearn Extension

The meta-learning and research capabilities have been moved to the **unlearn** extension (`/Users/lekt9/Projects/aiko/extensions/unlearn`).

**unbrowse** focuses on:
- Browser/API capture and skill generation
- Credential management and replay
- Desktop automation

**unlearn** handles:
- Research from arXiv, GitHub, docs
- Technique extraction and implementation
- Self-reinforcement loop
- Code generation (tools, hooks, skills)

The two extensions communicate via the shared clawdbot plugin system:
- unlearn can improve unbrowse's techniques over time
- unbrowse's successes/failures feed into unlearn's reinforcement loop

---

## Questions for Clarification

None — proceeding with implementation.
