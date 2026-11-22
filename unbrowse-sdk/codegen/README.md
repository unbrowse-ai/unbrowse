# The SDKs' generated layers

The node writes its API to `unbrowse-node/agent-api.json` from its own registries: the agent primitives, each with the
description MCP lists it with (`PRIMITIVES` in `app/src/api.rs`), the owner's commands (`OWNER_COMMANDS` in `app/src/commands.rs`) and the records
they answer (`app/src/apischema.rs`). `generate.py` writes from that file what can be written mechanically, so the SDKs
can't drift from what the node runs:

| File | What it holds |
|---|---|
| `unbrowse-sdk/typescript/src/generated.ts` | The node's records as wire types (snake case, exactly as the schemas say), the agent primitives' requests (`primitiveRequest`), and `OwnerCommands`, the base `UnbrowseOwner` extends, with one method per owner command |
| `unbrowse-sdk/python/src/unbrowse/_generated.py` | The same for Python: TypedDicts, `primitive_request`, and `OwnerCommands` |
| `unbrowse-node/window/src/wire.zig` | The node's window's reading of every record (each field defaulted, so a field the node leaves out takes its default and one it adds is ignored; numbers as `f64`; an inline object as a struct nested in its holder; an object the node may leave out optional), every owner command (`Command`), and what each answers and takes (`Returns`, `Input`). The window's `types.zig` keeps its own views, the fields a screen reads with the defaults it shows before an answer, and `zig build test` holds each to its node type: a field the window reads that the node never sends, or sends as another kind, or may send as null into a field that isn't optional, fails the build naming it |
| `unbrowse-sdk/typescript/src/adapters/tools.ts`, `unbrowse-sdk/python/src/unbrowse/adapters/_tools.py` | Each agent primitive as a framework tool: the MCP server's name, description and input schema, which the LangChain, Vercel AI SDK, Mastra and OpenAI Agents adapters make their tools from. Each description opens with a line on when to use the tool (`WHEN` in `generate.py`), so a model calls it before writing a scraper, opening a browser or saying a site can't be read |

**Generated files are never edited by hand.** A change to what the node takes or answers is made in the node's
registries; then:

```bash
cd unbrowse-node && UNBROWSE_WRITE_AGENT_API=1 cargo test -p unbrowse-node-app the_agent_api_manifest_is_current
cd .. && python3 unbrowse-sdk/codegen/generate.py   # or: cd unbrowse-sdk/typescript && npm run gen
```

`--check` writes nothing and fails, naming each stale file; CI runs it (`npm run gen:check` does the same). `--spec`
reads another manifest, to see what a change would write. The generator needs Python 3.9+ and nothing else, and
writes the same bytes every run.

The hand-written clients sit on top: `client.ts`/`client.py` keep the agent API's friendly camel case (TypeScript) and
dataclasses (Python), reading the wire types, so a field the node renames fails to compile rather than reading as
undefined; `owner.ts`/`owner.py` add the live events, a walk's picture and a few friendlier forms to the generated
methods.

When `agent-api.json` changes on main, the **SDK polish** workflow (`.github/workflows/sdk-polish.yml`) runs the
generator and has Claude draft the rest in a pull request: friendlier methods where a new primitive or command
deserves one, the READMEs' tables, and the unbrowse skill. It never pushes to main, and never edits a generated file.
