# Unbrowse Development Backlog

Task list for parallel agent development. Agents pick tasks from here.
Status tracked in Claude Code TaskList.

## Bugs

- [ ] Fix generateVersionHash replacer bug (skill-generator.ts) — Object.keys as JSON.stringify replacer produces same hash for all inputs. Fix: use null as replacer.

## Test Coverage (29 files untested)

### Priority 1 — Pure functions
- [ ] auth-extractor.ts (202 lines)
- [ ] skill-sanitizer.ts (76 lines)
- [ ] endpoint-tester.ts (173 lines)
- [ ] workflow-types.ts (271 lines)

### Priority 2 — Logic-heavy
- [ ] credential-providers.ts (459 lines)
- [ ] vault.ts (272 lines)
- [ ] success-tracker.ts (410 lines)
- [ ] task-watcher.ts (325 lines)
- [ ] reasoning-prompts.ts (806 lines)

### Priority 3 — Integration
- [ ] traffic-interceptor.ts (732 lines)
- [ ] skill-index.ts (710 lines)
- [ ] workflow-learner.ts (822 lines)
- [ ] workflow-executor.ts (693 lines)
- [ ] workflow-recorder.ts (324 lines)

### Priority 4 — Browser-dependent
- [ ] profile-capture.ts (383 lines)
- [ ] cdp-capture.ts (328 lines)
- [ ] session-login.ts (419 lines)
- [ ] dom-service.ts (430 lines)
- [ ] openclaw-browser.ts (271 lines)
- [ ] desktop-automation.ts (457 lines)
- [ ] chrome-cookies.ts (245 lines)
- [ ] har-capture.ts (205 lines)
- [ ] otp-watcher.ts (569 lines)
- [ ] site-crawler.ts (354 lines)
- [ ] auto-discover.ts (182 lines)
- [ ] browser-replay.ts (196 lines)
- [ ] capability-resolver.ts (303 lines)
- [ ] agentic-analyzer.ts (2,093 lines)

## Code Quality

- [ ] Audit and remove dead exports across source files
- [ ] Coalesce auth detection patterns (auth-extractor, endpoint-analyzer, har-parser)
- [ ] Decompose index.ts (5,510 lines) into sub-modules
- [ ] Standardize error handling (replace empty catch {} blocks)

## Features

- [ ] Complete endpoint-prober integration with skill generation
- [ ] Integrate agentic-analyzer with main workflow
- [ ] Add schema-inferrer deep mode for nested objects
