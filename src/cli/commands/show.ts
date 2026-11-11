import { type Command, InvalidArgumentError } from "commander";
import { toMarkdown } from "../../export.ts";
import {
  type BlockView,
  getSession,
  getSessionOutline,
  type SessionDetail,
  type SessionOutlineItem,
  type SessionTotals,
} from "../../query.ts";
import type { CliContext } from "../context.ts";
import { parseInteger } from "../parse.ts";
import { resolveSessionRef } from "../session-ref.ts";

interface ShowOptions {
  outline?: boolean;
  limit?: number;
  offset?: number;
  maxChars?: number;
}

// getSession pages only when it has a limit, so an offset alone needs one
// that no session reaches.
const NO_MESSAGE_LIMIT = 2 ** 31 - 1;

const CAPPED_FIELDS = ["text", "tool_input", "tool_result"] as const;
type CappedField = (typeof CAPPED_FIELDS)[number];

/** A block whose long fields were cut. The flags are absent on an uncut block. */
export interface CappedBlock extends BlockView {
  truncated?: true;
  /** Length before the cut, for each field that was cut. */
  original_chars?: Partial<Record<CappedField, number>>;
}

/** What a reader needs to tell a partial result from a whole one and to page on. */
export interface PageInfo {
  message_count: number;
  message_offset: number;
  message_limit: number | null;
  has_more_messages: boolean;
  partial: boolean;
}

export interface OutlineBlock {
  type: string;
  chars: number;
  tool_name?: string;
}

export interface OutlineMessage {
  /** Position in the transcript, which is what `--offset` counts. */
  index: number;
  seq: number;
  role: string;
  chars: number;
  blocks: OutlineBlock[];
}

export interface SessionOutlineView extends PageInfo {
  session: {
    id: number;
    tool: string;
    source_session_id: string;
    title: string | null;
    project_path: string | null;
    started_at: string | null;
  };
  totals: SessionTotals | undefined;
  messages: OutlineMessage[];
  /** The items `GET /api/sessions/{id}/outline` returns, for the listed messages. */
  outline: SessionOutlineItem[];
}

export function addShowCommand(ctx: CliContext, command: Command): void {
  const { io } = ctx;
  command
    .description("render a transcript, one page of it, or its outline")
    .argument("<id>", "session id, or the id the source tool gave the session")
    .option("--outline", "list each message's role, block kinds, sizes, and tool names")
    .option("--limit <n>", "max messages", integerAtLeast(1))
    .option("--offset <n>", "messages to skip before the first one shown", integerAtLeast(0))
    .option(
      "--max-chars <n>",
      "cut each text, tool input, and tool output to this many characters",
      integerAtLeast(1),
    )
    .action((ref: string, options: ShowOptions) =>
      ctx.run(() => {
        if (options.outline === true && options.maxChars != null) {
          io.writeErr("error: --max-chars does not apply to --outline, which lists sizes\n");
          return 2;
        }
        return ctx.withArchive(
          (archive) => {
            const resolved = resolveSessionRef(archive.db, ref);
            if (!resolved.ok) {
              io.writeErr(`error: ${resolved.message}\n`);
              return resolved.code;
            }
            const id = resolved.id;
            const paged = options.limit != null || options.offset != null;
            const detail = getSession(
              archive.db,
              id,
              paged
                ? {
                    messageLimit: options.limit ?? NO_MESSAGE_LIMIT,
                    messageOffset: options.offset ?? 0,
                  }
                : {},
            );
            if (detail == null) {
              io.writeErr(`error: no session with id ${id}\n`);
              return 1;
            }
            if (options.outline === true) {
              const view = outlineView(
                detail,
                getSessionOutline(archive.db, id) ?? [],
                pageInfo(detail, options, 0),
              );
              ctx.output(view, () => renderOutline(view));
              return 0;
            }
            if (!paged && options.maxChars == null) {
              ctx.output(detail, () => toMarkdown(detail));
              return 0;
            }
            const capped = capBlocks(detail, options.maxChars);
            const page = pageInfo(detail, options, capped.truncatedBlocks);
            ctx.output(
              {
                ...capped.detail,
                ...page,
                ...(options.maxChars == null
                  ? {}
                  : { max_chars: options.maxChars, truncated_blocks: capped.truncatedBlocks }),
              },
              () =>
                `${toMarkdown(withTruncationMarkers(capped.detail))}` +
                `${pageFooter(id, page, detail.messages.length, options, capped.truncatedBlocks)}\n`,
            );
            return 0;
          },
          { sync: true },
        );
      }),
    );
}

function integerAtLeast(minimum: number): (value: string) => number {
  return (value) => {
    const parsed = parseInteger(value);
    if (parsed < minimum) {
      throw new InvalidArgumentError(`expected an integer of at least ${minimum}`);
    }
    return parsed;
  };
}

function pageInfo(detail: SessionDetail, options: ShowOptions, truncatedBlocks: number): PageInfo {
  const offset = options.offset ?? 0;
  const hasMore = offset + detail.messages.length < detail.summary.message_count;
  return {
    message_count: detail.summary.message_count,
    message_offset: offset,
    message_limit: options.limit ?? null,
    has_more_messages: hasMore,
    partial: offset > 0 || hasMore || truncatedBlocks > 0,
  };
}

/** Cut every long field to `maxChars`, recording each field's original length. */
export function capBlocks(
  detail: SessionDetail,
  maxChars: number | undefined,
): { detail: SessionDetail; truncatedBlocks: number } {
  if (maxChars == null) {
    return { detail, truncatedBlocks: 0 };
  }
  let truncatedBlocks = 0;
  const messages = detail.messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      const kept: BlockView = { ...block };
      const original: NonNullable<CappedBlock["original_chars"]> = {};
      for (const field of CAPPED_FIELDS) {
        const value = block[field];
        if (value != null && value.length > maxChars) {
          kept[field] = cut(value, maxChars);
          original[field] = value.length;
        }
      }
      if (Object.keys(original).length === 0) {
        return kept;
      }
      truncatedBlocks += 1;
      return { ...kept, truncated: true, original_chars: original } satisfies CappedBlock;
    }),
  }));
  return { detail: { ...detail, messages }, truncatedBlocks };
}

function cut(value: string, maxChars: number): string {
  const last = value.charCodeAt(maxChars - 1);
  // Ending on a high surrogate would leave half a character behind.
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars);
}

// JSON carries the cut in fields. Text has nowhere else to say it, so the
// marker goes where the content stops.
function withTruncationMarkers(detail: SessionDetail): SessionDetail {
  return {
    ...detail,
    messages: detail.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block: CappedBlock) => {
        const marked: BlockView = { ...block };
        for (const [field, original] of Object.entries(block.original_chars ?? {})) {
          const kept = block[field as CappedField] ?? "";
          marked[field as CappedField] =
            `${kept}\n[truncated: ${original - kept.length} of ${original} chars omitted. ` +
            "Raise --max-chars to read more.]";
        }
        return marked;
      }),
    })),
  };
}

function pageFooter(
  id: number,
  page: PageInfo,
  shown: number,
  options: ShowOptions,
  truncatedBlocks: number,
): string {
  const from = page.message_offset > 0 ? ` from offset ${page.message_offset}` : "";
  const lines = [`[showing ${shown} of ${page.message_count} messages${from}]`];
  if (page.has_more_messages) {
    const flags = [
      ...(options.outline === true ? ["--outline"] : []),
      `--offset ${page.message_offset + shown}`,
      `--limit ${page.message_limit ?? shown}`,
      ...(options.maxChars == null ? [] : [`--max-chars ${options.maxChars}`]),
    ];
    lines.push(`[next page: decant show ${id} ${flags.join(" ")}]`);
  }
  if (truncatedBlocks > 0) {
    lines.push(
      `[${truncatedBlocks} ${truncatedBlocks === 1 ? "block" : "blocks"} cut at ` +
        `${options.maxChars} chars. Raise --max-chars to read ` +
        `${truncatedBlocks === 1 ? "it" : "them"} in full.]`,
    );
  }
  return lines.join("\n");
}

function outlineView(
  detail: SessionDetail,
  outline: SessionOutlineItem[],
  page: PageInfo,
): SessionOutlineView {
  const { summary } = detail;
  const messages = detail.messages.map((message, position): OutlineMessage => {
    const blocks = message.blocks.map((block): OutlineBlock => {
      const chars = CAPPED_FIELDS.reduce((total, field) => total + (block[field]?.length ?? 0), 0);
      return {
        type: block.block_type,
        chars,
        ...(block.tool_name == null ? {} : { tool_name: block.tool_name }),
      };
    });
    return {
      index: page.message_offset + position,
      seq: message.seq,
      role: message.role,
      chars: blocks.reduce((total, block) => total + block.chars, 0),
      blocks,
    };
  });
  const listed = new Set(messages.map((message) => message.seq));
  return {
    session: {
      id: summary.id,
      tool: summary.tool,
      source_session_id: summary.source_session_id,
      title: summary.title,
      project_path: summary.project_path,
      started_at: summary.started_at,
    },
    totals: detail.totals,
    ...page,
    messages,
    outline: outline.filter((item) => listed.has(item.seq)),
  };
}

const PROMPT_PREVIEW_CHARS = 80;

function renderOutline(view: SessionOutlineView): string {
  const { session } = view;
  const prompts = new Map(
    view.outline.filter((item) => item.kind === "prompt").map((item) => [item.seq, item.text]),
  );
  const rows = view.messages.map((message) => {
    const blocks = message.blocks
      .map((block) => [block.type, block.tool_name, block.chars].filter((part) => part != null))
      .map((parts) => parts.join(" "))
      .join(", ");
    const prompt = prompts.get(message.seq);
    return [message.index, message.role, message.chars, blocks, ...promptPreview(prompt)].join(
      "\t",
    );
  });
  return [
    `session ${session.id} (${session.tool} ${session.source_session_id}): ` +
      `${session.title ?? "untitled"}`,
    `messages: ${view.message_count}, replies: ${view.totals?.reply_count ?? 0}, ` +
      `tool calls: ${view.totals?.tool_call_count ?? 0}`,
    "index\trole\tchars\tblocks\tprompt",
    ...rows,
    pageFooter(session.id, view, view.messages.length, { outline: true }, 0),
    `[read messages: decant show ${session.id} --offset <index> --limit <n> --max-chars <n>]`,
  ].join("\n");
}

function promptPreview(prompt: string | undefined): string[] {
  if (prompt == null) {
    return [];
  }
  // A row is one line of tab-separated columns, so the preview cannot hold either.
  const flat = prompt.replaceAll(/\s+/g, " ").trim();
  return [flat.length > PROMPT_PREVIEW_CHARS ? `${flat.slice(0, PROMPT_PREVIEW_CHARS)}...` : flat];
}
