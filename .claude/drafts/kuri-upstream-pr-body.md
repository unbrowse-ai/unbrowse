## Windows port for kuri

Brings kuri up on Windows (x86_64) so it can drive Chrome over CDP there, plus a
stateless C-ABI shared library for in-process embedding. Developed against the
downstream consumer; offered back upstream.

### What's included
- **winsock CDP transport** — `compat.TcpStream` over winsock so the Chrome
  CDP HTTP probe + WebSocket transport work on Windows; `discoverTabs` and
  startup complete.
- **Chrome discovery on Windows** — locate Chrome under `Program Files` +
  `%LOCALAPPDATA%`.
- **Zig 0.16 Windows ABI fixes** — migrate `cwd*File` from `std.c.open` to
  `std.Io.Dir`; batch-port the remaining `std.c`-touching files.
- **stateless C-ABI shared library** (`feat(ffi)`) — link kuri as a shared lib
  for in-process embedding (no separate process), cross-compiled for
  `x86_64-windows`.

### Notes
- ~13 commits; happy to squash or split per your preference.
- Linux/macOS paths unchanged (the winsock paths are `compat`-gated).
