#!/usr/bin/env python3
"""
FastTyper Formatting Benchmark:
Evaluates 4 approaches for handling markdown formatting and dense typos:
1. Production Baseline: Regex <M0/> masking + Prompt E (current prod) + strict restoration
2. Prompt-Guided Masking: Regex <M0/> masking + Tag Preservation Rule in Prompt E + strict restoration
3. Native Markdown: No masking + Markdown Preservation Rule in Prompt E + direct diff
4. Resilient Hybrid: Method 2 (Prompt-guided masking), but if strict restoration fails,
   falls back to plaintext word alignment projection onto original formatting.
"""

import sys, os, json, re, time, urllib.request

URL = "http://127.0.0.1:8808/v1/chat/completions"
MODEL = "dyslexic-writer-qwen3-4b-q4_k_m.gguf"

# Matches markdown syntax identical to obsidian-plugin/src/main.ts
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

def strip_markdown(text):
    # Remove mask tags or standard markdown syntax
    s = re.sub(r"<M\d+/>", "", text)
    s = MARKDOWN_REGEX.sub("", s)
    return s

def align_plaintext_fallback(original_formatted, llm_output, mask_strings):
    """
    If restore_markdown failed, project the plain-text word corrections
    back into the original formatted string without destroying markdown syntax.
    """
    # 1. Clean LLM output of any partial mask tags
    cleaned_llm = re.sub(r"<M\d+/>", "", llm_output).strip()
    
    # 2. Extract words from original and LLM output
    # Find all word spans in original_formatted
    word_pattern = re.compile(r"[a-zA-Z0-9']+")
    orig_spans = [(m.start(), m.end(), m.group(0)) for m in word_pattern.finditer(original_formatted)]
    llm_words = word_pattern.findall(cleaned_llm)
    
    # If the word counts are wildly different, fall back to safe no-op
    # Simple LCS / Needleman-Wunsch word alignment:
    orig_words = [w for _, _, w in orig_spans]
    
    import difflib
    matcher = difflib.SequenceMatcher(None, [w.lower() for w in orig_words], [w.lower() for w in llm_words])
    
    # Build replacements on original_formatted
    replacements = [] # (start, end, new_text)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "replace":
            # Word i1..i2 replaced by j1..j2
            if i2 - i1 == j2 - j1:
                # 1-to-1 word replacement
                for k in range(i2 - i1):
                    start, end, _ = orig_spans[i1 + k]
                    new_word = llm_words[j1 + k]
                    replacements.append((start, end, new_word))
            else:
                # Multi-word replacement
                start = orig_spans[i1][0]
                end = orig_spans[i2 - 1][1]
                new_text = " ".join(llm_words[j1:j2])
                replacements.append((start, end, new_text))
        elif tag == "delete":
            # LLM deleted a word
            start = orig_spans[i1][0]
            end = orig_spans[i2 - 1][1]
            replacements.append((start, end, ""))
        elif tag == "insert":
            # Word inserted
            if i1 < len(orig_spans):
                pos = orig_spans[i1][0]
                replacements.append((pos, pos, " ".join(llm_words[j1:j2]) + " "))
    
    # Apply replacements from right to left
    res = original_formatted
    for start, end, new_text in sorted(replacements, key=lambda x: x[0], reverse=True):
        res = res[:start] + new_text + res[end:]
    return res

