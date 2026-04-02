# Chrome Extensions in Kuri

Kuri can install, manage, and load Chrome extensions — from the Chrome Web Store or local directories. Extensions run inside Chrome and are fully functional: content scripts inject into pages, service workers run in the background, and popups are accessible via CDP.

## Quick Start

```bash
# Install an extension by Chrome Web Store ID
kuri-agent ext install eimadpbcbfnmbkopoojfekhnkhdbieeh   # Dark Reader

# Or by full Chrome Web Store URL
kuri-agent ext install "https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh"

# Launch Chrome with extensions loaded
KURI_EXTENSIONS=$(kuri-agent ext path) kuri-agent open

# That's it — extensions are active
```

## Commands

| Command | Description |
|---------|-------------|
| `kuri-agent ext install <id-or-url>` | Download + extract from Chrome Web Store |
| `kuri-agent ext list` | List installed extensions |
| `kuri-agent ext remove <id>` | Remove an installed extension |
| `kuri-agent ext path` | Print comma-separated paths for `KURI_EXTENSIONS` |

## How It Works

### Install flow

1. Downloads the CRX3 file from Google's update server
2. Strips the CRX header (12 + header_size bytes) to get the ZIP
3. Extracts to `~/.kuri/extensions/<id>/`
4. Removes `_metadata/` directory (Chrome rejects CRX signature verification on unpacked extensions)
5. Removes `key` field from manifest.json if present (prevents ID mismatch on sideload)

### Loading extensions

Extensions are loaded via Chrome's `--load-extension` and `--disable-extensions-except` flags. Set `KURI_EXTENSIONS` to a comma-separated list of extension directories:

```bash
# Single extension
KURI_EXTENSIONS=~/.kuri/extensions/eimadpbcbfnmbkopoojfekhnkhdbieeh kuri-agent open

# Multiple extensions
KURI_EXTENSIONS=~/.kuri/extensions/ext1,~/.kuri/extensions/ext2 kuri-agent open

# All installed extensions
KURI_EXTENSIONS=$(kuri-agent ext path) kuri-agent open
```

Both `kuri-agent open` and the `kuri` HTTP server respect `KURI_EXTENSIONS`.

### Builtin extension

Kuri ships a builtin extension (`js/extensions/kuri-builtin/`) that is automatically loaded on every launch:

- **Stealth**: patches `navigator.webdriver`, plugins, languages (runs at `document_start` before page JS)
- **Agent bridge**: exposes `window.__kuri` for bidirectional communication
- **Network observer**: background service worker captures all requests via `chrome.webRequest` for HAR recording

The builtin extension is embedded in the binary via `@embedFile` and extracted to `~/.kuri/builtin-ext/` at startup.

## Important Notes

### Fresh profiles

Chrome caches extension state in the profile. If you add or remove extensions, use a fresh profile:

```bash
rm -rf ~/.kuri/chrome-profile
KURI_EXTENSIONS=$(kuri-agent ext path) kuri-agent open
```

### Extension compatibility

| Type | Works | Notes |
|------|-------|-------|
| MV3 with plain service worker | Yes | Dark Reader, uBlock Origin |
| MV3 with ES module service worker | No | Phantom — Chrome limitation with `--load-extension` |
| MV2 with background page | Yes | Legacy extensions |
| Content scripts (MAIN world) | Yes | Stealth patches, page modification |
| Content scripts (ISOLATED world) | Varies | Some need manual triggering |

### Reading extension data via kuri-agent

Extensions modify pages — you can observe their effects:

```bash
# Check if an extension modified the page
kuri-agent eval "getComputedStyle(document.body).backgroundColor"
# → "rgb(238, 238, 238)"  (Dark Reader changed it from white)

# Check for injected providers (wallet extensions)
kuri-agent eval "typeof window.ethereum"

# Screenshot to see visual changes
kuri-agent shot --out page.png
```

### Interacting with extension popups

Extension popup pages can be opened as tabs and driven with kuri-agent:

```bash
# The extension gets a Chrome-assigned ID when sideloaded
# Find it from the CDP target list:
curl -s http://127.0.0.1:9222/json | python3 -c "
import json, sys
for t in json.load(sys.stdin):
    if 'service_worker' in t['type']:
        eid = t['url'].split('://')[1].split('/')[0]
        print(f'Extension ID: {eid}')
"

# Open the popup in a new tab
kuri-agent eval "window.open('chrome-extension://EXT_ID/popup.html')"

# Switch to it and interact
kuri-agent use <popup-ws-url>
kuri-agent snap --interactive
kuri-agent click @e3
```

## Architecture

```
ext install <id>
  │
  ├─ curl → CRX3 download from Chrome Web Store
  ├─ strip CRX header → ZIP
  ├─ unzip → ~/.kuri/extensions/<id>/
  ├─ rm _metadata/ (signature verification)
  └─ rm manifest.json key field (ID mismatch)

KURI_EXTENSIONS=<paths>
  │
  ├─ kuri-agent open → --load-extension=<paths>
  │                   → --disable-extensions-except=<paths>
  │
  └─ kuri (HTTP server) → launcher.zig extracts builtin ext
                         → prepends to extension list
                         → launches Chrome with all extensions
```
