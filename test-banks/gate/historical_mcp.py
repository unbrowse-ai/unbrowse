"""Expose the historical scratch node's loopback HTTP MCP over stdio."""

import http.client
import json
from math import isfinite
import os
import sys
from threading import Lock, Thread
from urllib.parse import urlsplit


def send(output_lock, reply):
    with output_lock:
        print(json.dumps(reply), flush=True)


def reject_constant(value):
    raise ValueError(f"{value} is not a JSON value")


def finite_float(value):
    number = float(value)
    if not isfinite(number):
        raise ValueError("number is outside the finite float range")
    return number


def read_json(value):
    return json.loads(value, parse_constant=reject_constant, parse_float=finite_float)


def valid_request(message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return False
    if not isinstance(message.get("method"), str):
        return False
    if "params" in message and not isinstance(message["params"], (dict, list)):
        return False
    request_id = message.get("id")
    return request_id is None or type(request_id) in (str, int, float)


def valid_reply(answer, request_id, method=None):
    if not isinstance(answer, dict) or answer.get("jsonrpc") != "2.0" or "id" not in answer:
        return False
    if type(answer["id"]) is bool or answer["id"] != request_id:
        return False
    if "result" in answer:
        if "error" in answer:
            return False
        result = answer["result"]
        if method == "tools/list":
            return isinstance(result, dict) and isinstance(result.get("tools"), list)
        if method == "initialize":
            return isinstance(result, dict)
        return True
    error = answer.get("error")
    return (isinstance(error, dict) and type(error.get("code")) is int
            and isinstance(error.get("message"), str))


def forward(url, headers, line, message, output_lock):
    wants_reply = "id" in message
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=330 if wants_reply else 2)
    session = None
    problem = None
    try:
        conn.request("POST", "/mcp", body=line.encode(), headers=headers)
        # Only initialize provides the session ID. Notifications have no MCP reply.
        if not wants_reply:
            return None
        response = conn.getresponse()
        body = response.read()
        if response.status == 200:
            answer = read_json(body)
            if not valid_reply(answer, message["id"], message.get("method")):
                raise ValueError("MCP reply has an invalid response envelope")
            if "result" in answer:
                sessions = [value.strip() for value in (response.headers.get_all("mcp-session-id") or []) if value.strip()]
                if len(sessions) == 1:
                    session = sessions[0]
        else:
            problem = f"HTTP {response.status}"
    except (OSError, http.client.HTTPException):
        problem = "historical MCP transport failed"
    except (ValueError, RecursionError):
        problem = "historical MCP returned an invalid JSON response"
    finally:
        conn.close()
    if wants_reply:
        if problem:
            answer = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32001, "message": problem}}
        send(output_lock, answer)
    return session


def main():
    url = urlsplit(os.environ["UNBROWSE_NODE"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.port is None:
        raise SystemExit("historical MCP must name a loopback scratch node")
    headers = {
        "Authorization": "Bearer " + os.environ["UNBROWSE_AGENT_TOKEN"],
        "Content-Type": "application/json",
    }
    output_lock = Lock()
    workers = []
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = read_json(line)
            except (ValueError, RecursionError):
                send(output_lock, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "not JSON"}})
                continue
            if not valid_request(message):
                send(output_lock, {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid JSON-RPC request"}})
                continue
            if message.get("method") in ("initialize", "notifications/initialized"):
                if session := forward(url, headers, line, message, output_lock):
                    headers["Mcp-Session-Id"] = session
            else:
                worker = Thread(target=forward, args=(url, headers.copy(), line, message, output_lock))
                worker.start()
                workers.append(worker)
    finally:
        for worker in workers:
            worker.join()


if __name__ == "__main__":
    main()
