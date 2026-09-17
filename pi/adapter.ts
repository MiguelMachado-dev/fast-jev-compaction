import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  collectToolCalls,
  compact,
  isPinned,
  resolveOptions,
  type CompactOptions,
  type CompactResult,
  type JevAsker,
  type Message,
} from '../src/index.js';

/** A serialisable change to apply to a raw Pi transcript. */
export interface PiEdit {
  toolCallId: string;
  fingerprint: string;
  action: 'drop_call' | 'drop_result';
  /** The bounded replacement for a dropped result. Required for `drop_result`. */
  text?: string;
}

type ObjectRecord = Record<string, unknown>;

interface CallLocation {
  index: number;
  message: ObjectRecord;
  block: ObjectRecord;
  id: string;
  name: string | undefined;
  input: Record<string, unknown> | undefined;
  protected: boolean;
}

interface ResultLocation {
  index: number;
  message: ObjectRecord;
  id: string;
  name: string | undefined;
  text: string | undefined;
  protected: boolean;
}

interface PiPair {
  id: string;
  call: CallLocation;
  result: ResultLocation;
  pinned: boolean;
  fingerprint: string;
}

const TRUNCATION_PREFIX = '[fast-jev-compaction truncated ';
const TRUNCATION_SUFFIX = ' chars of this tool result; re-run the tool if needed]';

function isRecord(value: unknown): value is ObjectRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: ObjectRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function contentOf(message: AgentMessage): unknown[] | undefined {
  const record = isRecord(message) ? message : undefined;
  return record && Array.isArray(record.content) ? record.content : undefined;
}

function roleOf(message: AgentMessage): string | undefined {
  const record = isRecord(message) ? message : undefined;
  return record && typeof record.role === 'string' ? record.role : undefined;
}

function hasSignature(block: ObjectRecord): boolean {
  return Object.keys(block).some((key) => key.toLowerCase().includes('signature'));
}

/**
 * Pi needs to replay signed and thinking assistant blocks exactly. Treat an
 * entire assistant message as atomic when it contains either, rather than
 * trying to preserve just the signed block beside a removed tool call.
 */
function assistantIsProtected(message: ObjectRecord, content: readonly unknown[]): boolean {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return true;
  return content.some((value) => {
    if (!isRecord(value)) return true;
    if (value.type === 'thinking') return true;
    if (value.type === 'text' || value.type === 'toolCall') return hasSignature(value);
    // Future assistant block types (including images) need exact replay until
    // this adapter knows their provider invariants.
    return true;
  });
}

function toolResultText(message: ObjectRecord): string | undefined {
  if (message.isError !== false) return undefined;
  if (hasOwn(message, 'addedToolNames') && message.addedToolNames !== undefined) return undefined;

  const content = Array.isArray(message.content) ? message.content : undefined;
  if (!content || content.length !== 1 || !isRecord(content[0])) return undefined;
  const block = content[0];
  if (block.type !== 'text' || typeof block.text !== 'string' || hasSignature(block)) return undefined;
  return block.text;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : []))
    .join('\n');
}

function pairFingerprint(call: CallLocation, result: ResultLocation): string | undefined {
  try {
    // The whole assistant content binds nearby thinking/signature metadata;
    // the complete result binds details, usage, added tools, errors, and time.
    // Pi messages are JSON data. If another extension adds non-JSON data, skip
    // that pair rather than creating a fragile cached edit.
    const encoded = JSON.stringify({
      v: 1,
      callIndex: call.index,
      resultIndex: result.index,
      assistantContent: call.message.content,
      call: call.block,
      result: result.message,
    });
    return createHash('sha256').update(encoded).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Finds exactly-one call/result pairs which are structurally safe to edit.
 * Calls in protected messages are still counted before selection so a duplicate
 * ID cannot make its unprotected sibling look safe.
 */
function collectPiPairs(messages: readonly AgentMessage[], preserveRecentMessages: number): Map<string, PiPair> {
  const calls = new Map<string, CallLocation[]>();
  const results = new Map<string, ResultLocation[]>();

  messages.forEach((message, index) => {
    if (roleOf(message) === 'assistant') {
      const content = contentOf(message);
      const source = isRecord(message) ? message : undefined;
      if (content && source) {
        const protectedMessage = assistantIsProtected(source, content);
        for (const value of content) {
          if (!isRecord(value) || value.type !== 'toolCall' || typeof value.id !== 'string') continue;
          const entries = calls.get(value.id) ?? [];
          entries.push({
            index,
            message: source,
            block: value,
            id: value.id,
            name: typeof value.name === 'string' ? value.name : undefined,
            input: isRecord(value.arguments) ? value.arguments : undefined,
            protected: protectedMessage,
          });
          calls.set(value.id, entries);
        }
      }
    }

    if (roleOf(message) === 'toolResult') {
      const source = isRecord(message) ? message : undefined;
      if (!source || typeof source.toolCallId !== 'string') return;
      const entries = results.get(source.toolCallId) ?? [];
      entries.push({
        index,
        message: source,
        id: source.toolCallId,
        name: typeof source.toolName === 'string' ? source.toolName : undefined,
        text: toolResultText(source),
        protected: toolResultText(source) === undefined,
      });
      results.set(source.toolCallId, entries);
    }
  });

  const pairs = new Map<string, PiPair>();
  for (const [id, callEntries] of calls) {
    const resultEntries = results.get(id);
    if (callEntries.length !== 1 || resultEntries?.length !== 1) continue;

    const call = callEntries[0]!;
    const result = resultEntries[0]!;
    if (
      call.protected ||
      result.protected ||
      !call.name ||
      !call.input ||
      !result.name ||
      result.index <= call.index ||
      result.name !== call.name ||
      typeof result.text !== 'string'
    ) {
      continue;
    }

    const pinned =
      isPinned(call.index, messages.length, preserveRecentMessages) ||
      isPinned(result.index, messages.length, preserveRecentMessages);
    const fingerprint = pairFingerprint(call, result);
    if (fingerprint) pairs.set(id, { id, call, result, pinned, fingerprint });
  }
  return pairs;
}

function toolArgumentText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable arguments]';
  }
}

function outputNote(message: ObjectRecord | undefined): string {
  if (!message) return 'result unavailable';
  const content = Array.isArray(message.content) ? message.content : [];
  let textChars = 0;
  let images = 0;
  for (const value of content) {
    if (!isRecord(value)) continue;
    if (typeof value.text === 'string') textChars += value.text.length;
    if (value.type === 'image') images++;
  }
  const status = message.isError === true ? 'error' : 'ok';
  const pieces = [`${status}, ${textChars} chars of output omitted`];
  if (images > 0) pieces.push(`${images} image${images === 1 ? '' : 's'} omitted`);
  if (hasOwn(message, 'addedToolNames') && message.addedToolNames !== undefined) {
    pieces.push('tool availability changed');
  }
  return pieces.join('; ');
}

function toolResultsById(messages: readonly AgentMessage[]): Map<string, ObjectRecord[]> {
  const results = new Map<string, ObjectRecord[]>();
  for (const message of messages) {
    if (roleOf(message) !== 'toolResult' || !isRecord(message) || typeof message.toolCallId !== 'string') continue;
    const entries = results.get(message.toolCallId) ?? [];
    entries.push(message);
    results.set(message.toolCallId, entries);
  }
  return results;
}

function unscoredCallText(block: ObjectRecord, results: ReadonlyMap<string, ObjectRecord[]>): string {
  const id = typeof block.id === 'string' ? block.id : 'unknown-id';
  const name = typeof block.name === 'string' ? block.name : 'unknown-tool';
  const entries = typeof block.id === 'string' ? results.get(block.id) : undefined;
  const note = entries?.length === 1
    ? outputNote(entries[0])
    : entries && entries.length > 1
      ? 'multiple matching results preserved'
      : 'result unavailable';
  return `[unscored Pi tool call ${name} (${id}) args=${toolArgumentText(block.arguments)}; ${note}]`;
}

function bashExecutionText(message: ObjectRecord): string {
  if (message.excludeFromContext === true) return '';
  const command = typeof message.command === 'string' ? message.command : '[unknown command]';
  const outputChars = typeof message.output === 'string' ? message.output.length : 0;
  const status = message.cancelled === true
    ? 'cancelled'
    : typeof message.exitCode === 'number' && message.exitCode !== 0
      ? `exit ${message.exitCode}`
      : 'ok';
  return `[Pi bash execution]\ncommand: ${command}\nresult: ${status}, ${outputChars} chars of output omitted`;
}

function projectionText(role: string | undefined, message: ObjectRecord | undefined): string {
  if (!message) return '';
  if (role === 'compactionSummary' && typeof message.summary === 'string') {
    return `[Pi compaction summary]\n${message.summary}`;
  }
  if (role === 'branchSummary' && typeof message.summary === 'string') {
    return `[Pi branch summary]\n${message.summary}`;
  }
  if (role === 'bashExecution') return bashExecutionText(message);
  // `content` is the only generic text field safe to expose for unknown
  // extension messages. Do not infer text from arbitrary metadata fields.
  return contentText(message.content);
}

/** Pi's projection gives summaries a user-shaped engine row, so derive the goal before projection. */
function goalFromPiMessages(messages: readonly AgentMessage[]): string {
  return messages
    .filter((message) => roleOf(message) === 'user')
    .map((message) => (isRecord(message) ? contentText(message.content) : ''))
    .filter((text) => text.trim().length > 0)
    .slice(-3)
    .map((text) => text.slice(0, 500))
    .join('\n');
}

/** One simplified engine row per original Pi message, preserving indices for recency pinning. */
function projectPiMessages(messages: readonly AgentMessage[], pairs: ReadonlyMap<string, PiPair>): Message[] {
  const results = toolResultsById(messages);
  return messages.map((message) => {
    const role = roleOf(message);
    const source = isRecord(message) ? message : undefined;
    const content = contentOf(message);

    if (role === 'assistant' && source && content) {
      const toolUses = content.flatMap((value) => {
        if (!isRecord(value) || value.type !== 'toolCall' || typeof value.id !== 'string') return [];
        const pair = pairs.get(value.id);
        if (!pair || pair.call.block !== value || !pair.call.input || !pair.call.name) return [];
        return [{ tool_use_id: value.id, tool: pair.call.name, input: pair.call.input, text: '' }];
      });
      const unscored = content.flatMap((value) => {
        if (!isRecord(value) || value.type !== 'toolCall') return [];
        const pair = typeof value.id === 'string' ? pairs.get(value.id) : undefined;
        return pair?.call.block === value ? [] : [unscoredCallText(value, results)];
      });
      return {
        role: 'assistant',
        text: [projectionText(role, source), ...unscored].filter(Boolean).join('\n'),
        toolUses,
      };
    }

    if (role === 'toolResult' && source && typeof source.toolCallId === 'string') {
      const pair = pairs.get(source.toolCallId);
      if (pair && pair.result.message === source && typeof pair.result.text === 'string') {
        return {
          role: 'user',
          text: '',
          toolUses: [],
          toolResults: [{ tool_use_id: pair.id, text: pair.result.text, isError: false }],
        };
      }
      return { role: 'user', text: '', toolUses: [] };
    }

    return {
      role: role === 'assistant' ? 'assistant' : 'user',
      text: projectionText(role, source),
      toolUses: [],
    };
  });
}

function truncatedResultText(text: string, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}${TRUNCATION_PREFIX}${text.length - headChars}${TRUNCATION_SUFFIX}`;
}

/** Reject arbitrary replacement text even when somebody has copied a valid fingerprint. */
function isValidTruncation(original: string, replacement: string): boolean {
  if (!replacement.endsWith(TRUNCATION_SUFFIX)) return false;
  const prefixIndex = replacement.lastIndexOf(TRUNCATION_PREFIX);
  if (prefixIndex < 0) return false;
  const omittedText = replacement.slice(
    prefixIndex + TRUNCATION_PREFIX.length,
    replacement.length - TRUNCATION_SUFFIX.length,
  );
  if (!/^\d+$/.test(omittedText)) return false;
  const omitted = Number(omittedText);
  if (!Number.isSafeInteger(omitted) || omitted <= 0) return false;

  const beforeMarker = replacement.slice(0, prefixIndex);
  const head = beforeMarker === ''
    ? ''
    : beforeMarker.endsWith('\n')
      ? beforeMarker.slice(0, -1)
      : undefined;
  if (head === undefined || original.length - head.length !== omitted) return false;
  return replacement === truncatedResultText(original, head.length);
}

function piMessageChars(message: AgentMessage): number {
  const source = isRecord(message) ? message : undefined;
  if (!source) return 0;
  let chars = 0;
  const content = source.content;
  if (typeof content === 'string') chars += content.length;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (typeof block.text === 'string') chars += block.text.length;
      if (typeof block.thinking === 'string') chars += block.thinking.length;
      if (typeof block.data === 'string') chars += block.data.length;
      if (block.type === 'toolCall') {
        if (typeof block.name === 'string') chars += block.name.length;
        try {
          chars += JSON.stringify(block.arguments ?? {}).length;
        } catch {
          chars += 20;
        }
      }
    }
  }
  return chars;
}

/**
 * Applies only complete, current, non-pinned edits. If one persisted edit is
 * stale or malformed the function returns the raw transcript unchanged; this
 * prevents a partial cached decision set from silently crossing a safety
 * boundary after a branch or transcript change.
 */
export function applyPiEdits(
  messages: readonly AgentMessage[],
  edits: readonly PiEdit[],
  preserveRecentMessages?: number,
): AgentMessage[] {
  if (edits.length === 0) return [...messages];

  const preserve = resolveOptions({ preserveRecentMessages }).preserveRecentMessages;
  const pairs = collectPiPairs(messages, preserve);
  const actions = new Map<string, PiEdit>();

  for (const edit of edits) {
    if (
      !edit ||
      typeof edit.toolCallId !== 'string' ||
      typeof edit.fingerprint !== 'string' ||
      (edit.action !== 'drop_call' && edit.action !== 'drop_result') ||
      actions.has(edit.toolCallId)
    ) {
      return [...messages];
    }

    const pair = pairs.get(edit.toolCallId);
    if (!pair || pair.pinned || pair.fingerprint !== edit.fingerprint) return [...messages];
    if (
      edit.action === 'drop_result' &&
      (typeof edit.text !== 'string' || !isValidTruncation(pair.result.text!, edit.text))
    ) {
      return [...messages];
    }
    actions.set(edit.toolCallId, edit);
  }

  const output: AgentMessage[] = [];
  for (const message of messages) {
    const role = roleOf(message);
    const source = isRecord(message) ? message : undefined;
    const content = contentOf(message);

    if (role === 'assistant' && source && content) {
      const nextContent = content.filter((block) => {
        if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string') return true;
        return actions.get(block.id)?.action !== 'drop_call';
      });
      if (nextContent.length === content.length) {
        output.push(message);
      } else if (nextContent.length > 0) {
        output.push({ ...source, content: nextContent } as AgentMessage);
      }
      continue;
    }

    if (role === 'toolResult' && source && typeof source.toolCallId === 'string') {
      const edit = actions.get(source.toolCallId);
      if (edit?.action === 'drop_call') continue;
      if (edit?.action === 'drop_result') {
        const first = Array.isArray(source.content) ? source.content[0] : undefined;
        if (isRecord(first)) {
          output.push({ ...source, content: [{ ...first, text: edit.text }] } as AgentMessage);
          continue;
        }
      }
    }

    output.push(message);
  }
  return output;
}

/**
 * Scores a simplified projection with the upstream compactor, then translates
 * only safe decisions back to the original Pi messages. The caller should pass
 * its raw context on every invocation; edits intentionally do not compound.
 */
export async function compactPiMessages(
  messages: readonly AgentMessage[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<{ messages: AgentMessage[]; edits: PiEdit[]; stats: CompactResult['stats'] }> {
  const resolved = resolveOptions(options);
  const pairs = collectPiPairs(messages, resolved.preserveRecentMessages);
  const projection = projectPiMessages(messages, pairs);

  // Keep this explicit instead of relying only on compact's internal call: it
  // maps Jev's synthetic t1/t2 IDs back to Pi's stable tool-call IDs.
  const projectedCalls = collectToolCalls(projection, resolved.preserveRecentMessages);
  const callsByDecisionId = new Map(projectedCalls.map((call) => [call.id, call]));
  const compacted = await compact(projection, asker, {
    ...options,
    goal: options.goal ?? goalFromPiMessages(messages),
  });

  const edits: PiEdit[] = [];
  for (const decision of compacted.decisions) {
    if (decision.action === 'keep') continue;
    const projectedCall = callsByDecisionId.get(decision.id);
    if (!projectedCall) continue;
    const pair = pairs.get(projectedCall.tool_use_id);
    if (!pair || pair.pinned) continue;

    if (decision.action === 'drop_call') {
      edits.push({ toolCallId: pair.id, fingerprint: pair.fingerprint, action: 'drop_call' });
      continue;
    }

    const text = truncatedResultText(pair.result.text!, resolved.truncateHeadChars);
    if (text !== pair.result.text) {
      edits.push({ toolCallId: pair.id, fingerprint: pair.fingerprint, action: 'drop_result', text });
    }
  }

  const output = applyPiEdits(messages, edits, resolved.preserveRecentMessages);
  const charsBefore = messages.reduce((total, message) => total + piMessageChars(message), 0);
  const charsAfter = output.reduce((total, message) => total + piMessageChars(message), 0);
  const stats: CompactResult['stats'] = {
    ...compacted.stats,
    messagesBefore: messages.length,
    messagesAfter: output.length,
    charsBefore,
    charsAfter,
    calls: projectedCalls.length,
    resultsDropped: edits.filter((edit) => edit.action === 'drop_result').length,
    callsDropped: edits.filter((edit) => edit.action === 'drop_call').length,
  };
  return { messages: output, edits, stats };
}
