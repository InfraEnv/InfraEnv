#!/usr/bin/env python3
"""Thin RPC client. All scenario semantics remain in the TypeScript sidecar."""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

DISCLOSURE = "SIMULATED / S2 — behavioral model, not real HPC performance"


def command_from_argv() -> str:
    invoked = pathlib.Path(sys.argv[0]).name
    args = " ".join(sys.argv[1:])
    if invoked == "infraenv":
        return f"infraenv {args}".strip()
    return f"{invoked} {args}".strip()


def main() -> int:
    api_url = os.environ.get("INFRAENV_API_URL", "")
    token = os.environ.get("INFRAENV_SANDBOX_TOKEN", "")
    if not api_url or not token:
        print(DISCLOSURE, file=sys.stderr)
        print("InfraEnv session credentials are missing. Start this shell through `infraenv lab start`.", file=sys.stderr)
        return 78
    payload = json.dumps({"command": command_from_argv()}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_url}/commands/execute",
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        print(DISCLOSURE, file=sys.stderr)
        print(f"Local Runtime is unavailable: {error}", file=sys.stderr)
        return 69
    if result.get("stdout"):
        print(result["stdout"])
    if result.get("stderr"):
        print(result["stderr"], file=sys.stderr)
    return int(result.get("exitCode", 1))


if __name__ == "__main__":
    raise SystemExit(main())
