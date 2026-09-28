import { memo } from "react";
import dosuOfficialUrl from "./assets/dosu-official.svg";
import { dosuToolDisplayName, isDosuToolName } from "./dosu-tool.ts";
import { firstLine, isPresent } from "./format.ts";
import { Icon } from "./icons.tsx";
import { cleanSessionTitle } from "./session-title.ts";
import { specialTranscriptBlock } from "./transcript.tsx";
import type {
  IconName,
  SessionDetailData,
  SessionOutlineItemData,
  SessionSummary,
} from "./types.ts";

export function threadToc(messages: SessionDetailData["messages"]): ThreadTocItem[] {
  return messages.flatMap((message) => {
    const items: ThreadTocItem[] = [];
    // Compact summaries are machine-generated continuations, not prompts.
    if (message.role === "user" && !message.is_compact_summary) {
      const label =
        message.blocks.find((block) => block.block_type === "text" && isPresent(block.text))
          ?.text ?? "";
      if (label.trim() !== "") {
        items.push({
          key: `prompt:${message.seq}`,
          seq: message.seq,
          kind: "prompt",
          ...tocPresentation(label),
        });
      }
    }
    for (const block of message.blocks) {
      if (block.block_type !== "tool_use" || !isDosuToolName(block.tool_name)) {
        continue;
      }
      items.push({
        key: `dosu:${message.seq}:${block.ordinal}`,
        seq: message.seq,
        label: dosuToolDisplayName(block.tool_name),
        icon: "bolt",
        kind: "dosu",
      });
    }
    return items;
  });
}

export function threadTocFromOutline(outline: SessionOutlineItemData[]): ThreadTocItem[] {
  return outline.map((item) =>
    item.kind === "dosu"
      ? {
          key: `dosu:${item.seq}:${item.ordinal}`,
          seq: item.seq,
          label: item.text || "Dosu tool",
          icon: "bolt",
          kind: "dosu",
        }
      : {
          key: `prompt:${item.seq}`,
          seq: item.seq,
          kind: "prompt",
          ...tocPresentation(item.text),
        },
  );
}

export const ThreadTocEntry = memo(function ThreadTocEntry({
  current,
  item,
  jumping,
  onJump,
}: {
  current: boolean;
  item: ThreadTocItem;
  jumping: boolean;
  onJump: (seq: number) => Promise<unknown>;
}) {
  return (
    <a
      aria-label={item.kind === "dosu" ? `Dosu tool call: ${item.label}` : undefined}
      className={[
        item.kind === "dosu" ? "is-dosu" : null,
        jumping ? "is-loading" : null,
        current ? "is-current" : null,
      ]
        .filter(isPresent)
        .join(" ")}
      href={`#message-${item.seq}`}
      onClick={(event) => {
        event.preventDefault();
        void onJump(item.seq);
      }}
    >
      <span className={`toc-icon${item.kind === "dosu" ? " is-dosu" : ""}`}>
        {item.kind === "dosu" ? <img alt="" src={dosuOfficialUrl} /> : <Icon name={item.icon} />}
      </span>
      <span>{item.label}</span>
      {item.kind === "dosu" ? <em>Dosu</em> : null}
      {jumping ? <b>loading</b> : null}
    </a>
  );
});

export type ThreadTocItem = {
  key: string;
  seq: number;
  label: string;
  icon: IconName;
  kind: "prompt" | "dosu";
};

export function tocPresentation(text: string): { label: string; icon: IconName } {
  const special = specialTranscriptBlock(text);
  if (special != null) {
    return { label: firstLine(special.title, 70), icon: special.icon };
  }
  return { label: firstLine(cleanSessionTitle(text) ?? text, 70), icon: "messages" };
}

/**
 * Header stats are whole-session figures, so `totals` (server-aggregated) is
 * used; counting the loaded window would shrink as a transcript paginates. The
 * window fallback only covers payloads that predate `totals`.
 */
export function threadStats(
  summary: SessionSummary,
  messages: SessionDetailData["messages"],
  toc: ThreadTocItem[],
  fullTurnCount?: number | null,
  totals?: SessionDetailData["totals"],
) {
  return {
    turns:
      fullTurnCount != null && fullTurnCount > 0
        ? fullTurnCount
        : toc.filter((item) => item.kind === "prompt").length,
    replies:
      totals?.reply_count ?? messages.filter((message) => message.role === "assistant").length,
    toolCalls:
      totals?.tool_call_count ??
      messages.reduce(
        (sum, message) =>
          sum + message.blocks.filter((block) => block.block_type === "tool_use").length,
        0,
      ),
    tokens: summary.total_input_tokens + summary.total_output_tokens,
  };
}
