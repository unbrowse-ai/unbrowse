#!/usr/bin/env python3
"""
curl-impersonate bridge for unbrowse.
Uses curl_cffi to make requests with Chrome TLS fingerprint.
Called from Node.js via child_process.

Usage: python3 curl-impersonate.py <method> <url> <headers_json> [body]
Output: JSON with {status, headers, body}
"""
import sys
import json

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: curl-impersonate.py <method> <url> <headers_json> [body]"}))
        sys.exit(1)

    method = sys.argv[1].upper()
    url = sys.argv[2]
    headers = json.loads(sys.argv[3])
    body = sys.argv[4] if len(sys.argv) > 4 else None

    try:
        from curl_cffi import requests

        kwargs = {
            "headers": headers,
            "impersonate": "chrome",
            "timeout": 30,
        }
        if body and method in ("POST", "PUT", "PATCH"):
            kwargs["data"] = body

        resp = requests.request(method, url, **kwargs)

        # Build response headers dict
        resp_headers = {}
        for k, v in resp.headers.items():
            resp_headers[k.lower()] = v

        result = {
            "status": resp.status_code,
            "statusText": resp.reason or "",
            "headers": resp_headers,
            "body": resp.text[:200_000],  # Cap at 200KB
        }
        print(json.dumps(result))

    except ImportError:
        print(json.dumps({"error": "curl_cffi not installed. Run: pip3 install curl_cffi"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
