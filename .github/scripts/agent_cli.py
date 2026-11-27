#!/usr/bin/env python3
"""The one place CI asks a model, and one switch between the CLIs that do it.

CI calls this exactly as it used to call Claude Code — `-p "<prompt>" --output-format stream-json …` — and this
answers in the same shape either way (a `result` object with `result`, `total_cost_usd`, `num_turns`, `usage`, or the
same lines streaming, tool calls included), so every reader of it (`qa/costs.py`, `qa/tool_choice.py`,
`qa/skill_trigger.py`, `test-banks/gate/run_gate.py`, the workflows' `jq`, the dashboards) is unchanged.

    AGENT_CLI=claude    (default) try the pinned Claude CLI with the argv untouched. When its answer is the
                        account refusing — a short `is_error` that spent no tokens and names a weekly limit, a
                        credit balance or usage credits, or those words with no JSON — the same argv runs through
                        opencode on AGENT_MODEL (or DEFAULT_MODEL). A real answer, and a real error that spent
                        tokens, stays Claude's. The log names the refusal and the model opencode runs.
    AGENT_CLI=opencode  run the same job through `opencode run`, with the things the Claude CLI takes as flags but
                        opencode has none for enforced here instead, because dropping them would loosen a check:

                        --max-turns N        stop after N steps
                        --max-budget-usd X   no dollars on a subscription: this caps BILLED TOKENS at AGENT_MAX_TOKENS
                                             (input + cache-write + output, which is what a run costs), default
                                             AGENT_MAX_TOKENS=2000000. The first cap was 224,782 — double the
                                             heaviest Claude session CI had measured (112,391) — until a one-word
                                             answer on opencode measured 89,050 input tokens: it loads the repo's
                                             agent guide and the tool schemas on every run, so a session of twenty
                                             turns is past that. Lewis raised it to 2M on 24 Nov 2026.
                        --tools/--allowedTools/--disallowedTools   written as opencode 2.x's ordered permission
                                             rules. --allowedTools is a closed set in Claude, and opencode's base
                                             policy allows everything, so a closed set is a deny-all rule first and
                                             the allowed ones after it. A name with a pattern (`Read(/tmp/**)`) is
                                             that action with the pattern for its resource. MCP tools are
                                             `<server>_<tool>` in 2.x, `<server>_*` for a whole server. `write` and
                                             `edit`/`patch` share 2.x's `edit` action.
                        --mcp-config         `mcp.servers`, the shape 2.x reads, in a config of the run's own
                                             (`OPENCODE_CONFIG`, never the shared checkout), asked through a private
                                             server (`--standalone`); each server's tools are queried
                                             (tools/list) for the init event, so a run whose server never answered
                                             says so instead of claiming the tools.
                        --strict-mcp-config  use a private home and disable project config discovery so only the
                                             explicitly supplied MCP servers are loaded.
                        --system-prompt      like --append-system-prompt: comes before the prompt.
                        --no-session-persistence   `--archived`, so a CI run stays out of the list.
                        --setting-sources project   OpenCode discovers project config unless strict MCP is set.
                        --model              a name with a provider (`provider/model`) is carried over; a bare Claude
                                             alias (`sonnet`) is Claude's vocabulary and becomes AGENT_MODEL, and the
                                             log and the job summary say so. A Claude model is refused outright:
                                             Claude runs through Claude Code only, never opencode (Steve's rule, 24
                                             Nov 2026, UNB-248). No AGENT_MODEL falls back to DEFAULT_MODEL, said
                                             the same way, and a flash model is named as one wherever it came from.

                        The stream is the readers' shape: `system/init` with the tools in hand, `assistant` with
                        `text` and `tool_use` blocks, `user` with `tool_result` blocks, then `result`. An event this
                        script doesn't know is not silently swallowed: an opencode `error` (a provider with no
                        route, a credential refused) reaches the log and the answer, and a stop it decided itself
                        is named on stderr as well as in the answer, because stdout is a file in CI.

A flag that cannot be honoured exactly is refused by name, never quietly dropped.
"""
from __future__ import annotations

import base64
import fcntl
import http.client
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

BILLED_TOKENS_DEFAULT = 2_000_000
# The repository variable AGENT_MODEL names the same model; a run without it says it fell back here (UNB-248: 23-24 Nov
# 2026 QA ran on a flash model nobody had chosen for it).
DEFAULT_MODEL = "opencode-go/deepseek-v4-pro"
SUBSCRIPTION_MODEL = "openai/gpt-6.2-sol#ultrafast-high"
MODEL_KEYS = ("OPENAI_API_KEY", "OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")
# A gated model is not in the public registry opencode resolves a name against: OrcaRouter gives a key 229 models and the
# world 213, and its security models (OrcaCyber Zero 1.5) are among the gated ones, so opencode says "Model unavailable"
# before it sends anything. Declare the router and the model in the config this script writes, with the key the step
# holds, and the name runs. `baseURL` is the router's OpenAI-compatible endpoint.
ROUTERS = {
    "orcarouter": {
        "name": "OrcaRouter",
        "npm": "@ai-sdk/openai-compatible",
        "baseURL": "https://api.orcarouter.ai/v1",
        "key": "ORCAROUTER_API_KEY",
        "models": {
            "orca/orcacyber-zero-1.5": {
                "name": "OrcaCyber Zero 1.5 (OrcaRouter)",
                "limit": {"context": 1_000_000, "output": 32_768},
                "tool_call": True,
                "reasoning": True,
            },
        },
    },
}
CLAUDE_FAMILIES = ("claude", "sonnet", "opus", "haiku", "fable")

# Claude's tool name to opencode 2.x's permission action. 2.x folds write and patch into `edit`, calls bash `shell`
# and task `subagent`; a name it doesn't know is carried as its own action.
ACTION = {
    "read": "read", "grep": "grep", "glob": "glob",
    "edit": "edit", "write": "edit", "notebookedit": "edit", "patch": "edit",
    "bash": "shell", "shell": "shell",
    "webfetch": "webfetch", "websearch": "websearch",
    "task": "subagent", "agent": "subagent", "subagent": "subagent",
    "skill": "skill", "todowrite": "todowrite",
}

# opencode's tool name to Claude's, for the stream every reader was written against.
CLAUDE_NAME = {
    "read": "Read", "grep": "Grep", "glob": "Glob", "edit": "Edit", "write": "Write", "patch": "Edit",
    "shell": "Bash", "bash": "Bash", "webfetch": "WebFetch", "websearch": "WebSearch",
    "task": "Task", "subagent": "Task", "skill": "Skill", "todowrite": "TodoWrite", "notebook": "NotebookEdit",
}

# What a Claude session has when no allow list narrows it, for the init event a disallow list leaves open.
DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Skill",
                 "TodoWrite", "NotebookEdit"]

# Flags this script understands; anything else Claude-specific and unhonourable is refused.
FLAGS_WITH_VALUE = {
    "-p", "--print", "--output-format", "--mcp-config", "--tools", "--allowedTools", "--disallowedTools",
    "--max-turns", "--max-budget-usd", "--append-system-prompt", "--system-prompt", "--model", "--setting-sources",
    "--agents",
}
FLAGS_BARE = {"--verbose", "--strict-mcp-config", "--no-session-persistence"}


def claude_bin() -> str:
    named = os.environ.get("CLAUDE_BIN")
    # The gate bank execs its CLAUDE_BIN for every run, and that is this wrapper: in claude mode it still runs the
    # pinned CLI, never itself.
    if named and os.path.abspath(named) != os.path.abspath(__file__):
        return named
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(here, "tools", "claude-cli", "node_modules", ".bin", "claude")


def parse(argv: list[str]) -> dict:
    """The argv as the few things this script needs, and the refusal for anything it cannot honour."""
    out = {"prompt": "", "stream": False, "mcp": None, "tools": None, "allowed": None, "disallowed": None,
           "max_turns": None, "tokens": None, "system": None, "model": None, "passive": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        key = a.split("=", 1)[0]
        value = a.split("=", 1)[1] if "=" in a else None
        if key in FLAGS_WITH_VALUE:
            if value is None:
                i += 1
                value = argv[i] if i < len(argv) else ""
            if key in ("-p", "--print"):
                out["prompt"] = value
            elif key == "--output-format":
                out["stream"] = value == "stream-json"
            elif key == "--mcp-config":
                out["mcp"] = value
            elif key == "--tools":
                out["tools"] = [t.strip() for t in value.split(",") if t.strip()]
            elif key == "--allowedTools":
                out["allowed"] = [t.strip() for t in value.split(",") if t.strip()]
            elif key == "--disallowedTools":
                out["disallowed"] = [t.strip() for t in value.split(",") if t.strip()]
            elif key == "--max-turns":
                out["max_turns"] = int(value)
            elif key == "--max-budget-usd":
                out["tokens"] = int(os.environ.get("AGENT_MAX_TOKENS") or BILLED_TOKENS_DEFAULT)
            elif key in ("--append-system-prompt", "--system-prompt"):
                out["system"] = f"{out['system']}\n\n{value}" if out["system"] else value
            elif key == "--model":
                out["model"] = value
            elif key == "--setting-sources":
                if value.strip() != "project":
                    raise SystemExit(f"agent_cli: --setting-sources {value!r} is not carried over; only 'project' is")
            elif key == "--agents":
                raise SystemExit("agent_cli: --agents has no equivalent in opencode; say which agent with --agent")
        elif a in FLAGS_BARE:
            out["passive"].append(a)
        elif a.startswith("-"):
            raise SystemExit(f"agent_cli: {a} is not carried over to opencode; add the mapping or run this job on claude")
        else:
            out["prompt"] = (out["prompt"] + " " + a).strip()
        i += 1
    if not out["prompt"]:
        raise SystemExit("agent_cli: no prompt (-p)")
    return out


def target(tool: str) -> tuple[str, str]:
    """One Claude tool name as opencode 2.x's (action, resource): `Bash` is shell on *, `Read(/tmp/**)` is read on
    `/tmp/*`, `mcp__unbrowse__do` is the `unbrowse_do` action and `mcp__unbrowse` its server's tools."""
    t = tool.strip()
    resource = "*"
    if "(" in t and t.endswith(")"):
        name, _, pattern = t[:-1].partition("(")
        resource = pattern.replace("**", "*")
    else:
        name = t
    low = name.strip().lower()
    if low.startswith("mcp__"):
        parts = low.split("__")
        if len(parts) >= 3:
            return f"{parts[1]}_{'__'.join(parts[2:])}", resource
        return f"{parts[1]}_*", resource
    return ACTION.get(low, low), resource


def rules(args: dict) -> list[dict]:
    """The permission rules opencode 2.x reads, in its order: last match wins, so a deny list comes after an allow."""
    def bare(tool: str) -> str:
        return tool.partition("(")[0].strip().lower()

    allowed = []
    for t in args["allowed"] or []:
        action, resource = target(t)
        allowed.append((action, resource, bare(t)))
    out: list[dict] = []
    if args["allowed"] is not None:
        # Claude's allow list is a closed set and 2.x's base policy allows everything: deny first, then allow.
        out.append({"action": "*", "resource": "*", "effect": "deny"})
        # The wildcard does not take Code Mode away (2.4.1 still offers `execute`, and it has run JS under a
        # Skill-only set): a closed set names it, so the tools in hand are the named ones.
        if not any(a == "execute" for a, _, _ in allowed):
            out.append({"action": "execute", "resource": "*", "effect": "deny"})
        seen = set()
        for action, resource, _ in allowed:
            if (action, resource) not in seen:
                out.append({"action": action, "resource": resource, "effect": "allow"})
                seen.add((action, resource))
    for t in args["disallowed"] or []:
        action, resource = target(t)
        # 2.x folds edit/write/patch into one `edit` action, where Claude has three tools: QA and the autofix allow
        # Write and deny Edit, and denying the shared action wholesale would make the allow meaningless. A sibling's
        # allow governs the action; a deny of a path still applies to that path.
        if resource == "*" and any(a == action and name != bare(t) for a, _, name in allowed):
            continue
        out.append({"action": action, "resource": resource, "effect": "deny"})
    return out


def mcp_servers(args: dict) -> dict:
    if not args["mcp"]:
        return {}
    try:
        return json.load(open(args["mcp"]))["mcpServers"]
    except (OSError, ValueError, KeyError) as e:
        raise SystemExit(f"agent_cli: --mcp-config {args['mcp']} is not an MCP config ({e})")


def name_each_server_tool(args: dict, servers: dict) -> None:
    """A server prefix in the allow list becomes each tool that server lists.

    Claude's `mcp__unbrowse` means that server's tools. opencode 2.4.1 stores the prefix as the action `unbrowse_*`.
    With nothing denied after it, the tools are offered (tool choice on PR agent checks 45572219035 called
    `unbrowse_do`). Once that closed set also denies the shell and the skill, the same prefix offers nothing: the
    gate's clients on that run said no unbrowse tool was exposed, while the QA job, which names each tool, called
    the node. An exact action is what that QA job allows. A prefix whose server lists nothing stays a prefix, and
    the log says so.
    """
    allowed = args.get("allowed")
    if not allowed or not servers:
        return
    said: list[str] = []
    by_server: dict[str, list[str]] = {}
    for name in mcp_tools(servers, said):
        parts = name.split("__")
        if len(parts) >= 3:
            by_server.setdefault(parts[1], []).append(name)
    out: list[str] = []
    for tool in allowed:
        bare = tool.partition("(")[0].strip()
        parts = bare.lower().split("__")
        if bare.lower().startswith("mcp__") and len(parts) == 2:
            found = by_server.get(parts[1])
            if found:
                out.extend(found)
                continue
            print(f"::warning::agent_cli: {bare} listed no tools; the prefix stands", file=sys.stderr, flush=True)
        out.append(tool)
    args["allowed"] = out


def opencode_config(args: dict, servers: dict, model: str) -> str:
    """The config this run needs, in a folder of its own, handed to the child as `OPENCODE_CONFIG`. Runs side by side
    share the checkout they run in, so a config written there is another run's, or gone once the run that wrote it
    ends (the gate's slice runs three clients at once: they came up with no MCP tool at all, PR agent checks
    45328727914)."""
    name_each_server_tool(args, servers)
    cfg: dict = {"update": "disable", "snapshots": False, "formatter": False}
    if model == SUBSCRIPTION_MODEL:
        cfg["providers"] = {"openai": {"models": {"gpt-6.2-sol": {"variants": [{
            "id": "ultrafast-high",
            "settings": {"reasoningEffort": "high"},
            "body": {"service_tier": "ultrafast", "store": False},
        }]}}}}
        # The Responses endpoint accepts a delegated OAuth bearer for ChatGPT plan usage.
        cfg["providers"]["openai"]["settings"] = {"baseURL": "https://api.openai.com/v1"}
        cfg["agents"] = {"title": {"disabled": True}, "compaction": {"model": model}}
    router = ROUTERS.get(model.split("/", 1)[0])
    if router and model.split("/", 1)[1] in router["models"]:
        cfg.setdefault("providers", {})[model.split("/", 1)[0]] = {
            "npm": router["npm"],
            "name": router["name"],
            "settings": {"baseURL": router["baseURL"], "apiKey": "{env:" + router["key"] + "}"},
            "models": {model.split("/", 1)[1]: router["models"][model.split("/", 1)[1]]},
        }
    mcp_servers = {}
    for name, server in servers.items():
        environment = server.get("env", {})
        command = [server["command"], *server.get("args", [])]
        if model == SUBSCRIPTION_MODEL and "OPENAI_API_KEY" not in environment:
            # OpenCode's local MCP launcher inherits the model process's environment.
            command = ["/usr/bin/env", "-u", "OPENAI_API_KEY", *command]
        mcp_servers[name] = {"type": "local", "command": command, "environment": environment, "enabled": True}
    cfg["mcp"] = {"servers": mcp_servers}
    permission = rules(args)
    if permission:
        cfg["permissions"] = permission
    path = os.path.join(tempfile.mkdtemp(prefix="agent-cli-config-"), "opencode.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=1)
        f.write("\n")
    return path


def mcp_tools(servers: dict, said: list[str]) -> list[str]:
    """Each configured server's tools, asked of the server itself (tools/list), as Claude's `mcp__<server>__<tool>`."""
    names: list[str] = []
    ask = "\n".join([
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "agent_cli", "version": "1"}}}),
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    ]) + "\n"
    for name, d in servers.items():
        try:
            p = subprocess.run([d["command"], *d.get("args", [])], input=ask, capture_output=True, text=True,
                               timeout=20, env=dict(os.environ, **d.get("env", {})))
        except (OSError, subprocess.TimeoutExpired) as e:
            line = f"agent_cli: MCP server {name} did not answer tools/list ({e})"
            said.append(line)
            print(line, file=sys.stderr, flush=True)
            continue
        for line in p.stdout.splitlines():
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") == 2:
                for tool in (msg.get("result") or {}).get("tools") or []:
                    names.append(f"mcp__{name}__{tool['name']}")
    return names


def init_tools(args: dict, servers: dict, said: list[str]) -> list[str]:
    """The tools in hand, in Claude's vocabulary, for the `system/init` every stream reader expects."""
    if args["allowed"] is not None:
        base = []
        for t in args["allowed"]:
            bare = t.partition("(")[0].strip()
            if bare and not bare.lower().startswith("mcp__") and bare not in base:
                base.append(bare)
    else:
        base = list(DEFAULT_TOOLS)
    denied = {t.partition("(")[0].strip().lower() for t in args["disallowed"] or []}
    return [t for t in base if t.lower() not in denied] + mcp_tools(servers, said)


def claude_name(tool: str, servers: dict) -> str:
    """opencode's tool name in Claude's: its own names, and an MCP server's `<server>_<tool>` as `mcp__<server>__<tool>`."""
    for server in servers:
        if tool.startswith(f"{server}_"):
            return f"mcp__{server}__{tool[len(server) + 1:]}"
    return CLAUDE_NAME.get(tool, tool)


def is_claude(model: str) -> bool:
    """A Claude model by any provider's name for it: `anthropic/…`, `opencode/claude-sonnet-5-5`, `openrouter/anthropic/…`."""
    parts = model.strip().lower().split("/")
    return "anthropic" in parts[:-1] or any(f in parts[-1] for f in CLAUDE_FAMILIES)


def pick_model(asked: str | None, env: dict) -> tuple[str, list[str]]:
    """The model opencode runs, and a line for each way it differs from what was asked. Refuses a Claude model."""
    if (env.get("AGENT_AUTH") or "").casefold() == "chatgpt":
        return SUBSCRIPTION_MODEL, []
    notes: list[str] = []
    switch = (env.get("AGENT_MODEL") or "").strip()
    if asked and "/" in asked:
        model, source = asked, "--model"
    else:
        if switch:
            model, source = switch, "AGENT_MODEL"
        else:
            model, source = DEFAULT_MODEL, "DEFAULT_MODEL"
            notes.append(f"AGENT_MODEL is not set: fell back to agent_cli.py's DEFAULT_MODEL {DEFAULT_MODEL}")
        if asked:
            # A bare alias (`sonnet`, `opus`) is Claude's vocabulary; the model on opencode is the one the switch names.
            notes.append(f"--model {asked} is a Claude alias: opencode runs {model} ({source}) instead")
    if "/" not in model:
        raise Refused(f"{model} ({source}) names no provider; opencode needs provider/model")
    if is_claude(model):
        raise Refused(f"{model} ({source}) is a Claude model. Claude models run through Claude Code only "
                      "(AGENT_CLI=claude), never through opencode")
    if "flash" in model.lower():
        notes.append(f"{model} ({source}) is a flash model")
    return model, notes


class Refused(Exception):
    pass


def announce(lines: list[str]) -> None:
    """To the log (stderr: stdout is the answer file in CI) as warnings, and to the job summary."""
    for line in lines:
        print(f"::warning::agent_cli: {line}", file=sys.stderr, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary and lines:
        with open(summary, "a", encoding="utf-8") as f:
            f.writelines(f"- agent_cli: {line}\n" for line in lines)


def fetch_subscription_access(url: str, key: str) -> str:
    try:
        parts = urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname or parts.username is not None or
                parts.path != "/v1/chatgpt-access" or parts.query or parts.fragment):
            raise Refused("expected the HTTPS ChatGPT credential endpoint")
        connection = http.client.HTTPSConnection(parts.netloc, timeout=40)
    except ValueError:
        raise Refused("expected the HTTPS ChatGPT credential endpoint") from None
    try:
        connection.request("POST", parts.path, headers={"Authorization": "Bearer " + key})
        response = connection.getresponse()
        if response.status != 200:
            raise Refused(f"ChatGPT credentials could not be issued (HTTP {response.status})")
        return json.loads(response.read(16384))["access_token"]
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError):
        raise Refused("ChatGPT credentials could not be retrieved") from None
    finally:
        connection.close()


def subscription_access() -> str:
    token = os.environ.pop("OPENCODE_CHATGPT_ACCESS_TOKEN", "")
    key = os.environ.pop("OPENCODE_CHATGPT_CREDENTIAL_KEY", "")
    url = os.environ.get("OPENCODE_CHATGPT_CREDENTIAL_URL", "")
    if not token and key and url:
        token = fetch_subscription_access(url, key)
    try:
        _, encoded, _ = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if (claims["iss"].rstrip("/") == "https://auth.openai.com" and
                claims["aud"] == "https://api.openai.com/v1" and
                "chatgpt.tokens.use.direct" in claims["scope"].split() and
                type(claims["exp"]) is int and type(claims["iat"]) is int and
                time.time() < claims["exp"] and 0 < claims["exp"] - claims["iat"] <= 3660):
            return token
    except (ValueError, TypeError, KeyError, AttributeError):
        pass
    raise Refused("expected a current OpenCode ChatGPT OAuth access token with plan usage enabled")


def run_opencode(args: dict, workspace: str, access: str | None = None) -> int:
    subscription = tempfile.TemporaryDirectory(prefix="agent-cli-subscription-") if access else None
    model, notes = pick_model(args["model"], os.environ)
    print(f"agent_cli: opencode runs {model}", file=sys.stderr, flush=True)
    announce(notes)
    prompt = args["prompt"] if not args["system"] else f"{args['system']}\n\n{args['prompt']}"
    servers = mcp_servers(args)
    written = opencode_config(args, servers, model)
    # A private server (`--standalone`): 2.x otherwise serves every run on the machine from one background service,
    # and a run gets what that service holds.
    argv = ["opencode", "--standalone", "run", "--format", "json", "-m", model, "--archived", prompt]
    permission = rules(args)
    if not permission:
        argv.insert(-1, "--auto")
    env = dict(os.environ)
    env["OPENCODE_CONFIG"] = written
    if subscription:
        env["XDG_DATA_HOME"] = subscription.name
        # OpenCode's Responses transport sends this variable as the bearer. The token carries ChatGPT plan scope.
        env["OPENAI_API_KEY"] = access
    home = None
    if "--strict-mcp-config" in args["passive"]:
        # The Mac runner still discovered the owner's .opencode as project config with a private HOME. That config
        # defined the same MCP server name as the gate's scratch node. Keep the explicit OPENCODE_CONFIG as the source.
        home = tempfile.mkdtemp(prefix="agent-cli-home-")
        env["HOME"] = home
        env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "1"
    tokens_cap = args["tokens"]
    turns_cap = args["max_turns"]
    started = time.time()
    texts: list[str] = []
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    turns = 0
    stopped = None
    last_error = None
    said: list[str] = []

    def emit(event: dict) -> None:
        if args["stream"]:
            print(json.dumps(event), flush=True)

    if args["stream"]:
        emit({"type": "system", "subtype": "init", "tools": init_tools(args, servers, said)})
    lock = None
    try:
        # The child's own words are kept: a run that dies before it says anything — a missing provider, a flag this
        # version doesn't know, a config it rejects — is exactly the run someone has to diagnose. Anything that isn't
        # one of its JSON events goes to our stderr, which the workflow's log keeps.
        lock = first_start_lock(env)
        child = subprocess.Popen(argv, cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                 env=env)
        for line in child.stdout:
            # Its first word means the store is built (or the start failed): the next start may go.
            release(lock)
            lock = None
            try:
                event = json.loads(line)
            except ValueError:
                if line.strip():
                    said.append(line.rstrip())
                    print(line.rstrip(), file=sys.stderr, flush=True)
                continue
            kind = event.get("type")
            if kind == "text":
                text = event.get("part", {}).get("text", "")
                texts.append(text)
                emit({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
            elif kind == "tool_use":
                part = event.get("part", {})
                state = part.get("state") or {}
                name = claude_name(part.get("tool", ""), servers)
                call = part.get("id", "")
                given = dict(state.get("input") or {})
                if name == "Skill" and not ({"skill", "command", "name"} & set(given)):
                    # opencode hands the skill tool `{id: …}`; skill_trigger.py reads Claude's key for it.
                    if given.get("id"):
                        given["skill"] = given["id"]
                emit({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": call, "name": name, "input": given}]}})
                output = state.get("output")
                if output is None:
                    output = state.get("error") or ""
                emit({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": call,
                     "content": output if isinstance(output, str) else json.dumps(output),
                     "is_error": state.get("status") == "error"}]}})
            elif kind == "error":
                error = event.get("error") or {}
                message = error.get("message") or json.dumps(error)
                last_error = message
                said.append(f"opencode: {message}")
                print(f"opencode: {message}", file=sys.stderr, flush=True)
            elif kind == "step_start":
                turns += 1
                if turns_cap is not None and turns > turns_cap:
                    stopped = f"the turn cap ({turns_cap})"
                    break
            elif kind == "step_finish":
                part = event.get("part", {})
                t = part.get("tokens") or {}
                cache = t.get("cache") or {}
                usage["input_tokens"] += int(t.get("input") or 0)
                usage["output_tokens"] += int(t.get("output") or 0)
                usage["cache_creation_input_tokens"] += int(cache.get("write") or 0)
                usage["cache_read_input_tokens"] += int(cache.get("read") or 0)
                billed = usage["input_tokens"] + usage["cache_creation_input_tokens"] + usage["output_tokens"]
                if tokens_cap is not None and billed > tokens_cap:
                    stopped = f"the token cap ({tokens_cap} billed tokens)"
                    break
        if stopped:
            child.kill()
        code = child.wait(timeout=60)
        # A child that died without saying anything is not a run that succeeded: whatever it said goes with the answer.
        if stopped is None and code != 0:
            stopped = f"the model CLI exited {code}" + (f": {said[-1]}" if said else "")
        # An error event with no answer at all is not a success the workflows can post either.
        if stopped is None and last_error and not any(t.strip() for t in texts):
            stopped = f"the model CLI answered an error: {last_error}"
    finally:
        release(lock)
        shutil.rmtree(os.path.dirname(written), ignore_errors=True)
        if home:
            shutil.rmtree(home, ignore_errors=True)
        if subscription:
            subscription.cleanup()
    if stopped:
        print(f"agent_cli: stopped at {stopped}", file=sys.stderr, flush=True)
    result = {
        "type": "result",
        "subtype": "success" if stopped is None else "error_max_turns",
        "is_error": stopped is not None,
        "result": "".join(texts) if stopped is None else f"{''.join(texts)}\n\nagent_cli: stopped at {stopped}",
        "total_cost_usd": 0.0,
        "num_turns": turns,
        "duration_ms": int((time.time() - started) * 1000),
        "usage": usage,
        "agent_cli": {"cli": "opencode", "model": model, "fallback": notes, "said": said[-6:]},
    }
    print(json.dumps(result), flush=True)
    return 0 if stopped is None else 1


def first_start_lock(env: dict):
    """Held by the one start that sets up a cold opencode data store, until that child says its first line.

    opencode 2.4.1 builds its store (`<data>/opencode/opencode.db`) on its first start, and a second start on the same
    cold store meanwhile dies with "Standalone server exited before reporting readiness": four at once on a fresh home,
    three died; on the warm home all four ran. CI runs these side by side on fresh runners (the skill trials four at a
    time, the bank's judges three), so the starts on a cold store take turns and a warm one takes no lock at all.
    Returns the open lock file, or None when the store is already there.
    """
    data = env.get("XDG_DATA_HOME") or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".local", "share")
    store = os.path.join(data, "opencode", "opencode.db")
    if os.path.exists(store):
        return None
    os.makedirs(data, exist_ok=True)
    lock = open(os.path.join(data, ".agent-cli-first-start.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    if os.path.exists(store):
        # Another start set it up while this one waited.
        release(lock)
        return None
    return lock


def release(lock) -> None:
    if lock is not None:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


# The account's own sentence, not a task that failed. A long answer that happens to quote one of these is not it.
REFUSAL_PHRASES = ("weekly limit", "credit balance", "usage credits")
REFUSAL_CHARS = 400


def _tokens(value) -> int:
    """Every numeric usage field, however nested. A bool is not a token count."""
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, dict):
        return sum(_tokens(v) for v in value.values())
    if isinstance(value, list):
        return sum(_tokens(v) for v in value)
    return 0


def _result_event(stdout: str) -> dict | None:
    """The last `type: result` event: one JSON line, or the whole stdout when that is the one object."""
    last = None
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            last = event
    if last is not None:
        return last
    text = (stdout or "").strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            event = json.loads(text)
        except ValueError:
            return None
        if isinstance(event, dict) and event.get("type") == "result":
            return event
    return None


def _account_sentence(text: str) -> str | None:
    if not isinstance(text, str):
        return None
    stripped = text.strip()
    if not stripped or len(stripped) > REFUSAL_CHARS:
        return None
    low = stripped.lower()
    if any(phrase in low for phrase in REFUSAL_PHRASES):
        return stripped
    return None


def account_refused(stdout: str, stderr: str) -> str | None:
    """The account refusing, or None when Claude answered.

    A result event decides it: only a short `is_error` that spent no tokens and names a weekly limit, a credit
    balance or usage credits. Usage missing counts as nothing spent. A result that is not that is Claude's, even
    when stderr says the words. With no result JSON, the whole reply has to be that short sentence.
    """
    event = _result_event(stdout)
    if event is not None:
        if event.get("is_error") is not True or _tokens(event.get("usage")) != 0:
            return None
        return _account_sentence(event.get("result"))
    return _account_sentence((stdout or "") + (stderr or ""))


def run_claude(argv: list[str]) -> int:
    """Claude Code, argv untouched. A refusal of the account runs the same argv through opencode."""
    real = claude_bin()
    if not os.access(real, os.X_OK):
        print(f"agent_cli: {real} is not there (set CLAUDE_BIN, or AGENT_CLI=opencode)", file=sys.stderr)
        return 127
    child = subprocess.run([real, *argv], capture_output=True, text=True, encoding="utf-8", errors="replace")
    reason = account_refused(child.stdout, child.stderr)
    if reason is None:
        sys.stdout.write(child.stdout)
        sys.stderr.write(child.stderr)
        return child.returncode
    try:
        args = parse(argv)
        model, _notes = pick_model(args["model"], os.environ)
    except Refused as e:
        print(f"::error::agent_cli: refused: {e}", file=sys.stderr)
        return 2
    except SystemExit as e:
        # The job cannot run on opencode (a flag it has no mapping for). The refusal stands.
        if e.code:
            print(e.code, file=sys.stderr)
        sys.stdout.write(child.stdout)
        sys.stderr.write(child.stderr)
        return child.returncode or 1
    print(f"::warning::agent_cli: Claude Code refused ({reason}): opencode runs {model}", file=sys.stderr, flush=True)
    if not shutil.which("opencode"):
        print("agent_cli: no `opencode` on PATH, so the refusal stands", file=sys.stderr)
        sys.stdout.write(child.stdout)
        sys.stderr.write(child.stderr)
        return child.returncode or 1
    try:
        return run_opencode(args, os.getcwd())
    except Refused as e:
        print(f"::error::agent_cli: refused: {e}", file=sys.stderr)
        return 2


def main(argv: list[str]) -> int:
    if argv[:1] == ["--which-model"]:
        # For a workflow that runs opencode itself (opencode-review.yml): the same choice and the same refusal.
        try:
            model, notes = pick_model(argv[1] if len(argv) > 1 else None, os.environ)
        except Refused as e:
            print(f"::error::agent_cli: refused: {e}", file=sys.stderr)
            return 2
        announce(notes)
        print(model)
        return 0
    use_subscription = (os.environ.get("AGENT_AUTH") or "").casefold() == "chatgpt"
    if use_subscription:
        for key in MODEL_KEYS:
            os.environ.pop(key, None)
    elif (os.environ.get("AGENT_CLI") or "claude") == "claude":
        return run_claude(argv)
    if use_subscription and argv == ["--check-subscription"]:
        try:
            subscription_access()
        except Refused as error:
            print(f"::error::agent_cli: {error}", file=sys.stderr)
            return 2
        return 0
    args = parse(argv)
    # The caller's directory, not GITHUB_WORKSPACE: the skill sessions cd into a project of their own before asking,
    # and the config and the child belong where the caller stands.
    workspace = os.getcwd()
    if not shutil.which("opencode"):
        print("agent_cli: AGENT_CLI=opencode but no `opencode` on PATH", file=sys.stderr)
        return 127
    try:
        if use_subscription:
            return run_opencode(args, workspace, subscription_access())
        return run_opencode(args, workspace)
    except Refused as e:
        print(f"::error::agent_cli: refused: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
