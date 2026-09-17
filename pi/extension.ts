import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { estimateTokens } from '../src/state.js';
import { applyPiEdits, compactPiMessages, type PiEdit } from './adapter.js';
import { createJevTransport } from './transport.js';

const STATE_TYPE = 'fast-jev-pi';
const RESCORE_MESSAGES = 8;
const RETRY_DELAY_MS = 30_000;

interface Config {
  minTokens: number;
  preserveRecentMessages: number;
  timeoutMs: number;
  keepThreshold: number;
}

interface Snapshot {
  version: 1;
  enabled: boolean;
  configHash: string;
  edits: PiEdit[];
  messageCount: number;
  inputHash: string;
  userHash: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function latestUserHash(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return hash([i, messages[i]]);
  }
  return hash(null);
}

function parseSnapshot(data: unknown): Snapshot | undefined {
  if (!data || typeof data !== 'object') return;
  const value = data as Partial<Snapshot>;
  if (value.version !== 1 || typeof value.enabled !== 'boolean' ||
      typeof value.configHash !== 'string' || typeof value.inputHash !== 'string' ||
      typeof value.userHash !== 'string' || !Number.isSafeInteger(value.messageCount) ||
      value.messageCount! < 0 || !Array.isArray(value.edits)) return;
  if (!value.edits.every(edit => edit && typeof edit.toolCallId === 'string' &&
      typeof edit.fingerprint === 'string' &&
      (edit.action === 'drop_call' || (edit.action === 'drop_result' && typeof edit.text === 'string')))) return;
  return value as Snapshot;
}

/** Only text and tool arguments/results count toward this deliberately approximate trigger. */
function contextTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
      total += estimateTokens(message.summary);
      continue;
    }
    if (message.role === 'bashExecution') {
      if (!message.excludeFromContext) total += estimateTokens(message.command + message.output);
      continue;
    }
    if (!('content' in message)) continue;
    if (typeof message.content === 'string') total += estimateTokens(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') total += estimateTokens(part.text);
        else if (part.type === 'toolCall') total += estimateTokens(JSON.stringify(part.arguments));
        else if (part.type === 'thinking') total += estimateTokens(part.thinking);
      }
    }
  }
  return total;
}

export default function registerPiExtension(pi: ExtensionAPI): void {
  pi.registerFlag('jev-min-tokens', { description: 'Approximate context tokens before Jev pruning', type: 'string', default: '20000' });
  pi.registerFlag('jev-preserve-recent', { description: 'Newest message rows protected from Jev pruning', type: 'string', default: '6' });
  pi.registerFlag('jev-timeout-ms', { description: 'Deadline for a complete Jev scoring pass', type: 'string', default: '10000' });
  pi.registerFlag('jev-keep-threshold', { description: 'Minimum probability for keeping a call or result', type: 'string', default: '0.5' });
  pi.registerFlag('jev-disabled', { description: 'Start with Jev pruning disabled', type: 'boolean', default: false });

  let enabled = true;
  let initialized = false;
  let config: Config | undefined;
  let snapshot: Snapshot | undefined;
  let force = false;
  let generation = 0;
  let active: ReturnType<typeof createJevTransport> | undefined;
  let lastAttempt = 0;
  let attemptedUserHash = '';
  let lastNotice = '';
  let status = 'waiting for context';

  function notify(ctx: ExtensionContext, text: string, warning = false): void {
    if (ctx.hasUI && text !== lastNotice) ctx.ui.notify(`Jev: ${text}`, warning ? 'warning' : 'info');
    lastNotice = text;
  }

  function showStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus(STATE_TYPE, `Jev: ${enabled ? status : 'off'}`);
  }

  function invalidate(): void {
    generation++;
    active?.abort();
    active = undefined;
    force = false;
    attemptedUserHash = '';
    lastAttempt = 0;
  }

  function readConfig(): Config {
    function number(name: string, fallback: number, min: number, max: number, integer = true): number {
      const raw = pi.getFlag(name) ?? String(fallback);
      const value = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
        throw new Error(`Invalid --${name}`);
      }
      return value;
    }
    return {
      minTokens: number('jev-min-tokens', 20_000, 0, Number.MAX_SAFE_INTEGER),
      preserveRecentMessages: number('jev-preserve-recent', 6, 0, Number.MAX_SAFE_INTEGER),
      timeoutMs: number('jev-timeout-ms', 10_000, 1, 120_000),
      keepThreshold: number('jev-keep-threshold', 0.5, 0, 1, false),
    };
  }

  function persist(): void {
    if (!config) return;
    const data: Snapshot = snapshot
      ? { ...snapshot, enabled }
      : { version: 1, enabled, configHash: hash(config), edits: [], messageCount: 0, inputHash: '', userHash: '' };
    pi.appendEntry(STATE_TYPE, data);
  }

  function hydrate(ctx: ExtensionContext): void {
    initialized = true;
    invalidate();
    snapshot = undefined;
    lastNotice = '';
    try {
      config = readConfig();
      // getBranch excludes siblings; native compaction invalidates older pruning snapshots.
      const branch = ctx.sessionManager.getBranch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i]!;
        if (entry.type === 'compaction') break;
        if (entry.type === 'custom' && entry.customType === STATE_TYPE) {
          snapshot = parseSnapshot(entry.data);
          break;
        }
      }
      enabled = pi.getFlag('jev-disabled') !== true && (snapshot?.enabled ?? true);
      if (snapshot?.configHash !== hash(config)) snapshot = undefined;
      status = process.env.TYPESAFE_API_KEY ? 'ready' : 'no API key';
    } catch (error) {
      config = undefined;
      enabled = false;
      status = 'invalid configuration';
      notify(ctx, error instanceof Error ? error.message : status, true);
    }
    showStatus(ctx);
  }

  pi.on('session_start', (_event, ctx) => hydrate(ctx));
  pi.on('session_tree', (_event, ctx) => hydrate(ctx));
  pi.on('session_shutdown', () => { invalidate(); snapshot = undefined; });
  pi.on('session_compact', (_event, ctx) => {
    invalidate();
    snapshot = undefined;
    status = 'ready after Pi compaction';
    persist();
    showStatus(ctx);
  });

  pi.registerCommand('jev', {
    description: 'Jev context pruning: status, prune, on, off, reset, restore',
    handler: async (args, ctx) => {
      // Explicit commands should always answer, even if automatic warnings are deduplicated.
      lastNotice = '';
      const command = args.trim() || 'status';
      if (!initialized) hydrate(ctx);
      if (command === 'status') {
        const key = process.env.TYPESAFE_API_KEY ? 'configured' : 'missing';
        notify(ctx, `${enabled ? status : 'off'}; API key ${key}; ${snapshot?.edits.length ?? 0} cached edits`);
        return;
      }
      if (!['prune', 'on', 'off', 'reset', 'restore'].includes(command)) {
        notify(ctx, 'usage: /jev status|prune|on|off|reset|restore');
        return;
      }
      invalidate();
      if (command === 'off') enabled = false;
      if (command === 'on') enabled = true;
      if (command === 'reset' || command === 'restore') snapshot = undefined;
      if (command === 'prune') {
        if (!enabled || !config || !process.env.TYPESAFE_API_KEY) {
          notify(ctx, 'pruning requires valid flags, /jev on, and TYPESAFE_API_KEY', true);
          return;
        }
        force = true;
        status = 'pruning queued for next request';
      } else status = command === 'off' ? 'off' : 'ready';
      persist();
      showStatus(ctx);
      notify(ctx, command === 'reset' || command === 'restore'
        ? 'cached edits cleared; automatic pruning remains enabled if it was on'
        : status);
    },
  });

  pi.on('context', async (event, ctx) => {
    if (!initialized) hydrate(ctx);
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!enabled || !config || !apiKey || ctx.signal?.aborted || active) return;
    const original = event.messages;
    const epoch = generation;
    const session = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafId();
    let transport: ReturnType<typeof createJevTransport> | undefined;
    try {
      const userHash = latestUserHash(original);
      const samePrefix = snapshot && snapshot.messageCount <= original.length &&
        snapshot.inputHash === hash(original.slice(0, snapshot.messageCount));
      // New intent must not inherit omissions selected for the previous task.
      const reusable = !!samePrefix && snapshot?.userHash === userHash;
      const due = force || !reusable || original.length - snapshot!.messageCount >= RESCORE_MESSAGES;
      if (!due) return { messages: applyPiEdits(original, snapshot!.edits, config.preserveRecentMessages) };
      if (!force && contextTokens(original) < config.minTokens) {
        return { messages: reusable ? applyPiEdits(original, snapshot!.edits, config.preserveRecentMessages) : original };
      }
      const inputHash = hash(original);
      if (!force && attemptedUserHash === userHash && Date.now() - lastAttempt < RETRY_DELAY_MS) {
        return { messages: reusable ? applyPiEdits(original, snapshot!.edits, config.preserveRecentMessages) : original };
      }
      force = false;
      attemptedUserHash = userHash;
      lastAttempt = Date.now();
      transport = createJevTransport(apiKey, config.timeoutMs, ctx.signal);
      active = transport;
      status = 'scoring';
      showStatus(ctx);
      const result = await compactPiMessages(original, transport.asker, config);
      if (transport.signal.aborted || epoch !== generation ||
          session !== ctx.sessionManager.getSessionId() || leaf !== ctx.sessionManager.getLeafId()) {
        if (epoch === generation) {
          status = 'context changed; original context kept';
          showStatus(ctx);
        }
        return { messages: original };
      }
      snapshot = {
        version: 1, enabled, configHash: hash(config), edits: result.edits,
        messageCount: original.length, inputHash, userHash,
      };
      // Successful scoring is debounced by message growth, not by the failure cooldown.
      attemptedUserHash = '';
      persist();
      status = `${result.edits.length} edits; ~${contextTokens(original) - contextTokens(result.messages)} tokens removed`;
      showStatus(ctx);
      return { messages: result.messages };
    } catch {
      if (epoch === generation) {
        snapshot = undefined;
        status = 'scoring failed; original context kept';
        // Exceptions can contain server-controlled or transcript data. Keep UI text fixed.
        notify(ctx, status, true);
        showStatus(ctx);
      }
      return { messages: original };
    } finally {
      transport?.dispose();
      if (active === transport) active = undefined;
    }
  });
}
