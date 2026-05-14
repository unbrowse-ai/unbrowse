// Backend test setup — preloaded via backend/bunfig.toml.
// Mirrors root tests/_setup.ts. Bun does not honor relative `..`
// paths in bunfig preload, so we keep a local copy here.
process.env.UNBROWSE_INLINE_INDEX ??= "1";
process.env.UNBROWSE_NO_SWEEP ??= "1";
