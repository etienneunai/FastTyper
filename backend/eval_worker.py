import sys, json, re, urllib.request

error = None
out = ""
try:
    if len(sys.argv) < 9:
        raise ValueError("Not enough arguments")
    system, user, thinking, budget, model, url, expected, msg = sys.argv[1:9]
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0,
        "max_tokens": 2048,
        "chat_template_kwargs": {"enable_thinking": thinking.strip().lower() == "true"},
    }
    if budget:
        payload["reasoning_budget_tokens"] = int(budget)
    if msg:
        payload["reasoning_budget_message"] = msg
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    
    proxy_handler = urllib.request.ProxyHandler({})
    opener = urllib.request.build_opener(proxy_handler)
    
    with opener.open(req, timeout=120) as r:
        body = json.loads(r.read().decode())
    content = (body["choices"][0]["message"].get("content") or "").strip()
    content = re.sub(r"<think[\s\S]*?</think>", "", content)
    i = content.find("<think")
    if i != -1:
        content = content[:i]
    content = content.strip()
    if len(content) >= 2 and content[0] == '"' and content[-1] == '"':
        content = content[1:-1].strip()
    out = content
except urllib.error.HTTPError as e:
    error = f"HTTPError {e.code}: {e.read().decode(errors='ignore')}"
except Exception as e:
    error = "%s: %s" % (type(e).__name__, e)

verdict = "ERROR" if error else ("SKIP" if not expected.strip() else "")
if verdict == "":
    def norm(s):
        return " ".join(s.lower().split())
    verdict = "PASS" if norm(expected) in norm(out) else "FAIL"
print(json.dumps({"out": out, "verdict": verdict, "error": error}))
