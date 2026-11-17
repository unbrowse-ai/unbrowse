# unbrowse-core

Everything in the node that touches key material. The window and agents only ever get public values from here, such as
the wallet address.

| Module | What it holds |
|---|---|
| `identity` | The root key: a secp256k1 key made on the device, kept in the OS keystore, and the address it signs as |
| `keystore` | Where the root key lives: the macOS Keychain (`KeychainStore`), a user-only file for dev builds (`FileStore`), memory for tests |
| `derive` | Keys derived from the root key by index (agent keys, the vault key), so none of them is stored |
| `vault` | Cards for the payment step of a purchase route |

Secret buffers are zeroed on drop (`zeroize`).

```bash
cargo test -p unbrowse-core
cargo test -p unbrowse-core -- --ignored   # also the real Keychain (asks macOS for access)
```

## Licence

[Apache-2.0](../../../LICENSE).
