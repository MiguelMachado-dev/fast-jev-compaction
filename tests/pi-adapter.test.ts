import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { type JevAsker, type JevQuestions } from '../src/index.js';
import { applyPiEdits, compactPiMessages, type PiEdit } from '../pi/adapter.js';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}

function toolCall(id: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'toolCall', id, name: 'read', arguments: { path: `${id}.ts` }, ...extras };
}

function assistant(content: unknown[], extras: Record<string, unknown> = {}): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage,
    stopReason: 'toolUse',
    timestamp: 2,
    ...extras,
  } as AgentMessage;
}

function toolResult(
  id: string,
  text: string,
  extras: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 3,
    ...extras,
  } as AgentMessage;
}

function fakeJev(answer: (question: string) => number, seen: string[] = []): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      const names = Object.keys(questions);
      seen.push(...names);
      return {
        answers: Object.fromEntries(
          names.map((name) => [name, { type: 'noul' as const, noul: answer(name) }]),
        ),
      };
    },
  };
}

function resultMessage(message: AgentMessage): Record<string, unknown> {
  expect(message.role).toBe('toolResult');
  return message as unknown as Record<string, unknown>;
}

describe('Pi adapter', () => {
  it('keeps tool-call/result pairing when a call is dropped', async () => {
    const messages = [
      user('fix the actual request'),
      assistant([{ type: 'text', text: 'running a read' }, toolCall('old')]),
      toolResult('old', 'x'.repeat(500)),
      user('continue'),
    ];

    const output = await compactPiMessages(messages, fakeJev(() => 0.1), {
      preserveRecentMessages: 0,
    });

    expect(output.edits).toHaveLength(1);
    expect(output.edits[0]).toMatchObject({ toolCallId: 'old', action: 'drop_call' });
    expect(output.messages).toHaveLength(3);
    expect((output.messages[1] as any).content).toEqual([{ type: 'text', text: 'running a read' }]);
    expect(output.messages.some((message) => message.role === 'toolResult')).toBe(false);
    expect((messages[1] as any).content).toHaveLength(2);
    expect(messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'old' });
  });

  it('only replaces a plain result text block and preserves all result metadata', async () => {
    const details = { source: 'filesystem', retained: true };
    const resultUsage = { ...usage, input: 8, totalTokens: 9 };
    const messages = [
      user('start'),
      assistant([toolCall('long')]),
      toolResult('long', 'a'.repeat(600), { details, usage: resultUsage, timestamp: 999, custom: 'kept' }),
      user('continue'),
    ];

    const output = await compactPiMessages(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1)),
      { preserveRecentMessages: 0, truncateHeadChars: 40 },
    );

    expect(output.edits).toHaveLength(1);
    expect(output.edits[0]?.action).toBe('drop_result');
    expect(output.messages[1]).toBe(messages[1]);
    expect(output.messages[2]).not.toBe(messages[2]);
    const changed = resultMessage(output.messages[2]!);
    const original = resultMessage(messages[2]!);
    expect(changed.details).toBe(details);
    expect(changed.usage).toBe(resultUsage);
    expect(changed.timestamp).toBe(999);
    expect(changed.custom).toBe('kept');
    expect((changed.content as any[])[0]).toEqual({
      type: 'text',
      text: output.edits[0]?.text,
    });
    expect((original.content as any[])[0]?.text).toBe('a'.repeat(600));
  });

  it('protects the first and newest source rows before Jev is asked', async () => {
    const messages = [
      assistant([toolCall('first')]),
      toolResult('first', 'f'.repeat(500)),
      user('middle'),
      assistant([toolCall('old')]),
      toolResult('old', 'o'.repeat(500)),
      assistant([toolCall('recent')]),
      toolResult('recent', 'r'.repeat(500)),
    ];
    const seen: string[] = [];

    const output = await compactPiMessages(messages, fakeJev(() => 0.1, seen), {
      preserveRecentMessages: 2,
    });

    expect(seen).toHaveLength(2);
    expect(output.edits).toEqual([
      expect.objectContaining({ toolCallId: 'old', action: 'drop_call' }),
    ]);
    expect(output.messages.some((message) => (message as any).toolCallId === 'first')).toBe(true);
    expect(output.messages.some((message) => (message as any).toolCallId === 'recent')).toBe(true);
  });

  it('keeps one projection row for unsupported messages and does not score duplicate or unpaired IDs', async () => {
    const custom = { role: 'compactionSummary', summary: 'opaque session entry', timestamp: 2 } as AgentMessage;
    const good = [user('start'), custom, assistant([toolCall('good')]), toolResult('good', 'g'.repeat(500))];
    const compacted = await compactPiMessages(good, fakeJev(() => 0.1), { preserveRecentMessages: 0 });
    expect(compacted.stats.messagesBefore).toBe(good.length);
    expect(compacted.messages[1]).toBe(custom);

    const duplicate = [
      user('start'),
      assistant([toolCall('same')]),
      toolResult('same', 'a'.repeat(500)),
      assistant([toolCall('same')]),
      toolResult('same', 'b'.repeat(500)),
      assistant([toolCall('unpaired')]),
    ];
    const seen: string[] = [];
    const untouched = await compactPiMessages(duplicate, fakeJev(() => 0.1, seen), {
      preserveRecentMessages: 0,
    });
    expect(seen).toEqual([]);
    expect(untouched.edits).toEqual([]);
    expect(untouched.messages).toHaveLength(duplicate.length);
    expect(untouched.messages.every((message, index) => message === duplicate[index])).toBe(true);
  });

  it('does not score thinking, signed, future-content, failed, multimodal, error, or added-tool call groups', async () => {
    const imageResult = {
      role: 'toolResult',
      toolCallId: 'image',
      toolName: 'read',
      content: [{ type: 'text', text: 'text' }, { type: 'image', data: 'abc', mimeType: 'image/png' }],
      isError: false,
      timestamp: 4,
    } as AgentMessage;
    const messages = [
      user('start'),
      assistant([{ type: 'thinking', thinking: 'private reasoning' }, toolCall('thinking')]),
      toolResult('thinking', 't'.repeat(500)),
      assistant([{ type: 'text', text: 'signed', textSignature: 's' }, toolCall('signed')]),
      toolResult('signed', 's'.repeat(500)),
      assistant([toolCall('image')]),
      imageResult,
      assistant([toolCall('error')]),
      toolResult('error', 'e'.repeat(500), { isError: true }),
      assistant([toolCall('added')]),
      toolResult('added', 'a'.repeat(500), { addedToolNames: ['new-tool'] }),
      assistant([{ type: 'image', data: 'opaque', mimeType: 'image/png' }, toolCall('future')]),
      toolResult('future', 'f'.repeat(500)),
      assistant([toolCall('failed')], { stopReason: 'error' }),
      toolResult('failed', 'f'.repeat(500)),
    ];
    const seen: string[] = [];

    const output = await compactPiMessages(messages, fakeJev(() => 0.1, seen), {
      preserveRecentMessages: 0,
    });

    expect(seen).toEqual([]);
    expect(output.edits).toEqual([]);
    expect(output.messages.every((message, index) => message === messages[index])).toBe(true);
  });

  it('retains summaries and safe descriptions of unscored calls in Jev state', async () => {
    const protectedOutput = 'TOP SECRET TOOL OUTPUT '.repeat(40);
    const visibleBashOutput = 'DO NOT SEND BASH OUTPUT '.repeat(20);
    const excludedBashOutput = 'EXCLUDED OUTPUT '.repeat(20);
    const messages = [
      user('fix the actual request'),
      { role: 'compactionSummary', summary: 'Never modify generated files.', tokensBefore: 999, timestamp: 2 } as AgentMessage,
      { role: 'branchSummary', summary: 'We returned to the migration branch.', fromId: 'old', timestamp: 3 } as AgentMessage,
      {
        role: 'bashExecution', command: 'git status --short', output: visibleBashOutput,
        exitCode: 0, cancelled: false, truncated: false, timestamp: 4,
      } as AgentMessage,
      {
        role: 'bashExecution', command: 'echo hidden-command', output: excludedBashOutput,
        exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 5,
      } as AgentMessage,
      assistant([{ type: 'thinking', thinking: 'signed context' }, toolCall('protected')]),
      toolResult('protected', protectedOutput),
      assistant([toolCall('candidate')]),
      toolResult('candidate', 'c'.repeat(500)),
    ];
    let state: unknown;
    const asker: JevAsker = {
      async ask(nextState, questions: JevQuestions) {
        state = nextState;
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: 0.1 }]),
          ),
        };
      },
    };

    const output = await compactPiMessages(messages, asker, { preserveRecentMessages: 0 });
    const serialized = JSON.stringify(state);

    expect(output.edits).toEqual([
      expect.objectContaining({ toolCallId: 'candidate', action: 'drop_call' }),
    ]);
    expect((state as any).goal).toBe('fix the actual request');
    expect(serialized).toContain('Never modify generated files.');
    expect(serialized).toContain('We returned to the migration branch.');
    expect(serialized).toContain('git status --short');
    expect(serialized).toContain('protected');
    expect(serialized).toContain('args=');
    expect(serialized).toContain('protected.ts');
    expect(serialized).toContain('chars of output omitted');
    expect(serialized).not.toContain(protectedOutput);
    expect(serialized).not.toContain(visibleBashOutput);
    expect(serialized).not.toContain('hidden-command');
    expect(serialized).not.toContain(excludedBashOutput);
  });

  it('does not pair a result before its call or a result with another tool name', async () => {
    const messages = [
      user('start'),
      toolResult('early', 'e'.repeat(500)),
      assistant([toolCall('early')]),
      assistant([toolCall('wrong')]),
      toolResult('wrong', 'w'.repeat(500), { toolName: 'different-tool' }),
      assistant([toolCall('candidate')]),
      toolResult('candidate', 'c'.repeat(500)),
    ];
    const seen: string[] = [];

    const output = await compactPiMessages(messages, fakeJev(() => 0.1, seen), {
      preserveRecentMessages: 0,
    });

    expect(seen).toHaveLength(2);
    expect(output.edits).toEqual([
      expect.objectContaining({ toolCallId: 'candidate', action: 'drop_call' }),
    ]);
    expect(output.messages.some((message) => (message as any).toolCallId === 'early')).toBe(true);
    expect(output.messages.some((message) => (message as any).toolCallId === 'wrong')).toBe(true);
  });

  it('does not persist a no-op drop_result for short output', async () => {
    const messages = [user('start'), assistant([toolCall('short')]), toolResult('short', 'small'), user('continue')];
    const output = await compactPiMessages(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1)),
      { preserveRecentMessages: 0 },
    );

    expect(output.edits).toEqual([]);
    expect(output.stats.resultsDropped).toBe(0);
    expect(output.messages.every((message, index) => message === messages[index])).toBe(true);
  });

  it('rejects stale or forged cached edits before modifying the raw transcript', async () => {
    const raw = [user('start'), assistant([toolCall('safe')]), toolResult('safe', 'z'.repeat(600)), user('continue')];
    const compacted = await compactPiMessages(
      raw,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1)),
      { preserveRecentMessages: 0, truncateHeadChars: 20 },
    );
    const cached = compacted.edits[0]!;
    expect(cached.action).toBe('drop_result');

    const nowSigned = [...raw];
    nowSigned[1] = assistant([{ type: 'thinking', thinking: 'new protected group' }, toolCall('safe')]);
    const stale = applyPiEdits(nowSigned, [cached], 0);
    expect(stale.every((message, index) => message === nowSigned[index])).toBe(true);

    const forged: PiEdit = { ...cached, text: 'replace this with arbitrary text' };
    const untouched = applyPiEdits(raw, [forged], 0);
    expect(untouched.every((message, index) => message === raw[index])).toBe(true);
  });
});
