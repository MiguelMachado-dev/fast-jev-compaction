import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRecord = Record<string, any>;
type Handler = (event: AnyRecord, ctx: AnyRecord) => Promise<unknown> | unknown;
type Command = { description?: string; handler: (args: string, ctx: AnyRecord) => Promise<void> | void };

interface Harness {
  pi: AnyRecord;
  ctx: AnyRecord;
  handlers: Map<string, Handler>;
  flags: Map<string, AnyRecord>;
  commands: Map<string, Command>;
  appended: AnyRecord[];
  setFlag(name: string, value: string | boolean | undefined): void;
  setBranch(entries: AnyRecord[], leafId?: string | null): void;
  branch(): AnyRecord[];
  leaf(): string | null;
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): AnyRecord {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

function assistant(content: AnyRecord[]): AnyRecord {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-test',
    usage,
    stopReason: 'toolUse',
    timestamp: 2,
  };
}

function toolResult(toolCallId: string, text: string): AnyRecord {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'text', text }],
    details: { source: 'fixture' },
    usage,
    isError: false,
    timestamp: 3,
  };
}

function transcript(): AnyRecord[] {
  return [
    user('Keep src/generated unchanged and diagnose the failing test.'),
    assistant([
      { type: 'text', text: 'Checking the test output.' },
      { type: 'toolCall', id: 'read-old', name: 'read', arguments: { path: 'src/old.test.ts' } },
    ]),
    toolResult('read-old', 'export const oldResult = true;\n'.repeat(120)),
    assistant([{ type: 'text', text: 'The old output is now understood.' }]),
    user('Continue with the smallest safe change.'),
  ];
}

function textOf(message: AnyRecord): string {
  if (!Array.isArray(message.content)) return typeof message.content === 'string' ? message.content : '';
  return message.content.filter((part: AnyRecord) => part.type === 'text').map((part: AnyRecord) => part.text).join('');
}

function makeHarness(overrides: Record<string, string | boolean | undefined> = {}): Harness {
  const handlers = new Map<string, Handler>();
  const flags = new Map<string, AnyRecord>();
  const commands = new Map<string, Command>();
  const values = new Map<string, string | boolean | undefined>(Object.entries(overrides));
  const appended: AnyRecord[] = [];
  let branch: AnyRecord[] = [];
  let leafId: string | null = null;
  let sequence = 0;

  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    log: vi.fn(),
    setFooter: vi.fn(),
  };

  const ctx: AnyRecord = {
    hasUI: true,
    mode: 'tui',
    signal: undefined,
    ui,
    sessionManager: {
      getBranch: vi.fn(() => branch),
      getSessionId: vi.fn(() => 'session-a'),
      getLeafId: vi.fn(() => leafId),
    },
  };

  const pi: AnyRecord = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerFlag: vi.fn((name: string, options: AnyRecord) => flags.set(name, options)),
    getFlag: vi.fn((name: string) => values.has(name) ? values.get(name) : flags.get(name)?.default),
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      const entry = {
        type: 'custom',
        id: `extension-entry-${++sequence}`,
        parentId: leafId,
        timestamp: sequence,
        customType,
        data,
      };
      branch = [...branch, entry];
      leafId = entry.id;
      appended.push(entry);
    }),
  };

  return {
    pi,
    ctx,
    handlers,
    flags,
    commands,
    appended,
    setFlag(name, value) {
      values.set(name, value);
    },
    setBranch(entries, nextLeaf = entries.at(-1)?.id ?? null) {
      branch = [...entries];
      leafId = nextLeaf;
    },
    branch: () => [...branch],
    leaf: () => leafId,
  };
}

async function register(harness: Harness): Promise<void> {
  const { default: registerPiExtension } = await import('../pi/extension.js');
  registerPiExtension(harness.pi as any);
}

async function fire(harness: Harness, name: string, event: AnyRecord): Promise<unknown> {
  const handler = harness.handlers.get(name);
  if (!handler) throw new Error(`Missing ${name} handler`);
  return handler(event, harness.ctx);
}

async function runContext(harness: Harness, messages: AnyRecord[]): Promise<AnyRecord[]> {
  const result = await fire(harness, 'context', { type: 'context', messages });
  return (result as { messages?: AnyRecord[] } | undefined)?.messages ?? messages;
}

async function command(harness: Harness, args: string): Promise<void> {
  const registered = harness.commands.get('jev');
  if (!registered) throw new Error('Missing /jev command');
  await registered.handler(args, harness.ctx);
}

function responseForQuestions(init: RequestInit | undefined, score: (id: string) => number): Response {
  const body = JSON.parse(String(init?.body ?? '{}')) as { questions: Record<string, unknown> };
  return new Response(JSON.stringify({
    answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: score(id) }])),
  }), { status: 200 });
}

function scoringFetch(score: (id: string) => number) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => responseForQuestions(init, score));
}

describe('Pi extension runtime', () => {
  beforeEach(() => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers the documented flags and a single /jev command', async () => {
    const harness = makeHarness();
    await register(harness);

    expect(Object.fromEntries(harness.flags)).toEqual({
      'jev-min-tokens': expect.objectContaining({ type: 'string', default: '20000' }),
      'jev-preserve-recent': expect.objectContaining({ type: 'string', default: '6' }),
      'jev-timeout-ms': expect.objectContaining({ type: 'string', default: '10000' }),
      'jev-keep-threshold': expect.objectContaining({ type: 'string', default: '0.5' }),
      'jev-disabled': expect.objectContaining({ type: 'boolean', default: false }),
    });
    expect([...harness.commands.keys()]).toEqual(['jev']);
    expect(harness.commands.get('jev')?.description).toMatch(/status, prune, on, off, reset, restore/);
    await command(harness, 'status');
    await command(harness, 'status');
    expect(harness.ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it('scores once, preserves Pi metadata, caches the edit, then rescans for a new user intent', async () => {
    const fetcher = scoringFetch(id => id.startsWith('result_') ? 0.1 : 0.9);
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-min-tokens': '0', 'jev-preserve-recent': '0' });
    await register(harness);
    await fire(harness, 'session_start', { type: 'session_start', reason: 'startup' });

    const original = transcript();
    const first = await runContext(harness, original);
    const firstResult = first.find(message => message.role === 'toolResult');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first[1]).toMatchObject({ provider: 'openai', model: 'gpt-test', usage });
    expect(first[1]?.content[0]).toEqual(original[1]?.content[0]);
    expect(firstResult).toMatchObject({
      toolCallId: 'read-old',
      toolName: 'read',
      details: { source: 'fixture' },
      usage,
    });
    expect(textOf(firstResult!)).toContain('fast-jev-compaction truncated');
    expect(harness.appended.at(-1)).toMatchObject({
      customType: 'fast-jev-pi',
      data: expect.objectContaining({ version: 1, enabled: true, edits: expect.any(Array) }),
    });

    const cached = await runContext(harness, original);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(textOf(cached.find(message => message.role === 'toolResult')!)).toContain('fast-jev-compaction truncated');

    const newIntent = [...original, user('Switch to investigating the release script instead.')];
    await runContext(harness, newIntent);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('queues manual pruning, and reset or restore removes cached edits without a network side effect', async () => {
    const fetcher = scoringFetch(id => id.startsWith('result_') ? 0.1 : 0.9);
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-min-tokens': '999999', 'jev-preserve-recent': '0' });
    await register(harness);
    await fire(harness, 'session_start', { type: 'session_start', reason: 'startup' });
    const original = transcript();

    await command(harness, 'status');
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('API key configured'), 'info');
    await command(harness, 'prune');
    expect(fetcher).not.toHaveBeenCalled();
    await runContext(harness, original);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await command(harness, 'restore');
    const restored = await runContext(harness, original);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(restored).toBe(original);

    await command(harness, 'prune');
    await runContext(harness, original);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await command(harness, 'off');
    await runContext(harness, original);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await command(harness, 'on');
    await command(harness, 'reset');
    await command(harness, 'prune');
    await runContext(harness, original);
    expect(fetcher).toHaveBeenCalledTimes(3);

    await fire(harness, 'session_compact', {
      type: 'session_compact',
      compactionEntry: { type: 'compaction' },
      fromExtension: false,
      reason: 'manual',
      willRetry: false,
    });
    expect(harness.appended.at(-1)).toMatchObject({
      customType: 'fast-jev-pi',
      data: expect.objectContaining({ edits: [] }),
    });
  });

  it('hydrates only the active branch after resume and tree navigation', async () => {
    const fetcher = scoringFetch(id => id.startsWith('result_') ? 0.1 : 0.9);
    vi.stubGlobal('fetch', fetcher);
    const flags = { 'jev-min-tokens': '0', 'jev-preserve-recent': '0' };
    const firstRuntime = makeHarness(flags);
    await register(firstRuntime);
    await fire(firstRuntime, 'session_start', { type: 'session_start', reason: 'startup' });
    const original = transcript();
    await runContext(firstRuntime, original);
    const mainBranch = firstRuntime.branch();
    const mainLeaf = firstRuntime.leaf();
    expect(fetcher).toHaveBeenCalledTimes(1);

    const resumed = makeHarness(flags);
    resumed.setBranch(mainBranch, mainLeaf);
    await register(resumed);
    await fire(resumed, 'session_start', { type: 'session_start', reason: 'resume' });
    await runContext(resumed, original);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resumed.setBranch([], null);
    await fire(resumed, 'session_tree', { type: 'session_tree', newLeafId: null, oldLeafId: mainLeaf });
    await runContext(resumed, original);
    expect(fetcher).toHaveBeenCalledTimes(2);

    resumed.setBranch(mainBranch, mainLeaf);
    await fire(resumed, 'session_tree', { type: 'session_tree', newLeafId: mainLeaf, oldLeafId: null });
    await runContext(resumed, original);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps raw context when the key is missing, configuration is invalid, or Jev fails', async () => {
    const fetcher = vi.fn(async () => new Response('server transcript and secret key must not reach the UI', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    const missingKey = makeHarness({ 'jev-min-tokens': '0' });
    vi.stubEnv('TYPESAFE_API_KEY', '');
    await register(missingKey);
    await fire(missingKey, 'session_start', { type: 'session_start', reason: 'startup' });
    const original = transcript();
    expect(await runContext(missingKey, original)).toBe(original);
    expect(fetcher).not.toHaveBeenCalled();

    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const disabled = makeHarness({ 'jev-min-tokens': '0', 'jev-disabled': true });
    await register(disabled);
    await fire(disabled, 'session_start', { type: 'session_start', reason: 'startup' });
    expect(await runContext(disabled, original)).toBe(original);
    expect(fetcher).not.toHaveBeenCalled();

    const invalid = makeHarness({ 'jev-min-tokens': 'not-a-number' });
    await register(invalid);
    await fire(invalid, 'session_start', { type: 'session_start', reason: 'startup' });
    await runContext(invalid, original);
    await runContext(invalid, original);
    expect(fetcher).not.toHaveBeenCalled();
    expect(invalid.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(invalid.ctx.ui.notify).toHaveBeenCalledWith('Jev: Invalid --jev-min-tokens', 'warning');

    const failed = makeHarness({ 'jev-min-tokens': '0', 'jev-preserve-recent': '0' });
    await register(failed);
    await fire(failed, 'session_start', { type: 'session_start', reason: 'startup' });
    expect(await runContext(failed, original)).toBe(original);
    expect(await runContext(failed, original)).toBe(original);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(failed.ctx.ui.notify).toHaveBeenCalledWith('Jev: scoring failed; original context kept', 'warning');
    expect(JSON.stringify(failed.ctx.ui.notify.mock.calls)).not.toContain('server transcript');
    const moreToolWork = [...original, assistant([{ type: 'text', text: 'Still checking.' }])];
    expect(await runContext(failed, moreToolWork)).toBe(moreToolWork);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const newIntent = [...original, user('Investigate a different issue now.')];
    expect(await runContext(failed, newIntent)).toBe(newIntent);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cancels a stale score when navigation changes the active branch', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((_url: string | URL | Request, _init?: RequestInit) => new Promise<Response>(resolve => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-min-tokens': '0', 'jev-preserve-recent': '0' });
    await register(harness);
    await fire(harness, 'session_start', { type: 'session_start', reason: 'startup' });
    const original = transcript();

    const pending = runContext(harness, original);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    harness.setBranch([], null);
    await fire(harness, 'session_tree', { type: 'session_tree', newLeafId: null, oldLeafId: null });
    resolveResponse?.(responseForQuestions(fetcher.mock.calls[0]?.[1], () => 0.9));

    expect(await pending).toBe(original);
    expect(harness.appended).toHaveLength(0);

    await fire(harness, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' });
  });
});
