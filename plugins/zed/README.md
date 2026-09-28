# Unbrowse MCP Server for Zed

A [Zed](https://zed.dev) context server extension (id `mcp-server-unbrowse`) that gives the Agent Panel the Unbrowse tools: read any page as markdown (`unbrowse_scrape`), find a site's API routes (`unbrowse_discover`), run a website task as an API call (`unbrowse_run`), and drive a cloud browser when a site needs one (`unbrowse_browse_*`).

The extension installs the [`unbrowse`](https://www.npmjs.com/package/unbrowse) npm package (pinned, MIT) with Zed's own Node and starts `unbrowse mcp`, a stdio proxy to the hosted Unbrowse MCP. Pages and site tasks run in Unbrowse's cloud.

## Install

1. Zed → Extensions → search **Unbrowse MCP Server** → Install.
2. Get an API key (starts with `ub_live_`, free tier) at [unbrowse.ai/app](https://unbrowse.ai/app).
3. Paste it in the configuration modal, or in `settings.json`:

```json
{
  "context_servers": {
    "mcp-server-unbrowse": {
      "settings": {
        "unbrowse_api_key": "ub_live_..."
      }
    }
  }
}
```

Prefer no extension? Zed can add the remote server directly: Agent Panel → Settings → Add Custom Server → `https://unbrowse.ai/mcp` (OAuth).

## Develop

```sh
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2
cargo fmt --check && cargo clippy --target wasm32-wasip2 -- -D warnings
```

Test in Zed: Extensions → **Install Dev Extension** → pick `plugins/zed`, set the key, then open the Agent Panel and check the server's dot turns green and the `unbrowse_*` tools are listed. `zed --foreground` shows the extension's logs.

Release: bump `version` in `extension.toml` (and `PACKAGE_VERSION` in `src/mcp_server_unbrowse.rs` to move the npm pin), merge, then PR the new version to [zed-industries/extensions](https://github.com/zed-industries/extensions) `extensions.toml` with the submodule at the merged commit.
