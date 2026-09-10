import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  DECISION_BODY_SECTIONS,
  DECISION_BODY_TEMPLATE,
  REQUIRED_DECISION_LOG_SECTIONS,
} from "@paperclipai/shared";
import { DOCUMENT_SKELETONS } from "@paperclipai/shared/document-skeletons";
import { cn } from "@/lib/utils";

/**
 * Team Templates：把散在 CLI 骨架和服务端校验里的模板正文摆到一个人能看见的
 * 地方。原文一律从 shared 的常量读，不在这里复制一份——页面上看到的和
 * `document:get` 吐出来的、以及建卡时被拦下的，必须是同一份字符串。
 *
 * 有骨架的文档键只有两个（glossary / decision-log）。requirements、
 * tech-proposal、spec 没有骨架，页面照实说，不假装有。
 */

type Template = {
  id: string;
  name: string;
  /** 一句话：什么时候用它。 */
  when: string;
  /** 从哪里拿到它，或者它在哪一层被强制。 */
  source: string;
  /** 程序会不会拦，拦哪几格。 */
  enforced: string;
  body: string;
};

const TEMPLATES: Template[] = [
  {
    id: "decision-log",
    name: "decision-log · 决策流水账",
    when: "每拍一次板追加一条。讨论当轮就写，不攒到开工。",
    source: "开卡就播种一份（MUL-590）；老卡没有的，paperclipai issue document:get <卡号> decision-log 也会吐骨架",
    enforced: `七格是模板要求，程序硬校验其中四格：${REQUIRED_DECISION_LOG_SECTIONS.map((s) => `「${s}」`).join("")}。缺格时 CLI 抛错、服务端 422。「对审意见」不在硬校验里，但每条都要写，没送审就写「未审」。`,
    body: DOCUMENT_SKELETONS["decision-log"] ?? "",
  },
  {
    id: "glossary",
    name: "glossary · 本卡术语",
    when: "这张卡造了新词，或者某个词在本卡的含义和别处不同，才建。没造新词就不用写。",
    source: "paperclipai issue document:get <卡号> glossary",
    enforced: "不拦。收词两门靠自觉：有一条已定决策规定了词义，且按通用含义理解会改变本卡的范围、行为、验收或责任人。",
    body: DOCUMENT_SKELETONS.glossary ?? "",
  },
  {
    id: "decision-body",
    name: "决策卡正文 · 三节",
    when: "开一张决策卡（不是 decision-log 条目）时的正文。建卡前预填。",
    source: "建议正文，composing a proposal 时预填",
    enforced: `${DECISION_BODY_SECTIONS.map((s) => `「${s}」`).join("")}三节缺一不可，CLI 和服务端建卡路由双层硬拦（MUL-86）。`,
    body: DECISION_BODY_TEMPLATE,
  },
];

/**
 * 只有骨架不够，写的人还要知道三件容易只做一半的事。它们不在骨架正文里，
 * 因为骨架是要被复制走的，这几条是纪律不是内容。
 */
const RULES: Array<{ title: string; body: string }> = [
  {
    title: "标题行的形状是死的",
    body: "`## <编号> · <YYYY-MM-DD 可带 HH:MM> · <状态>`。切分条目靠正则认这一行，写歪了 decisions:pull 就漏掉这条，它不会报错。",
  },
  {
    title: "推翻旧决策要一次 put 做完两件事",
    body: "改旧条目状态行标「已被第 N 条推翻」，和追加新条目，必须放进同一次 document:put。分两次做很容易只做后一半，漏改状态行会让作废条目继续被算成「已定」。",
  },
  {
    title: "老板没发话的条目，格不能空",
    body: "「老板说」那格写明「本条老板未直接发话，由我主动记录」。空着会被当成缺格拦下。",
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "已复制" : "复制原文"}
    </button>
  );
}

export function TeamTemplates() {
  const [active, setActive] = useState(TEMPLATES[0].id);
  const current = TEMPLATES.find((t) => t.id === active) ?? TEMPLATES[0];

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Team Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          卡内文档的模板原文。这里显示的和 <code className="rounded bg-muted px-1">document:get</code> 吐给终端的是同一份，改模板改的是 shared 里的常量，不是这个页面。
        </p>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border pb-2" data-testid="team-template-tabs">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              active === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="space-y-3" data-testid="team-template-body">
        <dl className="grid gap-2 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-muted-foreground">什么时候用</dt>
          <dd className="text-foreground">{current.when}</dd>
          <dt className="text-muted-foreground">从哪里拿</dt>
          <dd className="font-mono text-xs text-foreground">{current.source}</dd>
          <dt className="text-muted-foreground">程序拦不拦</dt>
          <dd className="text-foreground">{current.enforced}</dd>
        </dl>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">模板原文</span>
          <CopyButton text={current.body} />
        </div>
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed text-foreground">
          <code>{current.body}</code>
        </pre>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">写的时候容易只做一半的三件事</h2>
        <div className="grid gap-2">
          {RULES.map((rule) => (
            <div key={rule.title} className="rounded-lg border border-border bg-card p-3">
              <p className="text-sm font-medium text-foreground">{rule.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{rule.body}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        没有骨架的文档键：<code className="rounded bg-muted px-1">requirements</code>、
        <code className="rounded bg-muted px-1">tech-proposal</code>、
        <code className="rounded bg-muted px-1">spec</code>。读它们只会拿到 404，正文形状目前没有定死的模板。
      </p>
    </div>
  );
}
