#!/usr/bin/env python3
"""Paperclip → OpenViking 单向同步（MUL-519 决策 24 / 25）。

四类资产，按每类的 updatedAt 与上次时间戳比对，只推变过的，逐文件 ov write 覆盖。
不用 add-resource 整树重推：那会让 OV 把整棵树重新 embedding，几百张卡每次几毛钱且慢。

  Rules   → viking://resources/team/rules/{resident,action}/*.md
  Wiki    → viking://resources/team/wiki/<space>/<path>.md   （不含 personal：那是各端
            CLAUDE.md / AGENTS.md 的镜像，Claude 自己会加载，OV 再召回等于同一内容两处进上下文）
  Skills  → viking://agent/skills/<slug>/SKILL.md            （OV 正式 skill 类型，决策 3）
  Issues  → viking://resources/team/issues/<MUL-N>/*.md      （只 done 卡，四类文档，不含 decision-log）
            **不在默认同步里**（2026-09-03）：卡是流水账，未经整理直接进 OV 会挤占召回位、
            把半成品结论当事实召回。需要时手动 `--only issues` 推，整理过再推。

用法：ov-sync.py [--force] [--only rules,wiki,skills]   # issues 要手动加
"""
import argparse, json, os, re, subprocess, sys, tempfile, urllib.request, urllib.parse
import yaml
from datetime import datetime, timezone

API = os.environ.get("PAPERCLIP_API_BASE", "http://localhost:3100")
COMPANY = os.environ.get("PAPERCLIP_COMPANY_ID", "b982ca51-95fb-4ba2-afa6-a3444d6c3c54")
KEYFILE = os.path.expanduser("~/.paperclip/keys/claude-terminal")
OV = os.path.expanduser("~/开源工具/OpenViking/.venv/bin/ov")
STAMP = os.path.expanduser("~/.paperclip/ov-sync.stamp.json")
LOG = os.path.expanduser("~/.paperclip/ov-sync.log")

ISSUE_DOCS = ("tech-proposal", "requirements", "settled-decisions", "glossary")
# 配套插件已删（MUL-519 决策 10），这两个 skill 的 SKILL.md 过不了 add-skill 校验，也没人用
SKIP_SKILLS = {"llm-wiki-maintainer", "paperclip-distill"}
# 触发形态切分与 MUL-515 实测一致；认不出的节归常驻，宁可多注入不可漏
RESIDENT_PREFIX = ("第〇条", "一、", "六、", "七、", "八、")
ACTION_PREFIX = ("第〇·五条", "二、", "三、", "四、", "八·五、", "九、")


def log(msg):
    line = f"{datetime.now().strftime('%F %T')} {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def get(path):
    key = open(KEYFILE).read().strip()
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {key}"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def rows(p):
    if isinstance(p, list):
        return p
    for k in ("issues", "documents", "items", "skills", "notes"):
        if isinstance(p.get(k), list):
            return p[k]
    return []


def _ov(args, timeout=60):
    r = subprocess.run([OV, *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stderr or r.stdout)


def frontmatter_ok(text):
    """OV 的 add-skill 严格解析 YAML frontmatter，Claude Code 的解析器容忍。差异最常撞在
    未加引号的标量里含 ": "（例如 description 写「…in English or Chinese: grill, …」），
    OV 报 [INTERNAL] Internal server error，完全不指向 YAML，资产就这么静默丢了。"""
    if not text.startswith("---"):
        return True, ""
    end = text.find("\n---", 3)
    if end < 0:
        return False, "frontmatter 没有结束的 ---"
    try:
        yaml.safe_load(text[3:end])
    except yaml.YAMLError as e:
        hint = str(e).replace(chr(10), " ")[:160]
        return False, f"frontmatter YAML 非法（{hint}）；最常见成因是未加引号的值里含冒号加空格，加双引号或改用 >- 折叠"
    return True, ""


def ov_write(uri, text, on_missing="create"):
    """replace 对不存在的文件报 NOT_FOUND（CLI 不像 MCP write 那样自动建），
    所以先 replace，没有再按 on_missing 建：普通文件用 create，skill 走 add-skill 才会按
    skill 类型登记（2026-09-02 首次全量推 50 个 NOT_FOUND 后加的）。"""
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(text)
        tmp = f.name
    try:
        rc, out = _ov(["write", uri, "--from-file", tmp, "--mode", "replace"])
        if rc == 0:
            return True
        if "NOT_FOUND" not in out:
            log(f"  ! write {uri}: {out.strip().replace(chr(10), ' ')[:200]}")
            return False
        if on_missing == "skill":
            ok, why = frontmatter_ok(text)
            if not ok:
                log(f"  ! skip {uri}: {why}")
                return False
            slug = uri.split("/skills/")[1].split("/")[0]
            d = tempfile.mkdtemp(); sd = os.path.join(d, slug); os.makedirs(sd)
            open(os.path.join(sd, "SKILL.md"), "w").write(text)
            rc, out = _ov(["add-skill", sd, "-p", "viking://agent/skills"], timeout=120)
        else:
            rc, out = _ov(["write", uri, "--from-file", tmp, "--mode", "create"])
        if rc != 0:
            log(f"  ! create {uri}: {out.strip().replace(chr(10), ' ')[:200]}")
        return rc == 0
    finally:
        os.unlink(tmp)


def newer(ts, since):
    return not since or (ts or "") > since


# 渲染配对：`server/src/services/team-doc-ov-sink.ts` 在 MUL-559 第 4 步之后把同样两个
# URI 从同样的数据渲染出来（观察期两个写入方并存），两边必须一起改，否则 OV 上的文件会
# 在两种渲染之间反复翻转且不报任何错。
def sync_rules(since):
    notes = rows(get(f"/api/companies/{COMPANY}/team-rules/notes"))
    changed = [n for n in notes if newer(n.get("updatedAt"), since)]
    if not changed:
        return 0, 0
    full = "\n\n".join(n.get("body") or "" for n in notes)
    parts = re.split(r"\n(?=## )", full)
    head, res, act = [], [], []
    for p in parts:
        t = p.split("\n")[0]
        if not t.startswith("## "):
            head.append(p); continue
        tag = t[3:]
        (act if any(tag.startswith(k) for k in ACTION_PREFIX) else res).append(p)
    n = f = 0
    ok = ov_write("viking://resources/team/rules/resident/resident.md",
                  "# Team Rules · 常驻组\n\n> 每轮生效，SessionStart 全文注入，不走召回。用户提问里没有词能召回它们，召回不到等于静默失效（MUL-515）。\n\n" + "\n".join(head) + "\n" + "\n".join(res))
    n, f = n + ok, f + (not ok)
    ok = ov_write("viking://resources/team/rules/action/action.md",
                  "# Team Rules · 动作组\n\n> 挂在建卡 / 开分支 / 写卡 / 推状态 / 评审这些确定动作上，走 OV 按需召回（MUL-515）。\n\n" + "\n".join(act))
    return n + ok, f + (not ok)


def sync_wiki(since):
    n = f = 0
    for space in ("paperclip", "agent"):
        for pg in rows(get(f"/api/companies/{COMPANY}/team-wiki/{space}/pages")):
            if not newer(pg.get("updatedAt"), since):
                continue
            path = re.sub(r"[^\w\-./一-鿿]", "_", pg.get("path") or pg["id"]).strip("/")
            if not path.endswith(".md"):
                path += ".md"
            # 与服务端 team-doc-ov-sink.ts 的 renderWikiPage 保持一字一致：
            # 两边写同一批 URI，格式不同就会互相覆盖掉对方的那一行。
            body = (f"# {pg.get('title','')}\n\n"
                    f"> source: paperclip team-wiki / {space} / {pg.get('path')}\n"
                    f"> id: {pg['id']}\n\n"
                    f"{pg.get('body') or ''}")
            ok = ov_write(f"viking://resources/team/wiki/{space}/{path}", body)
            n, f = n + ok, f + (not ok)
    return n, f


def sync_skills(since):
    n = f = 0
    for s in rows(get(f"/api/companies/{COMPANY}/skills")):
        slug = s.get("slug") or s.get("key")
        if not slug or slug in SKIP_SKILLS or not newer(s.get("updatedAt"), since):
            continue
        try:
            f = get(f"/api/companies/{COMPANY}/skills/{s['id']}/files?path=SKILL.md")
            body = f.get("content") if isinstance(f, dict) else ""
        except Exception as e:
            log(f"  ! skill {slug} 读不到 SKILL.md: {e}"); f += 1; continue
        if not body:
            continue
        # write 覆盖已存在的；第一次不存在时 write 会建目录但不会按 skill 类型登记，
        # 所以先试 write，失败再走 add-skill 注册
        ok = ov_write(f"viking://agent/skills/{slug}/SKILL.md", body, on_missing="skill")
        n, f = n + ok, f + (not ok)
    return n, f


def sync_issues(since):
    n = f = 0
    issues = [i for i in rows(get(f"/api/companies/{COMPANY}/issues")) if i.get("status") == "done"]
    for iss in issues:
        if not newer(iss.get("updatedAt") or iss.get("completedAt"), since):
            continue
        ident = iss.get("identifier") or iss["id"][:8]
        safe = re.sub(r"[^\w\-]", "_", ident)
        base = f"viking://resources/team/issues/{safe}"
        closed = (iss.get("completedAt") or iss.get("updatedAt") or "")[:10]
        head = (f"# {ident} {iss.get('title','')}\n\n"
                f"> status: done · closed_at: {closed} · priority: {iss.get('priority')}\n"
                f"> source: paperclip issue {ident}\n\n")
        ok = ov_write(f"{base}/issue.md", head + (iss.get("description") or ""))
        n, f = n + ok, f + (not ok)
        try:
            docs = {d["key"]: d for d in rows(get(f"/api/issues/{iss['id']}/documents")) if d.get("key") in ISSUE_DOCS}
        except Exception as e:
            log(f"  ! {ident} documents: {e}"); f += 1; continue
        for k, doc in docs.items():
            ok = ov_write(f"{base}/{k}.md", f"# {ident} · {k}\n\n> source: paperclip issue {ident} document {k}\n\n{doc.get('body') or ''}")
            n, f = n + ok, f + (not ok)
    return n, f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="忽略时间戳全量推")
    ap.add_argument("--only", default="rules,wiki,skills")  # issues 不进默认，见文件头
    a = ap.parse_args()
    # stamp 按类合并，不整体覆盖：--only issues --force 曾把 rules/wiki/skills 的时间戳一起抹掉，
    # 下一次增量又把那 30 个文件全推了一遍
    stamp = json.load(open(STAMP)) if os.path.exists(STAMP) else {}
    if a.force:
        for k in a.only.split(","):
            stamp.pop(k.strip(), None)
    now = datetime.now(timezone.utc).isoformat()
    kinds = {"rules": sync_rules, "wiki": sync_wiki, "skills": sync_skills, "issues": sync_issues}
    log(f"start force={a.force} only={a.only}")
    for k in a.only.split(","):
        k = k.strip()
        if k not in kinds:
            continue
        try:
            # The checkpoint is what says "everything up to here is in OV". A
            # single failed ov_write used to be counted as 0 and the timestamp
            # moved anyway, so that file was never retried — it stayed stale
            # until the next unrelated edit or a --force. Hold the checkpoint
            # for the whole kind instead: the next run re-pushes the ones that
            # already landed (ov_write is an idempotent replace) and retries
            # the one that did not.
            n, f = kinds[k](stamp.get(k))
            if f:
                log(f"  {k}: 推了 {n} 个文件，{f} 个失败 → 时间戳不推进，下次重试")
            else:
                stamp[k] = now
                log(f"  {k}: 推了 {n} 个文件")
        except Exception as e:
            log(f"  ! {k} 失败: {e}")
    os.makedirs(os.path.dirname(STAMP), exist_ok=True)
    json.dump(stamp, open(STAMP, "w"), indent=1)
    log("done")


if __name__ == "__main__":
    main()
