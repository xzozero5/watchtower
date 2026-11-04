"""PreToolUse guard for Watchtower. Blocks (exit 2, reason on stderr):
1. Reading/printing secrets: files under secret/ dirs, .env*, or shell commands that echo/cat env vars holding keys
2. Destructive git: push --force / -f on main, --no-verify, reset --hard on main, branch -D main
3. rm -rf outside the project working tree (and on repo root)
4. Writes to evals/golden/** (producers must not edit their own grader data) and to HANDOFF.md/STATUS.md/BACKLOG.md by sub-agents
   (main thread sets WT_MAIN_THREAD=1 in env to allow; sub-agents inherit nothing by default)
5. Shell/HTTP calls that look like real writes to external services (LINE push/multicast/broadcast, Discord message create,
   Gmail send, GCP mutations) when WT_ALLOW_EXTERNAL_WRITES != 1 -- local dev must use mock mode.
Input: hook JSON on stdin (tool_name, tool_input). Checks only where a tool goes or what it runs, not document text."""
import json, os, re, sys
try:
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass
d = json.load(sys.stdin)
tool, ti = d.get("tool_name", "") or "", d.get("tool_input", {}) or {}

def block(msg):
    print(msg, file=sys.stderr); sys.exit(2)

path = ti.get("file_path") or ti.get("path") or ""
cmd = ti.get("command") if isinstance(ti.get("command"), str) else ""
proj = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

# 1. secrets
SECRET_PATH = re.compile(r"(^|[\\/])(secret|secrets)([\\/]|$)|(^|[\\/])\.env(\.|$)", re.I)
if path and SECRET_PATH.search(path) and not path.endswith(".env.example"):
    block("BLOCKED (N1): secret files are never read or written by agents. Load them into the environment instead.")
SECRET_CMD = re.compile(r"(cat|type|more|less|head|tail|echo|printenv|env\b|set\b|Get-Content|gc)\s+[^|;&\n]*(\.env\b(?!\.example)|secret|API_KEY|SECRET|TOKEN|PASSWORD)", re.I)
if cmd and SECRET_CMD.search(cmd):
    block("BLOCKED (N1): never print secrets or .env contents. Check only presence/length (e.g. [ -n \"$VAR\" ]).")

# 2. destructive git
if cmd:
    if re.search(r"git\s+push\b.*(--force|-f\b)", cmd) or re.search(r"--no-verify", cmd):
        block("BLOCKED (N9): git push --force / --no-verify are not allowed.")
    if re.search(r"git\s+(reset\s+--hard|branch\s+-D)\b.*\bmain\b", cmd):
        block("BLOCKED (N9): destructive operation on main.")
    # 3. rm -rf
    m = re.search(r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\S+)", cmd)
    if m:
        target = m.group(2).strip("'\"")
        if target in ("/", "~", ".", "..", "*") or target.startswith(("/", "~", "..")) and not os.path.abspath(target).startswith(os.path.abspath(proj)):
            block("BLOCKED (N9): rm -rf outside the project tree (or on the tree root) is not allowed.")

# 4. protected files for sub-agents
is_main = os.environ.get("WT_MAIN_THREAD") == "1"
if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit") and path:
    p = path.replace("\\", "/")
    if re.search(r"(^|/)evals/golden/", p):
        block("BLOCKED (N7): evals/golden/** is the grader's data. Propose additions to the main thread/owner instead.")
    if not is_main and re.search(r"(^|/)(HANDOFF\.md|docs/STATUS\.md|docs/BACKLOG\.md)$", p):
        block("BLOCKED: HANDOFF.md / docs/STATUS.md / docs/BACKLOG.md are written by the main thread only. Report your result instead.")
# 4b. golden data through the shell (2026-11-04: a script wrote evals/golden/*.json around the Write rule).
# Read-only git commands are fine; anything else that names the path is refused. A script that builds the path
# itself cannot be seen here, so tools/githooks/pre-commit also requires a review entry in evals/GOLDEN-REVIEW.md.
if cmd and re.search(r"evals[\\/]+golden", cmd) and not re.match(r"\s*git\s+(log|diff|show|status|blame)\b", cmd) \
        and not re.match(r"\s*(cat|ls|head|grep|rg|wc)\b", cmd):
    block("BLOCKED (N7): evals/golden/** is changed only by the main thread with the owner's approval. Propose cases in evals/proposals/ instead.")

# 5. external writes
if os.environ.get("WT_ALLOW_EXTERNAL_WRITES") != "1":
    targets = [cmd] + [v for k, v in ti.items() if isinstance(v, str) and k in ("url", "uri", "href")]
    EXT = re.compile(r"api\.line\.me/v2/bot/message/(push|multicast|broadcast|narrowcast)|discord\.com/api/.*/messages|gmail\.googleapis\.com/.*/messages/send|gcloud\s+\S+\s+(create|delete|update|deploy)|bq\s+(rm|mk|update|load)", re.I)
    if any(t and EXT.search(t) for t in targets):
        block("BLOCKED (N2/[ASK-HUMAN]): real external write detected. Use mock mode; set WT_ALLOW_EXTERNAL_WRITES=1 only with the owner's approval.")
sys.exit(0)
