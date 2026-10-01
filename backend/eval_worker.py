import sys, json, re, urllib.request, time

# Sanitize CLI arguments to prevent surrogate escape issues under non-UTF-8 locales
sys.argv = [arg.encode("utf-8", "surrogateescape").decode("utf-8", "replace") for arg in sys.argv]

error = ""
out = ""
expected = ""
t0 = time.perf_counter()

try:
    if len(sys.argv) < 9:
        raise ValueError("Not enough arguments")
    system, user, thinking, budget, model, url, expected, msg = sys.argv[1:9]
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": 2048,
        "chat_template_kwargs": {"enable_thinking": thinking.strip().lower() == "true"},
    }
    if budget:
        payload["reasoning_budget_tokens"] = int(budget)
    if msg:
        payload["reasoning_budget_message"] = msg
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    proxy_handler = urllib.request.ProxyHandler({})
    opener = urllib.request.build_opener(proxy_handler)

    with opener.open(req, timeout=120) as r:
        body = json.loads(r.read().decode("utf-8"))
    content = (body.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    content = re.sub(r"<think[\s\S]*?</think>", "", content)
    i = content.find("<think")
    if i != -1:
        content = content[:i]
    content = content.strip()
    if len(content) >= 2 and content[0] == '"' and content[-1] == '"':
        content = content[1:-1].strip()
    out = content
except urllib.error.HTTPError as e:
    error = f"HTTPError {e.code}: {e.read().decode('utf-8', errors='ignore')}"
except Exception as e:
    error = f"{type(e).__name__}: {e}"

lat = f"{time.perf_counter() - t0:.3f}"

verdict = "ERROR" if error else ("SKIP" if not expected.strip() else "")
if verdict == "":
    def norm(s):
        return " ".join(s.lower().split())
    verdict = "PASS" if norm(expected) in norm(out) else "FAIL"

out_clean = out.replace("\r", " ").replace("\n", " ").replace("\t", " ")
err_clean = error.replace("\r", " ").replace("\n", " ").replace("\t", " ")

print(f"{lat}\t{verdict}\t{out_clean}\t{err_clean}")
