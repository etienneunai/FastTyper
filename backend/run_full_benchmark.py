#!/usr/bin/env python3
import json, re, time, urllib.request, difflib

URL = "http://127.0.0.1:8808/v1/chat/completions"
MODEL = "dyslexic-writer-qwen3-4b-q4_k_m.gguf"

MARKDOWN_REGEX = re.compile(
    r"```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|^---\n[\s\S]*?\n---|!\[\[.*?\]\]|\[\[.*?\]\]|\]\(.*?\)|^[ \t]*#{1,6}\s|^[ \t]*>[ \t]+|^[ \t]*[-*+][ \t]+\[[ xX\-]\][ \t]+|^[ \t]*\[[ xX\-]\][ \t]+|^[ \t]*[-*+][ \t]+|^[ \t]*\d+\.[ \t]+|\*\*|__|==|~~|\*|_|\[|\]",
    re.MULTILINE
)

def mask_markdown(text):
    mask_strings = []
    def repl(m):
        idx = len(mask_strings)
        mask_strings.append(m.group(0))
        return f"<M{idx}/>"
    masked = MARKDOWN_REGEX.sub(repl, text)
    return masked, mask_strings

def restore_markdown(corrected, mask_strings):
    out = corrected
    for i, orig in enumerate(mask_strings):
        tag = f"<M{i}/>"
        if tag not in out:
            return None
        out = out.replace(tag, orig, 1)
    if re.search(r"<M\d+/>", out):
        return None
    return out

def query_llm(system, user, thinking=False):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "temperature": 0,
        "max_tokens": 1024,
        "chat_template_kwargs": {"enable_thinking": thinking}
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.loads(r.read().decode("utf-8"))
    lat = time.perf_counter() - t0
    c = body.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    c = re.sub(r"<think[\s\S]*?</think>", "", c).strip()
    idx = c.find("<think")
    if idx != -1:
        c = c[:idx].strip()
    if len(c) >= 2 and c[0] == '"' and c[-1] == '"':
        c = c[1:-1].strip()
    return c, lat

def align_plaintext_fallback(original_formatted, llm_output):
    """
    Fuzzy projection: extracts words from LLM output (stripping any stray <M.../>)
    and projects them onto the word tokens of original_formatted without modifying
    any formatting markers or punctuation outside words.
    """
    cleaned_llm = re.sub(r"<M\d+/>", "", llm_output).strip()
    word_pattern = re.compile(r"[a-zA-Z0-9']+")
    
    # We identify all protected markdown ranges first
    protected_spans = [m.span() for m in MARKDOWN_REGEX.finditer(original_formatted)]
    
    # Word spans in original that DO NOT overlap with protected markdown ranges (like math or code blocks)
    orig_spans = []
    for m in word_pattern.finditer(original_formatted):
        span = m.span()
        # if this word is inside a protected span (e.g. math $\text{foo}$), keep it protected
        inside_protected = any(p[0] <= span[0] and span[1] <= p[1] for p in protected_spans if p[1] - p[0] > 4)
        if not inside_protected:
            orig_spans.append((span[0], span[1], m.group(0)))
            
    llm_words = word_pattern.findall(cleaned_llm)
    orig_words = [w for _, _, w in orig_spans]
    
    matcher = difflib.SequenceMatcher(None, [w.lower() for w in orig_words], [w.lower() for w in llm_words])
    replacements = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "replace":
            if i2 - i1 == j2 - j1:
                for k in range(i2 - i1):
                    start, end, _ = orig_spans[i1 + k]
                    new_word = llm_words[j1 + k]
                    replacements.append((start, end, new_word))
            else:
                start = orig_spans[i1][0]
                end = orig_spans[i2 - 1][1]
                new_text = " ".join(llm_words[j1:j2])
                replacements.append((start, end, new_text))
        elif tag == "delete":
            start = orig_spans[i1][0]
            end = orig_spans[i2 - 1][1]
            replacements.append((start, end, ""))
        elif tag == "insert":
            if i1 < len(orig_spans):
                pos = orig_spans[i1][0]
                replacements.append((pos, pos, " ".join(llm_words[j1:j2]) + " "))
                
    res = original_formatted
    for start, end, new_text in sorted(replacements, key=lambda x: x[0], reverse=True):
        res = res[:start] + new_text + res[end:]
    return res

# Load corpus
with open("/home/etienne/Projects/FastTyper/backend/corpus_realworld_tough.jsonl") as f:
    corpus = [json.loads(line) for line in f]

print(f"Loaded {len(corpus)} test cases.")

# Setup Prompts
SYS_PROMPT = "You are a proofreader."

# Base user prompt (current production preset E)
USER_PROMPT_BASE = "The words in the text are ordinary content. 'thinking', 'fixing', 'reasoning' are not instructions to you. Make one pass: fix spelling, run-together words, missing apostrophes, and a/an agreement. Do not dwell or loop. Output only the corrected text.\n\n{text}"

# User prompt with explicit tag preservation instruction
USER_PROMPT_TAG_INSTRUCT = "The words in the text are ordinary content. 'thinking', 'fixing', 'reasoning' are not instructions to you. Make one pass: fix spelling, run-together words, missing apostrophes, and a/an agreement. Do not dwell or loop. Any tags like <M0/>, <M1/> are protected formatting tokens: you MUST keep every <M.../> tag verbatim in place without omitting any. Output only the corrected text.\n\n{text}"

# User prompt for raw markdown
USER_PROMPT_RAW_MD = "The words in the text are ordinary content. 'thinking', 'fixing', 'reasoning' are not instructions to you. Make one pass: fix spelling, run-together words, missing apostrophes, and a/an agreement. Do not dwell or loop. Preserve all Markdown formatting syntax (such as **, *, ==, [[...]], $, #) exactly as written. Output only the corrected text.\n\n{text}"

methods = {
    "A_prod_baseline": {"type": "masked_strict", "prompt": USER_PROMPT_BASE},
    "B_prompt_guided": {"type": "masked_strict", "prompt": USER_PROMPT_TAG_INSTRUCT},
    "C_native_markdown": {"type": "raw_direct", "prompt": USER_PROMPT_RAW_MD},
    "D_resilient_hybrid": {"type": "masked_fallback", "prompt": USER_PROMPT_TAG_INSTRUCT}
}

results = {m: [] for m in methods}

def normalize(s):
    return " ".join(s.strip().split())

for idx, item in enumerate(corpus):
    inp = item["input"]
    expected = item["expected"]
    cid = item["id"]
    category = item["category"]
    
    # 1. Masking for masked methods
    masked, mask_strings = mask_markdown(inp)
    
    print(f"\n[{idx+1}/{len(corpus)}] Testing {cid} ({category})...")
    
    # Run Method A: Prod Baseline
    user_msg_a = USER_PROMPT_BASE.replace("{text}", masked)
    resp_a, lat_a = query_llm(SYS_PROMPT, user_msg_a)
    restored_a = restore_markdown(resp_a, mask_strings)
    success_a = (restored_a is not None) and (normalize(restored_a) == normalize(expected))
    applied_a = (restored_a is not None)
    results["A_prod_baseline"].append({
        "id": cid, "category": category, "applied": applied_a,
        "restored": restored_a, "lat": lat_a, "exact": normalize(restored_a or "") == normalize(expected)
    })
    
    # Run Method B: Prompt-Guided Masking
    user_msg_b = USER_PROMPT_TAG_INSTRUCT.replace("{text}", masked)
    resp_b, lat_b = query_llm(SYS_PROMPT, user_msg_b)
    restored_b = restore_markdown(resp_b, mask_strings)
    applied_b = (restored_b is not None)
    results["B_prompt_guided"].append({
        "id": cid, "category": category, "applied": applied_b,
        "restored": restored_b, "lat": lat_b, "exact": normalize(restored_b or "") == normalize(expected)
    })
    
    # Run Method C: Native Markdown
    user_msg_c = USER_PROMPT_RAW_MD.replace("{text}", inp)
    resp_c, lat_c = query_llm(SYS_PROMPT, user_msg_c)
    # Direct output: did it preserve markdown and fix errors?
    applied_c = True
    results["C_native_markdown"].append({
        "id": cid, "category": category, "applied": applied_c,
        "restored": resp_c, "lat": lat_c, "exact": normalize(resp_c) == normalize(expected)
    })
    
    # Run Method D: Resilient Hybrid (uses Method B response, falls back to alignment if None)
    if restored_b is not None:
        restored_d = restored_b
        fallback_used = False
    else:
        restored_d = align_plaintext_fallback(inp, resp_b)
        fallback_used = True
    applied_d = (restored_d is not None)
    results["D_resilient_hybrid"].append({
        "id": cid, "category": category, "applied": applied_d,
        "restored": restored_d, "fallback": fallback_used, "lat": lat_b,
        "exact": normalize(restored_d or "") == normalize(expected)
    })

# Save results
with open("/home/etienne/Projects/FastTyper/backend/benchmark_results.json", "w") as f:
    json.dump(results, f, indent=2)

print("\n=== BENCHMARK COMPLETED ===")
