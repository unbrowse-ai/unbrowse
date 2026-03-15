# Contributors

Thank you to everyone who has contributed to Agentic Browdie! 🧁

## Core Team

- **[@justrach](https://github.com/justrach)** — Creator, architecture, project lead

## How to Contribute

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create a feature branch** — `git checkout -b feature/your-feature`
3. **Make your changes** — follow existing code conventions (Zig style, doc comments, inline tests)
4. **Run tests** — `zig build test` must pass with zero failures
5. **Submit a PR** — describe what you changed and why

### Guidelines

- **Memory safety first** — every allocation must have a corresponding `deinit` or arena free
- **Test everything** — add inline tests for new functions, integration tests for new endpoints
- **Keep it lean** — no external dependencies; everything is pure Zig + std
- **Doc comments** — public functions need `///` doc comments
- **No GC, no leaks** — run with `GeneralPurposeAllocator` in debug mode to catch leaks

### Areas Looking for Help

- 🔌 CDP event streaming (async Network domain events for HAR)
- 🌐 Full crawler pipeline implementation
- 📦 Kafka/R2 storage backends
- 🧪 More integration tests with real Chrome
- 📖 Documentation and examples
- 🐧 Linux CI/CD setup

## Acknowledgments

Agentic Browdie is inspired by:

- **[Pinchtab](https://github.com/pinchtab/pinchtab)** — Browser control for AI agents (Go)
- **[Pathik](https://github.com/justrach/pathik)** — High-performance web crawler (Go)
- **[agent-browser](https://github.com/vercel-labs/agent-browser)** — Vercel's agent-first browser automation — `@eN` ref system, snapshot diffing, HAR recording patterns
