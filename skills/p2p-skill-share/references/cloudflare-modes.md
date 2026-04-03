# Cloudflare Tunnel Modes

Use this file to pick the right relay mode for skill sharing.

## Quick Tunnel

- command shape: `wrangler tunnel quick-start http://127.0.0.1:<port>`
- account requirement: no Cloudflare account required
- characteristics: temporary, anonymous, random `*.trycloudflare.com` URL
- use when: one-off sharing, testing, demos

Docs:

- [Wrangler tunnel quick-start](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/)

## Named Tunnel

- command shape: `wrangler tunnel run <name>` or token-backed `wrangler tunnel run --token <token>`
- account requirement: yes, the tunnel owner needs a Cloudflare account and configured tunnel
- characteristics: stable, configurable, suitable for repeated sharing
- use when: recurring peer transfers, controlled access, repeatable endpoint

Docs:

- [Set up Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/)
- [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)

## Design Rule

- this is Cloudflare-relayed, not direct peer-to-peer
- the tunnel is only the transport; the share unit is still a local file bundle plus manifest
