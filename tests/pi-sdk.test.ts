import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import registerPiExtension from '../pi/extension.js';

type AnyRecord = Record<string, any>;

const usage = {
  input: 2,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 4,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp: number): AgentMessage {
  return { role: 'user', content: text, timestamp } as AgentMessage;
}

function assistant(content: AnyRecord[], extras: AnyRecord = {}): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-6-astra',
    responseId: 'sdk-fixture-response',
    usage,
    stopReason: 'stop',
    timestamp: 2,
    ...extras,
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    details: { source: 'sdk-fixture' },
    timestamp: 3,
  } as AgentMessage;
}

function doneStream(model: AnyRecord, text: string) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
  });
  return stream;
}

function jevFetch(bodies: AnyRecord[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as AnyRecord;
    bodies.push(body);
    return new Response(JSON.stringify({
      answers: Object.fromEntries(Object.keys(body.questions ?? {}).map(question => [
        question,
        { type: 'noul', noul: 0.1 },
      ])),
    }), { status: 200 });
  });
}

describe('Pi SDK native compaction integration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('commits a Jev checkpoint through AgentSession.compact, restores typed context for the next request, and gives native fallback the full retained checkpoint', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'offline-jev-test-key');
    const jevBodies: AnyRecord[] = [];
    vi.stubGlobal('fetch', jevFetch(jevBodies));

    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey('openai', 'offline-provider-test-key');
    const model = getModel('openai', 'gpt-6-astra');
    if (!model) throw new Error('The bundled OpenAI Astra model is unavailable');

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [registerPiExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(process.cwd());
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      model,
      thinkingLevel: 'xhigh',
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: 'all',
    });

    const providerContexts: AnyRecord[] = [];
    const providerOptions: AnyRecord[] = [];
    const streamFn = vi.fn((requestModel: AnyRecord, context: AnyRecord, options?: AnyRecord) => {
      providerContexts.push(context);
      providerOptions.push(options ?? {});
      return doneStream(requestModel, 'OFFLINE PROVIDER RESPONSE');
    });
    (session.agent as any).streamFunction = streamFn;
    await session.bindExtensions({});
    expect(session.thinkingLevel).toBe('xhigh');

    const fullRetainedText = `SDK-RETAINED:${'complete retained checkpoint text '.repeat(90)}`;
    const droppedOutput = `SDK-DROPPED:${'recomputable output '.repeat(700)}`;
    const transcript = [
      user('Keep the generated directory unchanged.', 1),
      assistant([
        { type: 'thinking', thinking: 'Astra typed reasoning must remain intact.', thinkingSignature: 'astra-thinking-signature' },
        { type: 'text', text: 'I will inspect an old result.' },
      ], { responseId: 'astra-sdk-response' }),
      user(fullRetainedText, 3),
      assistant([
        { type: 'text', text: 'Reading a stale report.' },
        { type: 'toolCall', id: 'sdk-old-read', name: 'read', arguments: { path: 'reports/sdk-old.txt' } },
      ], { stopReason: 'toolUse', timestamp: 4 }),
      toolResult('sdk-old-read', droppedOutput),
      assistant([{ type: 'text', text: 'Old report understood.' }], { timestamp: 5 }),
      user('Continue.', 6),
      assistant([{ type: 'text', text: 'Working.' }], { timestamp: 7 }),
      user('Use the smallest safe change.', 8),
      assistant([{ type: 'text', text: 'Ready.' }], { timestamp: 9 }),
      user('Finish the task.', 10),
    ];
    for (const message of transcript) sessionManager.appendMessage(message as any);

    const checkpointResult = await session.compact();
    const savedCheckpoint = sessionManager.getLeafEntry() as AnyRecord;
    expect(jevBodies).toHaveLength(1);
    expect(streamFn).not.toHaveBeenCalled();
    expect(checkpointResult.details).toMatchObject({ format: 'fast-jev-pi-context-v1' });
    expect(savedCheckpoint).toMatchObject({ type: 'compaction', fromHook: true });
    expect(savedCheckpoint.details.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-6-astra',
      responseId: 'astra-sdk-response',
      content: expect.arrayContaining([expect.objectContaining({ type: 'thinking', thinkingSignature: 'astra-thinking-signature' })]),
    }));
    expect(JSON.stringify(savedCheckpoint.details.messages)).not.toContain(droppedOutput);

    await session.prompt('Make a short status reply.', { expandPromptTemplates: false });
    const followingProviderContext = providerContexts.at(-1);
    expect(JSON.stringify(followingProviderContext)).toContain('Astra typed reasoning must remain intact.');
    expect(JSON.stringify(followingProviderContext)).toContain('Make a short status reply.');
    expect(JSON.stringify(followingProviderContext)).not.toContain(droppedOutput);
    expect(providerOptions.at(-1)).toMatchObject({ reasoning: 'xhigh' });

    vi.stubEnv('TYPESAFE_API_KEY', '');
    sessionManager.appendMessage(user('Native fallback has another update to summarize.', 20) as any);
    sessionManager.appendMessage(user('This creates a later native compaction boundary.', 21) as any);
    const fallbackResult = await session.compact();
    const summaryContext = providerContexts.find(context => JSON.stringify(context).includes('<previous-summary>'));

    expect(jevBodies).toHaveLength(1);
    expect(fallbackResult.summary).toBe('OFFLINE PROVIDER RESPONSE');
    expect(summaryContext).toBeDefined();
    expect(JSON.stringify(summaryContext)).toContain(fullRetainedText);
    expect(JSON.stringify(summaryContext)).toContain('<read-files>');
    expect(JSON.stringify(summaryContext)).toContain('reports/sdk-old.txt');

    session.dispose();
  });
});
