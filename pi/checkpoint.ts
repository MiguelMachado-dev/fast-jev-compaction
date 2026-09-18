import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { CompactResult } from '../src/types.js';

export const CHECKPOINT_FORMAT = 'fast-jev-pi-context-v1';
const MARKER = '[fast-jev-compaction checkpoint ';

export interface JevCheckpoint {
  format: typeof CHECKPOINT_FORMAT;
  id: string;
  messages: AgentMessage[];
  stats: CompactResult['stats'];
  decisions?: CompactResult['decisions'];
  readFiles: string[];
  modifiedFiles: string[];
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: Record<string, unknown>) => {
    if (part.type === 'text') return String(part.text ?? '');
    if (part.type === 'thinking') return `[Thinking]\n${String(part.thinking ?? '')}`;
    if (part.type === 'toolCall') return `[Tool call ${part.id}: ${part.name}]\n${JSON.stringify(part.arguments)}`;
    // Pi budgets each image as 1200 tokens (4800 characters). Keep the same
    // reservation in its textual checkpoint estimate without copying base64.
    if (part.type === 'image') return `[Image: ${part.mimeType}; data retained in checkpoint]${' '.repeat(4800)}`;
    return `[${String(part.type)} content preserved in checkpoint]`;
  }).join('\n');
}

/**
 * Pi requires a summary string even for a custom compaction. Store a full,
 * deterministic transcript here, not a generated summary or a tiny placeholder.
 * Pi can budget it and its default summarizer can consume it on a later fallback.
 * The context hook restores the exact typed messages from details before inference.
 */
export function renderCheckpoint(checkpoint: JevCheckpoint): string {
  const transcript = checkpoint.messages.map(message => {
    if (message.role === 'bashExecution') {
      if (message.excludeFromContext) return '';
      const outcome = message.cancelled ? '\n(command cancelled)'
        : message.exitCode != null && message.exitCode !== 0 ? `\nCommand exited with code ${message.exitCode}` : '';
      const truncated = message.truncated && message.fullOutputPath
        ? `\n[Output truncated. Full output: ${message.fullOutputPath}]` : '';
      return `[Bash: ${message.command}]\n${message.output || '(no output)'}${outcome}${truncated}`;
    }
    if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
      return `[${message.role}]\n${message.summary}`;
    }
    const label = message.role === 'toolResult'
      ? `Tool result ${message.toolCallId}: ${message.toolName}${message.isError ? ' (error)' : ''}`
      : message.role;
    return `[${label}]\n${'content' in message ? textContent(message.content) : ''}`;
  }).filter(Boolean).join('\n\n');
  // Pi intentionally ignores file metadata in fromHook details on a later
  // native compaction. Include the same file appendix in the readable input.
  const files = [
    checkpoint.readFiles.length ? `<read-files>\n${checkpoint.readFiles.join('\n')}\n</read-files>` : '',
    checkpoint.modifiedFiles.length ? `<modified-files>\n${checkpoint.modifiedFiles.join('\n')}\n</modified-files>` : '',
  ].filter(Boolean).join('\n\n');
  return `${MARKER}${checkpoint.id}]\nRetained conversation, verbatim. No generated summary.\n\n${transcript}${files ? `\n\n${files}` : ''}`;
}

export function createCheckpoint(
  messages: AgentMessage[],
  stats: CompactResult['stats'],
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
  sourceMessages: readonly AgentMessage[] = messages,
  previous?: Pick<JevCheckpoint, 'readFiles' | 'modifiedFiles'>,
): JevCheckpoint {
  // Unlike Pi's normal prefix compaction, this checkpoint consumes the complete
  // effective context. Track file operations in its tail as well as its prefix.
  const read = new Set([...fileOps.read, ...(previous?.readFiles ?? [])]);
  const modified = new Set([...fileOps.written, ...fileOps.edited, ...(previous?.modifiedFiles ?? [])]);
  for (const message of sourceMessages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall' || typeof block.arguments?.path !== 'string' || !block.arguments.path) continue;
      if (block.name === 'read') read.add(block.arguments.path);
      else if (block.name === 'write' || block.name === 'edit') modified.add(block.arguments.path);
    }
  }
  // Checkpoints must survive Pi's JSONL persistence, not retain mutable runtime references.
  return {
    format: CHECKPOINT_FORMAT,
    id: randomUUID(),
    messages: JSON.parse(JSON.stringify(messages)) as AgentMessage[],
    stats,
    readFiles: [...read].filter(path => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export function isJevCheckpoint(data: unknown): data is JevCheckpoint {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<JevCheckpoint>;
  const stats = value.stats;
  if (!stats || typeof stats !== 'object' || ![
    'messagesBefore', 'messagesAfter', 'charsBefore', 'charsAfter', 'calls', 'kept',
    'resultsDropped', 'callsDropped', 'pinned', 'stateTokens', 'requests', 'ms',
  ].every(key => {
    const number = (stats as unknown as Record<string, unknown>)[key];
    return typeof number === 'number' && Number.isFinite(number) && number >= 0;
  })) return false;
  if (value.decisions !== undefined && (!Array.isArray(value.decisions) || !value.decisions.every(decision =>
    decision && typeof decision.id === 'string' && typeof decision.tool === 'string' &&
    typeof decision.action === 'string' && Number.isFinite(decision.keepCall) && Number.isFinite(decision.keepResult)))) return false;
  return value.format === CHECKPOINT_FORMAT && typeof value.id === 'string' &&
    Array.isArray(value.readFiles) && value.readFiles.every(path => typeof path === 'string') &&
    Array.isArray(value.modifiedFiles) && value.modifiedFiles.every(path => typeof path === 'string') &&
    Array.isArray(value.messages) && value.messages.every(message =>
      message && typeof message === 'object' && typeof message.role === 'string');
}

/** Resolve only checkpoints present on this branch; sibling branches never supply context. */
export function restoreCheckpoints(messages: readonly AgentMessage[], branch: readonly SessionEntry[]): AgentMessage[] {
  const checkpoints = new Map<string, AgentMessage[]>();
  for (const [index, entry] of branch.entries()) {
    if (entry.type === 'compaction' && isJevCheckpoint(entry.details) &&
        entry.summary.startsWith(`${MARKER}${entry.details.id}]\n`)) {
      const boundary = branch.slice(0, index).find(candidate => candidate.id === entry.firstKeptEntryId);
      if (boundary?.type !== 'custom' || boundary.customType !== 'fast-jev-pi-boundary' ||
          !boundary.data || typeof boundary.data !== 'object' ||
          !('checkpointId' in boundary.data) || boundary.data.checkpointId !== entry.details.id) continue;
      checkpoints.set(entry.summary, entry.details.messages);
    }
  }
  return messages.flatMap(message => {
    if (message.role !== 'compactionSummary') return [message];
    const restored = checkpoints.get(message.summary);
    // A missing/corrupt checkpoint still has the readable retained transcript as fallback.
    return restored ? structuredClone(restored) : [message];
  });
}
