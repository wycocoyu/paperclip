import { describe, expect, it } from "vitest";
import {
  RULES_ACTION_URI,
  RULES_RESIDENT_URI,
  openVikingSink,
  renderRulesDocuments,
  renderWikiPage,
  wikiPageUri,
} from "../services/team-doc-ov-sink.js";

/**
 * Pins the rendering `scripts/ov-sync/ov-sync.py` produces for the same rows.
 * Both write these URIs during the MUL-559 step-6 observation window, so a
 * renderer that drifts makes the OpenViking file flap between two writers
 * with no error anywhere. Verified byte-identical against that script's own
 * `sync_rules` / `sync_wiki` on 2026-09-07 (2 rules + 11 wiki files).
 */
describe("team doc OpenViking rendering", () => {
  it("splits rules into the resident and action groups by section prefix", () => {
    const { resident, action } = renderRulesDocuments({
      companyId: "c",
      notes: [{ title: "Rules", body: "preamble\n## 一、身份\nident\n## 二、建卡\ncards\n## 九、评审\nreview" }],
    });
    expect(resident).toBe(
      "# Team Rules · 常驻组\n\n"
      + "> 每轮生效，SessionStart 全文注入，不走召回。用户提问里没有词能召回它们，召回不到等于静默失效（MUL-515）。\n\n"
      + "preamble\n## 一、身份\nident",
    );
    expect(action).toBe(
      "# Team Rules · 动作组\n\n"
      + "> 挂在建卡 / 开分支 / 写卡 / 推状态 / 评审这些确定动作上，走 OV 按需召回（MUL-515）。\n\n"
      + "## 二、建卡\ncards\n## 九、评审\nreview",
    );
  });

  it("keeps the unconditional newline between the preamble and the resident sections", () => {
    // ov-sync.py joins as head + "\n" + resident even when head is empty; an
    // "improved" conditional here is exactly what would start the flapping.
    const { resident } = renderRulesDocuments({ companyId: "c", notes: [{ title: "R", body: "## 一、x\nbody" }] });
    expect(resident.endsWith("（MUL-515）。\n\n\n## 一、x\nbody")).toBe(true);
  });

  it("joins multiple notes with a blank line, in list order", () => {
    const { resident } = renderRulesDocuments({
      companyId: "c",
      notes: [{ title: "a", body: "first" }, { title: "b", body: "second" }],
    });
    expect(resident.endsWith("first\n\nsecond\n")).toBe(true);
  });

  it("keeps CJK path segments and replaces everything else", () => {
    const snap = {
      companyId: "c", pageId: "p", space: "agent",
      path: "playbooks/建卡 流程", title: "T", body: "B",
    };
    expect(wikiPageUri(snap)).toBe("viking://resources/team/wiki/agent/playbooks/建卡_流程.md");
    expect(wikiPageUri({ ...snap, path: "/a/b.md/" })).toBe("viking://resources/team/wiki/agent/a/b.md");
  });

  it("labels a wiki page with its untouched source path", () => {
    expect(renderWikiPage({
      companyId: "c", pageId: "p", space: "agent", path: "a b/c", title: "Title", body: "Body",
    })).toBe("# Title\n\n> source: paperclip team-wiki / agent / a b/c\n\nBody");
  });

  it("never pushes the personal space", async () => {
    // Those pages are each terminal's own CLAUDE.md / AGENTS.md; recalling them
    // from OpenViking would inject the same text twice.
    const status = await openVikingSink.deliverWikiPage(
      { companyId: "c", pageId: "p", space: "personal", path: "claude/CLAUDE.md", title: "T", body: "B" },
      // A push would spawn this path and fail loudly; a skip never touches it.
      { ovBin: "/nonexistent/ov", companyId: "c" },
    );
    expect(status).toBe("skipped-space=personal");
  });

  it("addresses the two rules documents by their fixed URIs", () => {
    expect(RULES_RESIDENT_URI).toBe("viking://resources/team/rules/resident/resident.md");
    expect(RULES_ACTION_URI).toBe("viking://resources/team/rules/action/action.md");
  });
});
