#!/usr/bin/env python3
"""Brainy Prices: MCP v2 + REST v2 walkthrough with the standard library only (Python 3.8+).

    python3 examples/python.py

Steps: initialize -> notifications/initialized -> tools/list (follows nextCursor) -> tools/call fuel_prices
-> GET /api/v2/transport/fuel-prices. Prints a short summary of each answer (three fuel prices, dates and source), never raw JSON or rows.
Requests are at least 1.1 s apart (anonymous limit: 30/min, 500/day, shared by REST and MCP); HTTP 429 stops the script.
Exit codes: 0 ok, 1 HTTP/network error, 2 JSON-RPC error, 3 tool returned isError, 4 rate limited (429), 5 timeout.
"""
import json
import socket
import sys
import time
import urllib.error
import urllib.request

BASE = "https://prices.brainy.ae"
MCP_URL = BASE + "/mcp/v2"
REST_URL = BASE + "/api/v2/transport/fuel-prices"
PROTOCOL = "2025-11-25"
SPACING_S, TIMEOUT_S, MAX_PAGES = 1.1, 20, 20


class Stop(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.exit_code = code


_state = {"last": 0.0, "id": 0, "protocol": None}


def request(label, url, data=None, headers=None):
    wait = _state["last"] + SPACING_S - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _state["last"] = time.monotonic()
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as response:
            return response.status, dict(response.headers), response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise Stop("%s: HTTP 429 rate limited; stopping. Retry-After: %s s" % (label, error.headers.get("Retry-After", "not given")), 4)
        problem = ""
        try:
            body = json.loads(error.read().decode("utf-8"))
            if isinstance(body, dict) and body.get("code"):
                # REST errors are RFC 9457 problem documents with a static code/title; print only those.
                problem = " %s: %s" % (body["code"], body.get("title", ""))
        except (ValueError, UnicodeDecodeError):
            pass
        raise Stop("%s: HTTP %d%s" % (label, error.code, problem), 1)
    except (socket.timeout, TimeoutError):
        raise Stop("%s: timeout after %d s" % (label, TIMEOUT_S), 5)
    except urllib.error.URLError as error:
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            raise Stop("%s: timeout after %d s" % (label, TIMEOUT_S), 5)
        raise Stop("%s: network error (%s)" % (label, type(error.reason).__name__), 1)


def rpc(method, params=None, notification=False):
    """One JSON-RPC message per POST; the answer may be plain JSON or a text/event-stream with data: lines."""
    message = {"jsonrpc": "2.0", "method": method}
    if not notification:
        _state["id"] += 1
        message["id"] = _state["id"]
    if params is not None:
        message["params"] = params
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if _state["protocol"]:
        headers["MCP-Protocol-Version"] = _state["protocol"]
    status, response_headers, body = request(method, MCP_URL, json.dumps(message).encode("utf-8"), headers)
    if notification:
        return {"status": status}
    content_type = {k.lower(): v for k, v in response_headers.items()}.get("content-type", "")
    texts = [body]
    if "text/event-stream" in content_type:
        texts = []
        for event in body.replace("\r\n", "\n").split("\n\n"):
            data = "\n".join(line[5:].lstrip(" ") for line in event.split("\n") if line.startswith("data:"))
            if data:
                texts.append(data)
    answer = None
    for text in texts:
        try:
            parsed = json.loads(text)
        except ValueError:
            continue
        if isinstance(parsed, dict) and parsed.get("id") == message.get("id"):
            answer = parsed
    if answer is None:
        raise Stop("%s: no JSON-RPC response with id %s" % (method, message.get("id")), 1)
    if "error" in answer:
        error = answer["error"] or {}
        raise Stop("%s: JSON-RPC error %s: %s" % (method, error.get("code"), str(error.get("message", ""))[:200]), 2)
    return answer.get("result") or {}


def provenance(meta):
    """Dates and source exactly as the envelope states them; only the fields that are present."""
    d = (meta or {}).get("dataset") or {}
    period = (d.get("reference_period") or {}).get("label")
    pairs = [("period", period), ("published", d.get("published_on") or d.get("published_at")),
             ("observed", d.get("observed_on") or d.get("observed_at")), ("compiled", d.get("compiled_at"))]
    dates = ", ".join("%s %s" % (k, v) for k, v in pairs if v)
    return "%s; %s" % (dates or "no date fields in this response", str((meta or {}).get("attribution") or "no attribution")[:240])


def three_prices(prices):
    items = list((prices or {}).items())[:3]
    return ", ".join("%s %s" % (grade, "unknown" if aed is None else aed) for grade, aed in items) or "no prices published"


def main():
    init = rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "brainy-prices-example-python", "version": "1.0.0"}})
    _state["protocol"] = init.get("protocolVersion") or PROTOCOL
    server = init.get("serverInfo") or {}
    print("initialize: %s %s, MCP protocol %s" % (server.get("name", "server"), server.get("version", ""), _state["protocol"]))

    ack = rpc("notifications/initialized", notification=True)
    print("notifications/initialized: HTTP %d" % ack["status"])

    names, seen, cursor, pages = [], set(), None, 0
    while True:
        pages += 1
        if pages > MAX_PAGES:
            raise Stop("tools/list: more than %d pages" % MAX_PAGES, 1)
        result = rpc("tools/list", {"cursor": cursor} if cursor else None)
        names.extend(tool.get("name") for tool in result.get("tools") or [])
        cursor = result.get("nextCursor")
        if not isinstance(cursor, str) or not cursor:
            break
        if cursor in seen:
            raise Stop("tools/list: repeated nextCursor (incomplete list)", 1)
        seen.add(cursor)
    print("tools/list: %d tools in %d page(s), e.g. %s" % (len(names), pages, ", ".join(names[:5])))

    call = rpc("tools/call", {"name": "fuel_prices", "arguments": {}})
    text = "\n".join(c.get("text", "") for c in call.get("content") or [] if c.get("type") == "text")
    if call.get("isError"):
        raise Stop("tools/call fuel_prices: tool error: %s" % text.split("\n")[0][:200], 3)
    structured = call.get("structuredContent") or {}
    dataset = (structured.get("meta") or {}).get("dataset") or {}
    print("tools/call fuel_prices: status %s, month %s" % (dataset.get("status", "unknown"), (structured.get("data") or {}).get("month", "n/a")))
    print("  " + text.split("\n")[0][:240])
    print("  " + provenance(structured.get("meta")))

    status, headers, body = request("GET /api/v2/transport/fuel-prices", REST_URL, headers={"Accept": "application/json"})
    rest = json.loads(body)
    data = rest.get("data") or {}
    meta = (rest.get("meta") or {}).get("dataset") or {}
    print("REST fuel-prices: HTTP %d, status %s, month %s, %s" % (status, meta.get("status", "unknown"), data.get("month", "n/a"), data.get("unit", "")))
    print("  " + three_prices(data.get("prices")))
    print("  " + provenance(rest.get("meta")))
    print("  RateLimit: %s" % {k.lower(): v for k, v in headers.items()}.get("ratelimit", "n/a"))


if __name__ == "__main__":
    try:
        main()
    except Stop as stop:
        print(str(stop), file=sys.stderr)
        sys.exit(stop.exit_code)
