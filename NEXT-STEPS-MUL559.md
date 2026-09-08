# MUL-559 收尾执行清单

> 分支 `feature/wy/MUL-559/sidecar-fix`，6 个提交，未 push、未开 MR。
> 卡的完整交付记录在 Paperclip：`paperclipai issue get MUL-559`。
> 本文件只写「还要人做什么」，实施细节不重复，看卡上的 tech-proposal 与七条 progress。

## 为什么还需要人

两件事 Claude 没做，理由分别是：

1. **合并到 master** — push 与合并是不可逆的对外动作，Team Rules §七 要求先确认
2. **第 6 步删 hook** — 需要观察期，且要改 `~/.claude/settings.json`（用户配置）

## 第一步：合并

⚠️ 合并前先看清楚：本分支相对远端 master 领先 **20 个提交**，其中只有 **6 个是本卡的**（50 文件 / 3792 行新增）。另外 14 个是主仓上已提交但未推送的历史（最近三条是 MUL-558、MUL-555 那批门禁改动）。合并会把它们一起带上去。

试合冲突为 0。

```bash
cd ~/开源工具/paperclip
git merge feature/wy/MUL-559/sidecar-fix
# 或走 MR：先 push 分支再在 GitHub 上开
```

## 第二步：合并之后，第 5 步剩下三步（Claude 可代跑）

顺序不能变，任何一步跳过都会让 Cursor 从 17 个技能掉到 1 个。

```bash
# 1. 确认主仓 CLI 已支持 cursor 投影
grep TerminalSkillTool ~/开源工具/paperclip/cli/src/commands/client/skill-links.ts
#    应看到 ... | "cursor" | "custom"

# 2. 在主仓 checkout 跑一次投影（不能从 worktree 跑）
cd ~/开源工具/paperclip && paperclipai skills pull
#    验：~/.cursor/skills 下指向 skills-team 的链应从 1 条变成 18 条
ls -la ~/.cursor/skills/ | grep -c skills-team

# 3. 回收 17 条挂载链
paperclipai skills agent clear "Cursor（Terminal）" --yes
#    验：指向 managed source 的链应为 0，指向 skills-team 的仍是 18
ls -la ~/.cursor/skills/ | grep -c instances
```

## 第三步：第 6 步的观察期

出口条件四条，删 hook 前逐条确认：

```bash
# 条件 1：扇出连续运行 ≥ 7 天，起算 2026-09-07
# 条件 2：两个失败清单为空
KEY=$(cat ~/.paperclip/keys/claude-terminal)
CID=b982ca51-95fb-4ba2-afa6-a3444d6c3c54
curl -s "http://127.0.0.1:3100/api/companies/$CID/skills/fanout-failures" -H "Authorization: Bearer $KEY"
curl -s "http://127.0.0.1:3100/api/companies/$CID/team-docs/fanout-failures" -H "Authorization: Bearer $KEY"
#    两条都应返回 {"failures":[]}

# 条件 3：重启后对账 queued 为 0（看启动日志的 startup reconciliation 行）
# 条件 4：MUL-566 与 MUL-567 关闭（现均为 in_review）
```

**四条全过之后**才删这两个 hook（在 `~/.claude/settings.json` 里）：

```
UserPromptSubmit → /Users/mac/开源工具/paperclip/scripts/hooks/skills-pull.sh
UserPromptSubmit → /Users/mac/开源工具/paperclip/scripts/hooks/ov-sync.sh
```

### ⚠️ 删 hook 前必须知道的取舍

`ov-sync.sh` 带 `--force` 会无条件重推，覆盖的正是**水位机制的盲区**：水位记的是「我们发出去了什么」，不是「OV store 里现在是什么」。有人直接在 OpenViking 里改或删一个文件，任何一次重启都不会发现。

删 hook 等于放弃这层兜底。要补就得每次启动对 13 个 URI 各跑一次 `ov read` 比对，代价是每次重启的全量读取。**方案不预设这个取舍。**

### 双写现状

服务端已接管 Rules/Wiki 的 OV 推送，但两个 hook 都指向**主仓**脚本，worktree 里改好的 `ov-sync.py`（检查点语义修复）不生效。

双写当下安全（13 文件渲染逐字节一致已证 + 钉子测试），但 OV 侧没有 sidecar、没有锁、没有版本标记，靠纪律不靠机制。合并之后这个问题自动消失（主仓拿到修好的脚本）。

## 当前运行环境（合并后要恢复）

3100 的 Paperclip 服务端现在跑在**这个 worktree** 上，`tsx watch`，带四个环境变量：

```
PAPERCLIP_SKILLS_TEAM_DIR=/Users/mac/开源工具/paperclip-wt-MUL559/skills-team
PAPERCLIP_SKILLS_TEAM_COMPANY_ID=b982ca51-95fb-4ba2-afa6-a3444d6c3c54
PAPERCLIP_OV_SYNC_BIN=/Users/mac/开源工具/OpenViking/.venv/bin/ov
PAPERCLIP_OV_SYNC_COMPANY_ID=b982ca51-95fb-4ba2-afa6-a3444d6c3c54
```

合并之后应该切回主仓跑，那四个 env 要跟着带过去，其中 `SKILLS_TEAM_DIR` 要改成主仓的 `skills-team` 路径。**半配会拒启**（刻意设计），启动前 `printenv | grep PAPERCLIP_` 核对四条都在。

worktree 用完可以删：`git worktree remove ~/开源工具/paperclip-wt-MUL559`
