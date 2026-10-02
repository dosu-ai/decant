import { memo, useState } from "react";
import dosuOfficialUrl from "./assets/dosu-official.svg";
import { Badge, ModelBadge, providerIdentity } from "./badges.tsx";
import { Tooltip } from "./common.tsx";
import { relativeTime } from "./date-time.ts";
import { isDosuToolName } from "./dosu-tool.ts";
import {
  compact,
  formatBytes,
  formatInt,
  isPresent,
  matchText,
  money,
  shortPath,
} from "./format.ts";
import { BrandMark, Icon } from "./icons.tsx";
import { Link } from "./link.tsx";
import { cleanSessionTitle, isPermissionsText, tagAttribute } from "./session-title.ts";
import { TranscriptCodeBlock, TranscriptMarkdown } from "./transcript-markdown.tsx";
import { revealTranscriptMessage } from "./transcript-navigation.ts";
import {
  type StructuredTranscriptKind,
  type StructuredTranscriptLine,
  structuredTranscriptBlock,
} from "./transcript-presentation.ts";
import {
  collapseTranscriptText,
  embeddedAttachmentSummary,
  languageForTool,
  presentationForTool,
  summarizeToolResult,
  type TranscriptToolPresentation,
  transcriptCollapseLabel,
} from "./transcript-rendering.ts";
import type {
  ContextWindowCompactionData,
  IconName,
  SessionDetailData,
  SubagentDetailData,
  TranscriptBlockData,
} from "./types.ts";

// tabIndex={-1} lets arrow-key navigation move focus (and screen readers
// announce the turn) without joining the tab order. Memoized because a
// transcript can hold unbounded turns and each keypress changes `active` on two.
export const TranscriptTurn = memo(function TranscriptTurn({
  active,
  compaction,
  compactionNumber,
  message,
  sessionIsSubagent,
  subagentsByToolUse,
  tool,
  windowTokens,
}: {
  active: boolean;
  compaction: ContextWindowCompactionData | null;
  compactionNumber: number | null;
  message: SessionDetailData["messages"][number];
  sessionIsSubagent: boolean;
  subagentsByToolUse: Map<string, SubagentDetailData[]>;
  tool: string;
  windowTokens: number | null;
}) {
  if (message.is_compact_boundary) {
    return (
      <CompactionTurn
        active={active}
        anchorId={`message-${message.seq}`}
        compaction={compaction}
        compactionNumber={compactionNumber}
        message={message}
      />
    );
  }
  const contextTokens =
    message.role === "assistant" && (!message.is_sidechain || sessionIsSubagent)
      ? message.context_tokens
      : null;
  const blocks = message.blocks.map((block, blockIndex) => (
    <TranscriptBlock
      block={block}
      key={blockKey(block, blockIndex)}
      subagents={subagentsByToolUse.get(block.tool_use_id ?? "") ?? []}
      tool={tool}
    />
  ));
  const providerClass =
    message.role === "assistant" ? ` provider-${providerIdentity(tool).key}` : "";
  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`turn${message.is_compact_summary ? " compact-summary-turn" : ""}${
        active ? " is-keyboard-active" : ""
      }${providerClass}`}
      id={`message-${message.seq}`}
      tabIndex={-1}
    >
      <TranscriptIdentityBadge message={message} tool={tool} />
      <div className="turn-meta">
        {message.model != null ? <ModelBadge model={message.model} /> : null}
        {message.timestamp != null ? <span>{relativeTime(message.timestamp)}</span> : null}
        {contextTokens != null ? (
          <ContextChip tokens={contextTokens} windowTokens={windowTokens} />
        ) : null}
      </div>
      <div className="turn-body">
        {message.is_compact_summary ? (
          <details className="compact-summary">
            <summary>Compaction summary carried forward into the continued session</summary>
            {blocks}
          </details>
        ) : (
          blocks
        )}
      </div>
    </article>
  );
});

export function CompactionTurn({
  active = false,
  anchorId,
  compaction,
  compactionNumber = null,
  message,
}: {
  active?: boolean;
  anchorId?: string;
  compaction: ContextWindowCompactionData | null;
  compactionNumber?: number | null;
  message: SessionDetailData["messages"][number];
}) {
  const trigger = compaction?.trigger ?? message.compact_trigger;
  const pre = compaction?.pre_tokens ?? message.compact_pre_tokens;
  const post = compaction?.post_tokens ?? null;
  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`turn compaction-turn${active ? " is-keyboard-active" : ""}`}
      id={anchorId}
      tabIndex={-1}
    >
      <Badge mono tone="accent">
        {compactionNumber == null ? "Compacted" : `Compaction ${compactionNumber}`}
      </Badge>
      <div className="turn-meta">
        {message.timestamp != null ? <span>{relativeTime(message.timestamp)}</span> : null}
      </div>
      <div className="turn-body">
        <div className="compaction-card">
          <div className="compaction-card-head">
            <Icon name="refresh" />
            <strong>Context compacted{trigger != null ? ` (${trigger})` : ""}</strong>
            {pre != null ? (
              <span className="compaction-card-tokens">
                {compact(pre)}
                {post != null ? ` → ${compact(post)}` : ""} tokens
              </span>
            ) : null}
          </div>
          <p>
            Earlier messages were summarized and dropped from the live context window; the full
            transcript below is unaffected.
          </p>
          {message.blocks.length > 0 ? (
            <details className="compact-summary">
              <summary>Summary carried forward into the continued session</summary>
              {message.blocks.map((block, blockIndex) => (
                <TranscriptBlock block={block} key={blockKey(block, blockIndex)} />
              ))}
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function ContextChip({
  tokens,
  windowTokens,
}: {
  tokens: number;
  windowTokens: number | null;
}) {
  const pct = windowTokens != null && windowTokens > 0 ? tokens / windowTokens : null;
  const level = pct == null ? "" : pct >= 0.8 ? " is-hot" : pct >= 0.6 ? " is-warm" : "";
  const title =
    pct == null
      ? `Context window: ${formatInt(tokens)} tokens`
      : `Context window: ${formatInt(tokens)} of ${compact(windowTokens ?? 0)} tokens`;
  return (
    <span className={`ctx-chip${level}`} title={title}>
      {pct != null ? (
        <span aria-hidden="true" className="ctx-chip-bar">
          <i style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }} />
        </span>
      ) : null}
      {pct != null ? `${Math.round(pct * 100)}% · ` : ""}
      {compact(tokens)}
    </span>
  );
}

export function TranscriptBlock({
  block,
  subagents = [],
  tool = "",
}: {
  block: TranscriptBlockData;
  subagents?: SubagentDetailData[];
  tool?: string;
}) {
  if (block.block_type === "tool_use") {
    const isDosu = isDosuToolName(block.tool_name);
    const presentation = presentationForTool(block.tool_name, block.tool_input);
    return (
      <div className={`tool-call${isDosu ? " is-dosu" : ""}`}>
        <div className="tool-call-header">
          {isDosu ? (
            <span className="dosu-tool-mark">
              <img alt="" src={dosuOfficialUrl} />
            </span>
          ) : (
            <Icon name="bolt" />
          )}
          <span className="tool-call-name">{block.tool_name ?? "tool_use"}</span>
          {isDosu ? <span className="dosu-tool-badge">Optimized</span> : <small>tool call</small>}
        </div>
        {isPresent(block.tool_input) ? (
          <ToolCallPresentation forceOpen={isDosu} presentation={presentation} />
        ) : null}
        {subagents.map((subagent) => (
          <SubagentCard key={subagent.summary.id} subagent={subagent} />
        ))}
      </div>
    );
  }
  if (block.block_type === "tool_result") {
    if (!isPresent(block.tool_result)) {
      return null;
    }
    return <ToolResultBlock block={block} forceOpen={isDosuToolName(block.tool_name)} />;
  }
  if (block.block_type === "thinking") {
    if (!isPresent(block.text)) {
      return null;
    }
    return (
      <details className="thinking-block">
        <summary>Thinking</summary>
        <p>{block.text}</p>
      </details>
    );
  }
  if (!isPresent(block.text)) {
    return null;
  }
  const attachment = embeddedAttachmentSummary(block.block_type, block.text);
  if (attachment != null) {
    return (
      <div className="transcript-attachment">
        <span className="transcript-attachment-icon">
          <Icon name="file" />
        </span>
        <div>
          <strong>Embedded image</strong>
          <span>
            {attachment.mediaType.split("/", 2)[1]?.toUpperCase() ?? "Image"} ·{" "}
            {formatBytes(attachment.byteLength)}
          </span>
          <small>Payload preserved in the local session log</small>
        </div>
      </div>
    );
  }
  const special = specialTranscriptBlock(block.text);
  if (special != null) {
    return <SpecialTranscriptBlock block={special} tool={tool} />;
  }
  return <TranscriptMarkdown>{block.text}</TranscriptMarkdown>;
}

export function ToolCallPresentation({
  forceOpen = false,
  presentation,
}: {
  forceOpen?: boolean;
  presentation: TranscriptToolPresentation;
}) {
  switch (presentation.kind) {
    case "shell":
      return (
        <div className="tool-presentation tool-shell">
          {presentation.caption != null ? <p>{presentation.caption}</p> : null}
          <TranscriptCodeBlock code={`$ ${presentation.command}`} language="bash" />
        </div>
      );
    case "file":
      return (
        <div className="tool-presentation tool-file">
          <ToolPathHeader operation={presentation.operation} path={presentation.path} />
          {presentation.content != null ? (
            <TranscriptCodeBlock code={presentation.content} language={presentation.language} />
          ) : (
            <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
          )}
        </div>
      );
    case "edit":
      return (
        <div className="tool-presentation tool-edit">
          <ToolPathHeader operation="edit" path={presentation.path} />
          {presentation.diff.length > 0 ? (
            <div className="tool-diff">
              {presentation.diff.map((line) => {
                let partOffset = 0;
                return (
                  <div
                    className={`tool-diff-line is-${line.kind}`}
                    key={`${line.kind}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}-${line.text}`}
                  >
                    <span>{line.oldLine ?? ""}</span>
                    <span>{line.newLine ?? ""}</span>
                    <code>
                      {line.parts.map((part) => {
                        const key = `${part.kind}-${partOffset}`;
                        partOffset += part.value.length;
                        return (
                          <span className={`is-${part.kind}`} key={key}>
                            {part.value}
                          </span>
                        );
                      })}
                    </code>
                  </div>
                );
              })}
            </div>
          ) : (
            <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
          )}
        </div>
      );
    case "search":
      return (
        <div className="tool-presentation tool-search">
          <div className="tool-presentation-chips">
            <Badge tone="info">{presentation.searchKind}</Badge>
            {presentation.pattern != null ? <code>{presentation.pattern}</code> : null}
            {presentation.path != null ? <code>{presentation.path}</code> : null}
          </div>
          <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
        </div>
      );
    case "json":
      return (
        <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
      );
  }
}

export function ToolPathHeader({
  operation,
  path,
}: {
  operation: "edit" | "read" | "write";
  path: string | null;
}) {
  return (
    <div className="tool-path-header">
      <Badge tone={operation === "read" ? "info" : operation === "edit" ? "warning" : "success"}>
        {operation}
      </Badge>
      <code title={path ?? ""}>{path ?? "Unknown path"}</code>
    </div>
  );
}

export function CollapsedToolArguments({
  argumentsText,
  forceOpen = false,
}: {
  argumentsText: string;
  forceOpen?: boolean;
}) {
  return (
    <details className="tool-arguments" open={forceOpen || argumentsText.length <= 240}>
      <summary>arguments</summary>
      <TranscriptCodeBlock code={argumentsText} language="json" />
    </details>
  );
}

export function ToolResultBlock({
  block,
  forceOpen = false,
}: {
  block: TranscriptBlockData;
  forceOpen?: boolean;
}) {
  const result = block.tool_result ?? "";
  const collapsed = collapseTranscriptText(result);
  const [expanded, setExpanded] = useState(forceOpen || !collapsed.shouldCollapse);
  const summary = summarizeToolResult(block.tool_name, result);
  return (
    <details
      className="tool-result"
      onToggle={(event) => setExpanded(forceOpen || event.currentTarget.open)}
      open={forceOpen || expanded}
    >
      <summary>
        result{summary == null ? "" : ` · ${summary}`}
        {!expanded && collapsed.shouldCollapse ? ` · ${transcriptCollapseLabel(collapsed)}` : ""}
      </summary>
      <TranscriptCodeBlock
        code={expanded ? result : collapsed.preview}
        language={languageForTool(block.tool_name, block.tool_input)}
      />
    </details>
  );
}

export type SpecialTranscriptBlockData = {
  title: string;
  description: string;
  tooltip: string;
  icon: IconName;
  chips: string[];
  kind?: StructuredTranscriptKind;
  dialogue?: StructuredTranscriptLine[];
};

export function specialTranscriptBlock(text: string): SpecialTranscriptBlockData | null {
  const trimmed = text.trimStart();
  const structured = structuredTranscriptBlock(text);
  if (structured != null) {
    return {
      ...structured,
      icon: structuredTranscriptIcon(structured.kind),
      tooltip: structuredTranscriptTooltip(structured.kind),
    };
  }
  if (isPermissionsText(text)) {
    const sandbox = matchText(text, /`sandbox_mode`\s+is\s+`([^`]+)`/);
    const approval = matchText(text, /Approval policy is currently ([^.]+)\./);
    const network = matchText(text, /Network access is ([^.]+)\./);
    return {
      title: "Execution permissions",
      description: "Agent runtime limits for filesystem, network, and approval behavior.",
      tooltip:
        "Defines what the coding agent can read or write, whether it may request elevated commands, and whether network access is available.",
      icon: "shield",
      chips: [
        sandbox == null ? null : `sandbox ${sandbox}`,
        approval == null ? null : `approvals ${approval}`,
        network == null ? null : `network ${network}`,
      ].filter((value): value is string => value != null),
    };
  }
  if (/^<local-command-caveat>/i.test(trimmed)) {
    return {
      title: "Command context",
      description: "Runtime notice for local command output in this session.",
      tooltip:
        "Explains how local command output should be interpreted by the coding agent without exposing the raw system tag in the transcript.",
      icon: "shield",
      chips: ["agent runtime"],
    };
  }
  if (/^<command-name>/i.test(trimmed)) {
    const command = matchText(trimmed, /<command-name>([^<]+)<\/command-name>/);
    return {
      title: "Command context",
      description:
        command == null ? "Local slash command context." : `Local slash command: ${command}.`,
      tooltip:
        "Represents local slash-command metadata. The raw command wrapper is hidden so the transcript stays readable.",
      icon: "tools",
      chips: [command ?? "slash command"],
    };
  }
  if (/^The following is the Codex agent history/i.test(trimmed)) {
    return {
      title: "Agent history",
      description: "Prior agent transcript supplied as context.",
      tooltip: "Shows prior Codex activity that was included for review or continuation context.",
      icon: "file",
      chips: ["history"],
    };
  }
  if (/^Use prior reviews as context/i.test(trimmed)) {
    return {
      title: "Review context",
      description: "Instruction to treat previous reviews as context, not binding precedent.",
      tooltip: "Marks review-guidance context included before the current task request.",
      icon: "file",
      chips: ["review"],
    };
  }
  if (/^<teammate-message\b/i.test(trimmed)) {
    const summary = tagAttribute(trimmed, "summary");
    const teammate = tagAttribute(trimmed, "teammate_id");
    return {
      title: "Subagent request",
      description: summary ?? "Delegated work request supplied to a subagent.",
      tooltip:
        "Represents a structured subagent handoff. The raw message tag is hidden so the transcript stays readable.",
      icon: "cpu",
      chips: [teammate == null ? null : teammate].filter((value): value is string => value != null),
    };
  }
  if (text.includes("<environment_context>")) {
    const cwd = matchText(text, /<cwd>([^<]+)<\/cwd>/);
    const mode = matchText(text, /<shell>([^<]+)<\/shell>/);
    return {
      title: "Environment context",
      description: "Local workspace and shell context supplied to the agent.",
      tooltip:
        "Shows where the agent is running and which local environment details were provided for the session.",
      icon: "desktop",
      chips: [cwd == null ? null : shortPath(cwd), mode == null ? null : mode].filter(
        (value): value is string => value != null,
      ),
    };
  }
  if (trimmed.startsWith("# AGENTS.md instructions") || text.includes("<INSTRUCTIONS>")) {
    return {
      title: "Repository instructions",
      description: "Repo-specific agent guidance, invariants, and definition of done.",
      tooltip:
        "Summarizes the local AGENTS.md instructions that shape how the agent should edit, test, and verify work in this repository.",
      icon: "file",
      chips: ["AGENTS.md", `${formatInt(text.split(/\r?\n/).length)} lines`],
    };
  }
  return null;
}

export function SpecialTranscriptBlock({
  block,
  tool,
}: {
  block: SpecialTranscriptBlockData;
  tool: string;
}) {
  return (
    <Tooltip content={block.tooltip}>
      {(tooltipProps) => (
        <div
          className={`special-block${block.kind != null ? ` is-${block.kind}` : ""}`}
          {...tooltipProps}
        >
          <span className="special-icon">
            <Icon name={block.icon} />
          </span>
          <div>
            <div className="special-heading">
              <strong>{block.title}</strong>
              <span aria-hidden="true" className="info-tooltip">
                <Icon name="info" />
              </span>
            </div>
            <p>{block.description}</p>
            {block.chips.length > 0 ? (
              <div className="special-chips">
                {block.chips.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            ) : null}
            {block.dialogue != null && block.dialogue.length > 0 ? (
              <div className="realtime-dialogue">
                {keyedTranscriptLines(block.dialogue).map(({ key, line }) => (
                  <div className={`realtime-line is-${line.speaker}`} key={key}>
                    <TranscriptSpeakerBadge speaker={line.speaker} tool={tool} />
                    <p>{line.text}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Tooltip>
  );
}

export function structuredTranscriptIcon(kind: StructuredTranscriptKind): IconName {
  if (kind === "realtime-ended") {
    return "clock";
  }
  if (kind === "realtime-handoff") {
    return "messages";
  }
  return "cpu";
}

export function keyedTranscriptLines(
  lines: readonly StructuredTranscriptLine[],
): { key: string; line: StructuredTranscriptLine }[] {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.speaker}:${line.text}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { key: `${base}:${occurrence}`, line };
  });
}

export function structuredTranscriptTooltip(kind: StructuredTranscriptKind): string {
  if (kind === "realtime-ended") {
    return "Marks the point where a realtime voice conversation returned to normal typed chat.";
  }
  if (kind === "realtime-handoff") {
    return "A structured voice-mode envelope rendered as readable dialogue instead of raw runtime markup.";
  }
  return "Agent coordination instructions supplied by the runtime, summarized without the raw internal boilerplate.";
}

export function SubagentCard({ subagent }: { subagent: SubagentDetailData }) {
  const messages = renderableMessages(subagent.messages);
  const nested = subagentMap(subagent.subagents);
  const compactionNumberBySeq = new Map(
    messages
      .filter((message) => message.is_compact_boundary)
      .map((message, index) => [message.seq, index + 1]),
  );
  return (
    <details className="subagent-card">
      <summary>
        <span>
          <Icon name="cpu" />
          subagent
        </span>
        <span>
          {subagent.agent_type ??
            cleanSessionTitle(subagent.summary.title) ??
            subagent.agent_id ??
            "agent"}
        </span>
        <small>
          {formatInt(subagent.summary.message_count)} msgs ·{" "}
          {money(subagent.summary.estimated_cost_usd)}
        </small>
      </summary>
      {messages.length === 0 ? (
        <div className="subagent-summary">
          <span>{formatInt(subagent.summary.message_count)} messages</span>
          <span>{formatInt(subagent.summary.subagent_count)} nested</span>
          <Link href={`/sessions/${subagent.summary.id}`}>Open session</Link>
        </div>
      ) : (
        <div className="subagent-transcript">
          {messages.map((message) =>
            message.is_compact_boundary ? (
              <CompactionTurn
                compaction={null}
                compactionNumber={compactionNumberBySeq.get(message.seq) ?? null}
                key={messageKey(message)}
                message={message}
              />
            ) : (
              <article
                className={`turn is-subagent${
                  message.role === "assistant"
                    ? ` provider-${providerIdentity(subagent.summary.tool).key}`
                    : ""
                }`}
                key={messageKey(message)}
              >
                <TranscriptIdentityBadge message={message} tool={subagent.summary.tool} />
                <div className="turn-body">
                  {message.blocks.map((block, blockIndex) => (
                    <TranscriptBlock
                      block={block}
                      key={blockKey(block, blockIndex)}
                      subagents={nested.get(block.tool_use_id ?? "") ?? []}
                      tool={subagent.summary.tool}
                    />
                  ))}
                </div>
              </article>
            ),
          )}
        </div>
      )}
    </details>
  );
}

export function subagentMap(subagents: SubagentDetailData[]): Map<string, SubagentDetailData[]> {
  const map = new Map<string, SubagentDetailData[]>();
  for (const subagent of subagents) {
    if (subagent.spawn_tool_use_id == null) {
      continue;
    }
    const bucket = map.get(subagent.spawn_tool_use_id);
    if (bucket == null) {
      map.set(subagent.spawn_tool_use_id, [subagent]);
    } else {
      bucket.push(subagent);
    }
  }
  return map;
}

export function countSubagentRuns(subagents: SubagentDetailData[]): number {
  return subagents.reduce(
    (total, subagent) => total + 1 + countSubagentRuns(subagent.subagents),
    0,
  );
}

export function renderableMessages(
  messages: SessionDetailData["messages"],
): SessionDetailData["messages"] {
  return messages.filter(
    (message) =>
      // Compaction boundaries carry no blocks but render as inline cards.
      message.is_compact_boundary ||
      message.blocks.some((block) => {
        if (block.block_type === "text" || block.block_type === "thinking") {
          return isPresent(block.text);
        }
        return block.block_type === "tool_use" || block.block_type === "tool_result";
      }),
  );
}

export function messageKey(message: SessionDetailData["messages"][number]): string {
  return `${message.seq}:${message.role}`;
}

export function blockKey(block: TranscriptBlockData, index: number): string {
  return [
    index,
    block.ordinal,
    block.block_type,
    block.tool_use_id ?? "no-tool",
    block.tool_name ?? "no-name",
  ].join("|");
}

export function TranscriptIdentityBadge({
  message,
  tool,
}: {
  message: SessionDetailData["messages"][number];
  tool: string;
}) {
  if (message.is_compact_summary) {
    return (
      <Badge mono tone="accent">
        <Icon name="refresh" />
        Summary
      </Badge>
    );
  }
  const specialKind = messageSpecialKind(message);
  if (specialKind != null) {
    const realtime = specialKind === "realtime-ended" || specialKind === "realtime-handoff";
    return (
      <Badge tone={realtime ? "info" : "neutral"}>
        <Icon name={realtime ? "messages" : "shield"} />
        {realtime ? "Realtime" : "Runtime"}
      </Badge>
    );
  }
  if (message.role === "assistant") {
    const provider = providerIdentity(tool);
    return (
      <Badge tone={provider.tone}>
        {provider.icon == null ? <Icon name="cpu" /> : <BrandMark name={provider.icon} />}
        {provider.label}
      </Badge>
    );
  }
  if (message.role === "tool") {
    return (
      <Badge tone="info">
        <Icon name="tools" />
        Tool
      </Badge>
    );
  }
  if (message.role === "system") {
    return (
      <Badge>
        <Icon name="shield" />
        System
      </Badge>
    );
  }
  return <Badge>You</Badge>;
}

export function TranscriptSpeakerBadge({
  speaker,
  tool,
}: {
  speaker: StructuredTranscriptLine["speaker"];
  tool: string;
}) {
  if (speaker === "user") {
    return <span className="realtime-speaker">You</span>;
  }
  const provider = providerIdentity(tool);
  return (
    <span className={`realtime-speaker tone-${provider.tone}`}>
      {provider.icon == null ? <Icon name="cpu" /> : <BrandMark name={provider.icon} />}
      {provider.label}
    </span>
  );
}

export function messageSpecialKind(
  message: SessionDetailData["messages"][number],
): StructuredTranscriptKind | "runtime" | null {
  const blocks = message.blocks.filter(
    (block) => block.block_type === "text" && isPresent(block.text),
  );
  if (blocks.length === 0 || blocks.length !== message.blocks.length) {
    return null;
  }
  let kind: StructuredTranscriptKind | "runtime" | null = null;
  for (const block of blocks) {
    const special = specialTranscriptBlock(block.text ?? "");
    if (special == null) {
      return null;
    }
    kind ??= special.kind ?? "runtime";
  }
  return kind;
}

export function nearestTranscriptSeq(sequences: readonly number[]): number | null {
  let nearest: { distance: number; seq: number } | null = null;
  const readingLine = 184;
  for (const seq of sequences) {
    const element = document.getElementById(`message-${seq}`);
    if (element == null) {
      continue;
    }
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom < readingLine) {
      continue;
    }
    const distance = Math.abs(bounds.top - readingLine);
    if (nearest == null || distance < nearest.distance) {
      nearest = { distance, seq };
    }
  }
  return nearest?.seq ?? sequences[0] ?? null;
}

export function scrollTranscriptMessage(seq: number, stabilize = false, isCurrent = () => true) {
  const target = document.getElementById(`message-${seq}`);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!revealTranscriptMessage(target, reducedMotion || stabilize) || !stabilize) {
    return;
  }

  // content-visibility keeps thousand-message transcripts fast by estimating
  // off-screen turn heights. A deep jump reveals and measures those turns over
  // the next few frames, so the first scroll can drift as estimates become real
  // heights. Re-align without animation until the layout settles; focus stays
  // on the target from the first reveal and stale rapid jumps cancel the loop.
  let remaining = 7;
  const realign = () => {
    if (!isCurrent() || target == null) {
      return;
    }
    target.scrollIntoView({ behavior: "auto", block: "start" });
    remaining -= 1;
    if (remaining > 0) {
      requestAnimationFrame(() => requestAnimationFrame(realign));
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(realign));
}
