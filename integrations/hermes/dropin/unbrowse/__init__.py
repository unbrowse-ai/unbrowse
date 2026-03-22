"""Drop-in Hermes plugin for Unbrowse.

This mirrors the pip-installed plugin entrypoint but works as a plain
`~/.hermes/plugins/unbrowse/` directory plugin.
"""

import json
import shutil
import subprocess

TOOL_NAME = "unbrowse"
TOOLSET = "web"
DEFAULT_TIMEOUT = 120


def register(ctx):
    """Entry point called by Hermes plugin discovery."""
    ctx.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema={
            "name": TOOL_NAME,
            "description": "Reverse-engineer websites into reusable API skills and execute them via the unbrowse CLI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["resolve", "search", "execute", "login", "skills", "skill", "health"],
                        "description": "Unbrowse action to perform",
                    },
                    "intent": {"type": "string", "description": "Plain-English task or search intent"},
                    "url": {"type": "string", "description": "Target website URL"},
                    "domain": {"type": "string", "description": "Optional domain filter for search"},
                    "skillId": {"type": "string", "description": "Skill id for skill/execute actions"},
                    "endpointId": {"type": "string", "description": "Endpoint id for execute action"},
                    "path": {"type": "string", "description": "Response path extraction hint"},
                    "extract": {"type": "string", "description": "Comma-separated fields or alias:path spec"},
                    "limit": {"type": "integer", "description": "Max results (1-200)", "minimum": 1, "maximum": 200},
                    "pretty": {"type": "boolean", "description": "Pretty-print output"},
                    "confirmUnsafe": {"type": "boolean", "description": "Allow non-GET execution"},
                    "dryRun": {"type": "boolean", "description": "Preview without side effects"},
                },
                "required": ["action"],
            },
        },
        handler=_handle,
        check_fn=lambda: shutil.which("unbrowse") is not None,
        requires_env=[],
        is_async=True,
    )

    ctx.register_hook("on_session_start", _on_session_start)


def _on_session_start(**kwargs):
    """No-op hook; keeps room for future session bootstrap if needed."""
    return None


async def _handle(params: dict, **kwargs) -> str:
    try:
        args = _build_args(params)
    except (KeyError, ValueError) as e:
        return json.dumps({"error": str(e)})

    try:
        result = subprocess.run(
            ["unbrowse"] + args,
            capture_output=True,
            text=True,
            timeout=DEFAULT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return json.dumps({"error": f"Command timed out after {DEFAULT_TIMEOUT}s"})
    except FileNotFoundError:
        return json.dumps({"error": "unbrowse binary not found on PATH"})

    stdout = result.stdout.strip()
    if result.returncode == 0 and stdout:
        try:
            json.loads(stdout)
            return stdout
        except json.JSONDecodeError:
            return json.dumps({"output": stdout})

    if stdout:
        try:
            json.loads(stdout)
            return stdout
        except json.JSONDecodeError:
            pass

    stderr = result.stderr.strip()
    return json.dumps({
        "error": stderr or stdout or f"Command failed with exit code {result.returncode}",
        "exitCode": result.returncode,
    })


def memory_instructions() -> str:
    return (
        "You have an `unbrowse` tool that reverse-engineers websites into reusable API skills. "
        "Use `unbrowse` first for any website data extraction, search, or authenticated reads. "
        "Only fall back to the browser tool for visual QA, drag-drop, canvas apps, or file uploads. "
        "Note: unbrowse 'skills' are API endpoint bundles, distinct from Hermes skills."
    )


def _push_flag(args: list, name: str, value) -> None:
    if value is None or value is False or value == "":
        return
    args.append(f"--{name}")
    if value is not True:
        args.append(str(value))


def _build_args(params: dict) -> list:
    action = params["action"]

    if action == "health":
        return ["health"]
    if action == "skills":
        return ["skills"]
    if action == "skill":
        if "skillId" not in params:
            raise ValueError("skillId required for action=skill")
        return ["skill", params["skillId"]]
    if action == "login":
        if "url" not in params:
            raise ValueError("url required for action=login")
        return ["login", "--url", params["url"]]
    if action == "search":
        if "intent" not in params:
            raise ValueError("intent required for action=search")
        args = ["search", "--intent", params["intent"]]
        _push_flag(args, "domain", params.get("domain"))
        return args
    if action == "resolve":
        if "intent" not in params:
            raise ValueError("intent required for action=resolve")
        if "url" not in params:
            raise ValueError("url required for action=resolve")
        args = ["resolve", "--intent", params["intent"], "--url", params["url"]]
        _push_flag(args, "path", params.get("path"))
        _push_flag(args, "extract", params.get("extract"))
        _push_flag(args, "limit", params.get("limit"))
        _push_flag(args, "pretty", params.get("pretty"))
        _push_flag(args, "dry-run", params.get("dryRun"))
        _push_flag(args, "confirm-unsafe", params.get("confirmUnsafe"))
        return args
    if action == "execute":
        if "skillId" not in params:
            raise ValueError("skillId required for action=execute")
        if "endpointId" not in params:
            raise ValueError("endpointId required for action=execute")
        args = ["execute", "--skill", params["skillId"], "--endpoint", params["endpointId"]]
        _push_flag(args, "url", params.get("url"))
        _push_flag(args, "intent", params.get("intent"))
        _push_flag(args, "path", params.get("path"))
        _push_flag(args, "extract", params.get("extract"))
        _push_flag(args, "limit", params.get("limit"))
        _push_flag(args, "pretty", params.get("pretty"))
        _push_flag(args, "dry-run", params.get("dryRun"))
        _push_flag(args, "confirm-unsafe", params.get("confirmUnsafe"))
        return args

    raise ValueError(f"Unsupported action: {action}")
