#!/usr/bin/env python3
"""Claude Approvals without the Claude organization: read .claude/approvals.yml and say who still has to approve.

This is the check half of Claude Ship's Approvals agent, run from GitHub Actions
(.github/workflows/opencode-approvals.yml). It asks no model: the answer is a function of the policy on the default
branch, the pull request's changed files and reviews, and the Code review check.

What it evaluates (policy reference: code.claude.com/docs/en/approvals-policy):

  version: 1        required
  mode              `observe` (report only) or `enforce`
  rules[].paths     `**`, `*`, `?`, `[ab]`, `{a,b}` and `"!path"` exclusions
  rules[].verdict   `claude`: approves | comments | blocks; `seats`: a number, or sets `{count, from}`
  rules[].if        `pr/files_changed`, `pr/diff_lines`, `pr/base`, `pr/opened_by`, `pr/authors`, `pr/approved_by`,
                    and `claude/code_review`, joined with AND / OR and parentheses
  rules[].override  the first true one replaces the rule's verdict; it may read `claude/code_review`
  verdict.claude: approves  posts an approving review once every rule that applies allows it

What it refuses rather than guesses: `locals`/`use`, `reuse`, `findings`, nested policy files, teams, and any
classifier but `claude/code_review`. A refused policy is reported as **Cannot evaluate**, never as a pass.

    approvals.py --repo o/r --pr 12 --policy .claude/approvals.yml --out /tmp/approvals
"""
import argparse
import json
import os
import re
import subprocess
import sys

try:
    import yaml
except ImportError:  # the workflow installs it; a person running this needs it too
    yaml = None

TOP = {"version", "mode", "rules", "nested", "run", "locals"}
RULE = {"purpose", "paths", "verdict", "if", "override", "advisory", "reuse", "findings", "use", "mode", "nested", "run"}
RANK = {"approves": 0, "comments": 1, "blocks": 2}
WRITE = {"OWNER", "MEMBER", "COLLABORATOR"}
COMPARE = re.compile(r"^\s*(ANY|ALL)?\s*([a-z_]+/[a-z_]+)\s*(<=|>=|!=|=|<|>)\s*(.+?)\s*$")
CODE = re.compile(r"\.(rs|ts|tsx|js|jsx|py|go|swift|kt|java|zig|c|h|cc|cpp|sh|ps1|sql|yml|yaml|toml)$")


class Refuse(Exception):
    """The policy asks for something this checker does not evaluate."""


class NoAnswer(Refuse):
    """A comparison whose fact has no answer: the docs' rule is that the check fails, never that it passes."""


def glob(pattern, path):
    """One `paths` pattern, from the policy file's directory: `**` any folders, `*` within one."""
    out, i = ["^"], 0
    while i < len(pattern):
        c = pattern[i]
        if pattern[i:i + 2] == "**":
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            close = pattern.find("]", i)
            if close > i:
                out.append(pattern[i:close + 1])
                i = close + 1
            else:
                out.append(re.escape(c))
                i += 1
        elif c == "{":
            close = pattern.find("}", i)
            if close > i:
                out.append("(?:" + "|".join(re.escape(p) for p in pattern[i + 1:close].split(",")) + ")")
                i = close + 1
            else:
                out.append(re.escape(c))
                i += 1
        else:
            out.append(re.escape(c))
            i += 1
    out.append("$")
    return re.match("".join(out), path) is not None


def matches(rule, path):
    patterns = [str(p) for p in rule.get("paths") or []]
    keep = [p for p in patterns if not p.startswith("!")]
    drop = [p[1:] for p in patterns if p.startswith("!")]
    return any(glob(p, path) for p in keep) and not any(glob(p, path) for p in drop)


def load(text, allow=()):
    """The policy, checked against the keys this checker knows; anything else is refused by its name."""
    if yaml is None:
        raise Refuse("PyYAML is not installed")
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise Refuse(f"the policy is not YAML: {e}")
    if not isinstance(doc, dict):
        raise Refuse("the policy is not a mapping")
    unknown = set(doc) - TOP - set(allow)
    if unknown:
        raise Refuse(f"unknown top-level key {sorted(unknown)[0]}")
    if doc.get("version") != 1:
        raise Refuse("version must be 1")
    if doc.get("mode", "enforce") not in ("enforce", "observe"):
        raise Refuse(f"mode {doc.get('mode')!r} is not observe or enforce")
    if doc.get("locals"):
        raise Refuse("locals/use are not evaluated by this checker")
    rules = doc.get("rules")
    if not isinstance(rules, list) or not rules:
        raise Refuse("rules must be a non-empty list")
    for n, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise Refuse(f"rule {n} is not a mapping")
        unknown = set(rule) - RULE
        if unknown:
            raise Refuse(f"rule {rule.get('purpose', n)!r}: unknown key {sorted(unknown)[0]}")
        for key in ("use", "reuse", "findings"):
            if key in rule:
                raise Refuse(f"rule {rule.get('purpose', n)!r}: `{key}` is not evaluated by this checker")
        if not rule.get("purpose") or not rule.get("paths"):
            raise Refuse(f"rule {n} needs a purpose and paths")
        if not any(not str(p).startswith("!") for p in rule["paths"]):
            raise Refuse(f"rule {rule['purpose']!r}: paths needs at least one pattern with no `!`")
        if "verdict" in rule:
            _verdict(rule["verdict"], rule)
        for o in rule.get("override") or []:
            if not isinstance(o, dict) or "if" not in o:
                raise Refuse(f"rule {rule['purpose']!r}: an override needs an `if`")
            _verdict(o.get("verdict") or {}, rule)
        for name in (rule.get("advisory") or []):
            if name != "claude/code_review":
                raise Refuse(f"rule {rule['purpose']!r}: the classifier {name!r} is not evaluated by this checker")
    return doc


def _verdict(verdict, rule):
    if not isinstance(verdict, dict):
        raise Refuse(f"rule {rule['purpose']!r}: a verdict must be a mapping")
    unknown = set(verdict) - {"claude", "seats", "max_age"}
    if unknown:
        raise Refuse(f"rule {rule['purpose']!r}: unknown verdict key {sorted(unknown)[0]}")
    if "max_age" in verdict:
        raise Refuse(f"rule {rule['purpose']!r}: max_age is not evaluated by this checker")
    if verdict.get("claude") not in RANK:
        raise Refuse(f"rule {rule['purpose']!r}: claude must be approves, comments or blocks")
    if verdict.get("claude") == "blocks":
        if "seats" in verdict:
            raise Refuse(f"rule {rule['purpose']!r}: seats is refused beside blocks")
        return
    if "seats" not in verdict:
        raise Refuse(f"rule {rule['purpose']!r}: seats is required unless claude is blocks")
    for s in seats_of(verdict):
        if not isinstance(s["count"], int) or not 1 <= s["count"] <= 16:
            raise Refuse(f"rule {rule['purpose']!r}: a count is 1 to 16")


def seats_of(verdict):
    seats = verdict.get("seats")
    if seats is None:
        return []
    sets = seats if isinstance(seats, list) else [{"count": seats, "from": "humans"}]
    out = []
    for s in sets:
        if not isinstance(s, dict) or set(s) - {"count", "from"} or "count" not in s or "from" not in s:
            raise Refuse("a seat set is {count, from}")
        people(s["from"])
        out.append({"count": s["count"], "from": s["from"]})
    return out


def people(them):
    """Check one people list: the forms this checker reads, by name."""
    for item in (them if isinstance(them, list) else [them]):
        text = str(item)
        bare = text[1:] if text.startswith("!") else text
        if bare in ("humans", "bots", "everyone", "nobody", "pr/authors", "pr/opened_by"):
            continue
        if bare.startswith("bot:") or re.fullmatch(r"[A-Za-z0-9-]+", bare):
            continue
        raise Refuse(f"the people list item {text!r} (a team or another form) is not evaluated by this checker")


def _value(token):
    token = token.strip()
    if token.startswith("[") and token.endswith("]"):
        return [_value(x) for x in _split(token[1:-1])]
    if len(token) > 1 and token[0] == token[-1] and token[0] in "'\"":
        return token[1:-1]
    return int(token) if re.fullmatch(r"-?\d+", token) else token


def _split(text):
    """Commas outside brackets, so a list value stays one value."""
    out, depth, start = [], 0, 0
    for i, c in enumerate(text):
        depth += {"[": 1, "]": -1}.get(c, 0)
        if c == "," and depth == 0:
            out.append(text[start:i])
            start = i + 1
    out.append(text[start:])
    return [p.strip() for p in out if p.strip()]


def truth(condition, facts):
    """One `if`: `true`/`false`, or comparisons joined with AND / OR and parentheses. AND binds tighter."""
    if isinstance(condition, bool):
        return condition
    text = str(condition).strip()
    if text in ("true", "false"):
        return text == "true"
    return any(_and(p, facts) for p in _split_op(text, "OR"))


def _and(text, facts):
    return all(_compare(p.strip(), facts) for p in _split_op(text, "AND"))


def _split_op(text, op):
    """Split on a top-level `op` (not inside brackets)."""
    out, depth, start, i = [], 0, 0, 0
    while i < len(text):
        c = text[i]
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif depth == 0 and text.startswith(op, i) and (i == 0 or text[i - 1].isspace()) \
                and (i + len(op) == len(text) or text[i + len(op)].isspace()):
            out.append(text[start:i].strip())
            start = i + len(op)
            i = start
            continue
        i += 1
    out.append(text[start:].strip())
    return [p for p in out if p]


def _wrapped(text):
    """The inside of the parentheses when they wrap the whole expression, else None."""
    if not (text.startswith("(") and text.endswith(")")):
        return None
    depth = 0
    for i, c in enumerate(text):
        depth += {"(": 1, ")": -1}.get(c, 0)
        if depth == 0:
            return text[1:-1] if i == len(text) - 1 else None
    return None


def _compare(text, facts):
    text = text.strip()
    inner = _wrapped(text)
    if inner is not None:
        return truth(inner, facts)
    m = COMPARE.match(text)
    if not m:
        raise Refuse(f"the condition {text!r} is not one this checker reads")
    quant, name, op, raw = m.group(1), m.group(2), m.group(3), m.group(4)
    if name not in facts:
        raise NoAnswer(f"there is no answer for {name}")
    fact, value = facts[name], _value(raw)
    if isinstance(fact, (set, list, tuple)) or quant:
        them = fact if isinstance(fact, (set, list, tuple)) else {fact}
        listed = value if isinstance(value, list) else [value]
        if value == "empty":
            return (not them) if op == "=" else bool(them)
        if quant == "ALL":
            return all(any(_same(x, v) for v in listed) for x in them)
        if quant == "ANY":
            return any(_same(x, v) for x in them for v in listed)
        raise Refuse(f"{name} is a list; write ANY or ALL before it")
    if isinstance(fact, int) and isinstance(value, str) and re.fullmatch(r"-?\d+", value):
        value = int(value)
    return {"=": fact == value, "!=": fact != value, "<": fact < value, "<=": fact <= value,
            ">": fact > value, ">=": fact >= value}[op]


def _same(a, b):
    return str(a).lower() == str(b).lower()


def admits(them, who, facts):
    """Whether `who` ({login, kind}) fills a seat in this people list."""
    items = [str(i) for i in (them if isinstance(them, list) else [them])]
    if "nobody" in items:
        return False
    allowed = False
    for bare in (i for i in items if not i.startswith("!")):
        if bare == "everyone":
            allowed = True
        elif bare == "humans":
            allowed |= who["kind"] == "human"
        elif bare == "bots":
            allowed |= who["kind"] == "bot"
        elif bare == "pr/authors":
            allowed |= who["login"].lower() in {a.lower() for a in facts.get("pr/authors") or []}
        elif bare == "pr/opened_by":
            allowed |= who["login"].lower() == str(facts.get("pr/opened_by") or "").lower()
        elif bare.startswith("bot:"):
            allowed |= who["kind"] == "bot" and who["login"].lower() == bare[4:].lower()
        else:
            allowed |= who["login"].lower() == bare.lower()
    for bare in (i[1:] for i in items if i.startswith("!")):
        if bare == "pr/authors" and who["login"].lower() in {a.lower() for a in facts.get("pr/authors") or []}:
            allowed = False
        elif who["login"].lower() == bare.lower():
            allowed = False
    return allowed


def verdict_of(rule, facts):
    """A rule's verdict for this pull request: its own, or its first true override."""
    verdict = dict(rule["verdict"])
    for override in rule.get("override") or []:
        if truth(override["if"], facts):
            verdict.update(override.get("verdict") or {})
            break
    return verdict


def decide(policy, files, facts, approvers, author):
    """The pull request's verdict, its seats, and who it waits on. Seats are counted once per rule that applies, and
    whether Claude may fill one is read from Code review's answer in the same facts the rules read."""
    claude_approves = facts.get("claude/code_review") == "pass"
    enforcing = [r for r in policy["rules"] if "verdict" in r and r.get("mode", "enforce") == "enforce"]
    uncovered, no_rule, no_answer, applied = [], [], [], []
    for path in files:
        covering = [r for r in enforcing if matches(r, path)]
        if not covering:
            uncovered.append(path)
            continue
        wants = []
        for rule in covering:
            try:
                if "if" not in rule or truth(rule["if"], facts):
                    wants.append(rule)
            except NoAnswer as e:
                no_answer.append(f"{path}: {e}")
        if not wants:
            no_rule.append(path)
            continue
        for rule in wants:
            if rule not in applied:
                applied.append(rule)
    if no_answer:
        return {"state": "no_answer", "file": no_answer[0], "verdict": None, "seats": [], "required": 0, "have": 0}
    if no_rule:
        return {"state": "no_rule", "file": no_rule[0], "verdict": None, "seats": [], "required": 0, "have": 0}
    if not applied:
        return {"state": "uncovered", "verdict": None, "seats": [], "required": 0, "have": 0,
                "uncovered": sorted(uncovered)}
    verdicts = [verdict_of(rule, facts) for rule in applied]
    verdict = max(verdicts, key=lambda v: RANK[v["claude"]])
    seats = [s for v in verdicts for s in seats_of(v)]
    required, have, waiting = sum(s["count"] for s in seats), 0, []
    for s in seats:
        filled = sum(1 for who in approvers if admits(s["from"], who, facts))
        if author and admits(s["from"], author, facts):
            filled += 1
        if claude_approves and admits(s["from"], {"login": "claude", "kind": "bot"}, facts):
            filled += 1
        filled = min(filled, s["count"])
        have += filled
        if filled < s["count"]:
            waiting.append({"need": s["count"], "have": filled, "from": s["from"]})
    state = "blocked" if verdict["claude"] == "blocks" else ("wait" if waiting else "pass")
    return {"state": state, "verdict": verdict, "seats": seats, "required": required, "have": have,
            "waiting": waiting, "uncovered": sorted(uncovered)}


def title(result):
    prefix = "(observe mode) " if result.get("mode") == "observe" else ""
    state = result["state"]
    if state == "uncovered":
        return prefix + "Nothing ran, not blocking: no file is covered"
    if state == "no_rule":
        return prefix + f"No rule applies to {result['file']}"
    if state == "no_answer":
        return prefix + f"Cannot evaluate: {result['file']}"
    if state == "blocked":
        return prefix + "Blocked by policy"
    if state == "wait":
        items = result["waiting"][0]["from"]
        items = [str(i) for i in (items if isinstance(items, list) else [items])]
        bare = [i.lstrip("!") for i in items]
        who = "any person"
        if "pr/authors" in bare and "!pr/authors" in items:
            who = "a person other than the author"
        elif "pr/authors" in bare:
            who = "the author"
        return prefix + f"Waiting on human review from {who} ({result['have']}/{result['required']})"
    return prefix + f"Policy satisfied ({result['have']}/{result['required']})"


def conclusion(result):
    if result.get("mode") == "observe":
        return "neutral"
    if result["state"] == "pass":
        return "success"
    return "neutral" if result["state"] == "uncovered" else "failure"


def body(result, pr, why=None):
    lines = [f"### {title(result)}", ""]
    if why:
        lines += [why, ""]
    if result["state"] == "pass":
        lines.append("Every rule that applies is satisfied. The merge still follows the branch rules.")
    elif result["state"] == "wait":
        lines += ["Who still has to approve:", ""]
        for w in result["waiting"]:
            them = w["from"] if isinstance(w["from"], list) else [w["from"]]
            lines.append(f"- {w['need'] - w['have']} more from {', '.join(str(t) for t in them)}")
    elif result["state"] == "uncovered":
        lines.append("No rule in `.claude/approvals.yml` covers the files this pull request changes, so this check asks nobody and does not block.")
    elif result["state"] == "no_rule":
        lines.append(f"`{result['file']}` is covered by rules and none of them applies. Give the rule a fallback with no `if`.")
    elif result["state"] == "no_answer":
        lines.append(f"A rule's condition has no answer ({result['file']}), so the check fails rather than passing.")
    elif result["state"] == "blocked":
        lines.append("A rule says Claude blocks this change, so the check fails whoever approves.")
    if result.get("uncovered") and result["state"] in ("pass", "wait"):
        lines += ["", f"Claude does not approve: no rule covers {', '.join('`' + f + '`' for f in result['uncovered'][:5])}."]
    lines += ["", "The policy is read from the default branch: `.claude/approvals.yml` (see `docs/CI-AGENTS.md`)."]
    return "\n".join(lines)


class Gh:
    def __init__(self):
        self.env = dict(os.environ)

    def api(self, path, *flags):
        out = subprocess.run(["gh", "api", path, *flags], capture_output=True, text=True, env=self.env)
        if out.returncode != 0:
            raise RuntimeError(f"gh api {path}: {out.stderr.strip()[:300]}")
        return json.loads(out.stdout) if out.stdout.strip().startswith(("{", "[")) else out.stdout

    def pages(self, path):
        return [item for page in self.api(path, "--paginate", "--slurp") for item in page]

    def post(self, path, payload):
        return subprocess.run(["gh", "api", "-X", "POST", path, "--input", "-"], input=json.dumps(payload),
                              capture_output=True, text=True, env=self.env)


def _human(user):
    return bool(user) and user.get("type") != "Bot" and not str(user.get("login", "")).endswith("[bot]")


def nested_policy(files):
    """A policy file below the root: this checker reads the root file alone, so it says so rather than half-covering."""
    for path in files:
        parts = path.split("/")
        if len(parts) >= 2 and parts[-1] in ("approvals.yml", "approvals.yaml") and parts[-2] == ".claude":
            if parts[:-2]:
                return path
    return None


def gather(gh, repo, number):
    pr = gh.api(f"repos/{repo}/pulls/{number}")
    files = [f for f in gh.pages(f"repos/{repo}/pulls/{number}/files") if f.get("status") != "removed"]
    reviews = gh.pages(f"repos/{repo}/pulls/{number}/reviews")
    latest = {}
    for review in sorted(reviews, key=lambda r: r.get("submitted_at") or ""):
        latest[(review.get("user") or {}).get("login", "")] = review
    approvers = [{"login": login, "kind": "human", "author": False} for login, review in latest.items()
                 if review.get("state") == "APPROVED" and _human(review.get("user"))
                 and review.get("author_association") in WRITE]
    commits = gh.pages(f"repos/{repo}/pulls/{number}/commits")
    opener = (pr.get("user") or {}).get("login", "")
    last = (commits[-1].get("commit") or {}) if commits else {}
    head_author = ((last.get("author") or {}).get("login") or (last.get("committer") or {}).get("login") or "") or opener
    authors = {str(head_author).lower()}
    author = {"login": opener, "kind": "human", "author": True} if _human(pr.get("user")) and \
        str(head_author).lower() == str(opener).lower() else None
    return {
        "files": [f.get("filename") for f in files],
        "facts": {
            "pr/files_changed": len(files),
            "pr/diff_lines": sum(int(f.get("additions") or 0) + int(f.get("deletions") or 0) for f in files),
            "pr/base": (pr.get("base") or {}).get("ref", ""),
            "pr/opened_by": opener,
            "pr/authors": authors,
            "pr/approved_by": {a["login"] for a in approvers},
        },
        "approvers": approvers,
        "author": author,
        "compiled": any(CODE.search(f.get("filename", "")) for f in files),
    }


def review_answer(gh, repo, head):
    """What Code review said about this commit: pass, fail, or None when it said nothing."""
    runs = gh.api(f"repos/{repo}/commits/{head}/check-runs?per_page=100").get("check_runs", [])
    ours = [r for r in runs if r.get("name") == "Code review"]
    if not ours:
        return None
    text = ((max(ours, key=lambda r: r.get("started_at") or "").get("output") or {}).get("text") or "").strip()
    m = re.search(r"<!-- bughunter-severity: (\{.*\}) -->", text.splitlines()[-1] if text else "")
    if not m:
        return None
    try:
        return "pass" if int(json.loads(m.group(1)).get("normal") or 0) == 0 else "fail"
    except (json.JSONDecodeError, ValueError):
        return None


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--pr", required=True, type=int)
    p.add_argument("--policy", default=".claude/approvals.yml")
    p.add_argument("--out", default=".")
    p.add_argument("--name", default="Claude Approvals")
    p.add_argument("--dry-run", action="store_true", help="print what the check would say instead of posting it")
    a = p.parse_args(argv)
    gh = Gh()
    os.makedirs(a.out, exist_ok=True)
    head = gh.api(f"repos/{a.repo}/pulls/{a.pr}")["head"]["sha"]

    def finish(result, report, refuse=None):
        result["mode"] = result.get("mode") or mode
        title_ = f"Cannot evaluate: {refuse}" if refuse else title(result)
        report_text = report if not refuse else f"### {title_}\n\n{report}\n\nThe check asks nobody and does not block. Fix the policy on the default branch."
        if a.dry_run:
            print(f"APPROVALS {json.dumps({'title': title_, 'conclusion': conclusion(result), 'state': result['state'], 'dry_run': True})}")
            print(report_text)
            return
        payload = {"name": a.name, "head_sha": head, "status": "completed",
                   "conclusion": "failure" if refuse and mode == "enforce" else conclusion(result),
                   "output": {"title": title_[:120], "summary": report_text[:65000]}}
        out = gh.post(f"repos/{a.repo}/check-runs", payload)
        if out.returncode != 0:
            raise RuntimeError(f"check run: {out.stderr.strip()[:300]}")
        marker = "<!-- opencode-approvals -->"
        mine = [c for c in gh.pages(f"repos/{a.repo}/issues/{a.pr}/comments") if marker in (c.get("body") or "")]
        comment = f"{marker}\n{report_text}"
        if mine:
            subprocess.run(["gh", "api", "-X", "PATCH", f"repos/{a.repo}/issues/comments/{mine[0]['id']}", "--input", "-"],
                           input=json.dumps({"body": comment}), capture_output=True, text=True, env=gh.env)
        else:
            gh.post(f"repos/{a.repo}/issues/{a.pr}/comments", {"body": comment})
        json.dump({"pr": a.pr, "head": head, "title": title_, "conclusion": conclusion(result), "state": result["state"]},
                  open(os.path.join(a.out, "result.json"), "w"), indent=2)
        print(f"APPROVALS {json.dumps({'title': title_, 'conclusion': conclusion(result), 'state': result['state']})}")

    mode = "enforce"
    try:
        with open(a.policy, encoding="utf-8") as f:
            policy = load(f.read())
        mode = policy.get("mode", "enforce")
    except FileNotFoundError:
        return finish({"state": "uncovered", "mode": "observe", "seats": [], "required": 0, "have": 0, "verdict": None},
                      body({"state": "uncovered", "mode": "observe"}, a.pr, "There is no `.claude/approvals.yml` on the default branch."))
    except Refuse as e:
        mode = _mode_on_disk(a.policy)
        return finish({"state": "uncovered", "mode": mode, "seats": [], "required": 0, "have": 0, "verdict": None}, str(e), refuse=e)

    data = gather(gh, a.repo, a.pr)
    nested = nested_policy(data["files"])
    if nested:
        return finish({"state": "uncovered", "mode": mode, "seats": [], "required": 0, "have": 0, "verdict": None},
                      f"`{nested}` is a policy file below the root. This checker reads `.claude/approvals.yml` only, so it "
                      "cannot say what the nearer file decides.", refuse=f"a nested policy file ({nested})")
    facts = dict(data["facts"])
    code_review = review_answer(gh, a.repo, head) if data["compiled"] else None
    if code_review:
        facts["claude/code_review"] = code_review
    try:
        result = decide(policy, data["files"], facts, data["approvers"], data["author"])
        result["mode"] = mode
        report = body(result, a.pr)
        report += f"\n\nCode review: {code_review or 'no answer'}. Approvers: {', '.join(x['login'] for x in data['approvers']) or 'nobody yet'}."
    except Refuse as e:
        return finish({"state": "uncovered", "mode": mode, "seats": [], "required": 0, "have": 0, "verdict": None}, str(e), refuse=e)

    finish(result, report)

    if a.dry_run:
        return 0
    allows = result["verdict"] and result["verdict"].get("claude") == "approves"
    if allows and result["state"] == "pass" and not result.get("uncovered") and mode == "enforce" \
            and code_review == "pass":
        already = [r for r in gh.pages(f"repos/{a.repo}/pulls/{a.pr}/reviews")
                   if (r.get("user") or {}).get("login", "").startswith("github-actions")
                   and r.get("state") == "APPROVED" and r.get("commit_id") == head]
        if not already:
            out = gh.post(f"repos/{a.repo}/pulls/{a.pr}/reviews",
                          {"commit_id": head, "event": "APPROVE",
                           "body": "Claude Approvals: the policy is satisfied and every rule that applies allows an approval."})
            print(f"APPROVALS review {'posted' if out.returncode == 0 else 'refused: ' + out.stderr.strip()[:200]}")
    return 0


def _mode_on_disk(path):
    try:
        with open(path, encoding="utf-8") as f:
            return ((yaml.safe_load(f) or {}) if yaml else {}).get("mode", "enforce")
    except Exception:
        return "enforce"


if __name__ == "__main__":
    sys.exit(main())
