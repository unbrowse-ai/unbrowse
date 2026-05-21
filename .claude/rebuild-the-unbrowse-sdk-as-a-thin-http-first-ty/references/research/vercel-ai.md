# Vercel AI SDK — provider client pattern

source_id: github.com/vercel/ai
deepwiki: https://deepwiki.com/vercel/ai
fetched: 2026-05-21

## Provider factory pattern
`const openai = createOpenAI({ apiKey, fetch })`. Returns a callable that takes a model id.

## API key
- `apiKey` in settings; falls back to env. Helper `loadApiKey` from `@ai-sdk/provider-utils`.

## Fetch abstraction
- Custom `fetch: (input, init) => Promise<Response>` injectable.
- Standard Web Fetch signature; works as middleware.
- Used in tests + observability tooling.

## Errors
- `InvalidArgumentError`, `NoSuchModelError` from `@ai-sdk/provider`.

## Takeaways for Unbrowse
- `create*` factory pattern is overkill for our single-service SDK; stick with `new Unbrowse(...)`.
- **fetch-as-middleware** is gold. Expose it so power users wrap our fetch for tracing, mocks, header rewrites.
- Multi-tenant factory shape (`createUnbrowse({apiKey, tenant})`) may emerge later for foundry; deferred.
