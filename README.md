# fast-jev-compaction

Claude Code plugin and Pi package that use Jev decisions to remove or truncate
stale tool calls and results while keeping everything else verbatim. Also
usable as an npm library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Pi extension

The Pi package exposes `pi/extension.ts` through its `package.json` manifest.
It uses Pi's `context` hook to create a pruned copy only for the next model
request. It does not replace session entries: the JSONL session still contains
the complete original conversation, and a cached pruning decision is saved as
a branch-scoped custom entry so it can be restored after a reload or `/tree`
navigation.

Pi's own `/compact`, automatic compaction, overflow recovery, and branch
summaries remain native Pi behavior. This extension does not supply a custom
compaction summary. If Jev is unavailable, a request is cancelled, a response
is malformed, or a stored decision no longer matches the active transcript,
the extension forwards the original context and Pi keeps its usual compaction
fallback available.

Only a complete, one-to-one tool-call/result pair is eligible. The adapter
pins the first row and the configured recent rows, and refuses to edit rows
with images, errors, thinking blocks, signatures, non-text/multi-part results,
or tool-discovery metadata. It also keeps a call and its result paired. These
guards are deliberate: a decision that cannot be replayed without changing
Pi's message structure is discarded instead of partially applied.

### Privacy and API data

Jev receives conversation text, Pi compaction and branch summaries, non-excluded
`!` bash commands, and tool names and arguments (including protected calls).
For scoring, every tool output body is replaced with a short length/status
note; output bodies are not sent to the TypeSafe API. A `!!` bash execution
marked `excludeFromContext` is omitted from the scoring input. Set
`TYPESAFE_API_KEY` only if that text, those summaries, commands, and tool
arguments may be sent to TypeSafe.

The status line may report `~N tokens removed`. That is an approximate context
size estimate based on the message content forwarded to Pi, not a tokenizer
measurement or a claim about response time.

### Install

The npm library supports Node 18 and newer. Pi 0.85.1 requires Node 22.19 or
newer, so use that version when loading the Pi extension.

After this change is merged upstream:

```sh
pi install git:github.com/tamaratran/fast-jev-compaction
```

To run the extension directly from a local checkout:

```sh
pi -e ./pi/extension.ts
```

To install the fork branch before the upstream merge:

```sh
pi install git:github.com/MiguelMachado-dev/fast-jev-compaction@feat/pi-extension
```

Set `TYPESAFE_API_KEY` in the environment that starts Pi. Without a key the
extension is inert, leaves context unchanged, and `/jev status` reports that
the key is missing.

### Configuration

Pi loads these extension flags from the command line:

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--jev-min-tokens` | `20000` | Approximate context size that enables automatic scoring. |
| `--jev-preserve-recent` | `6` | Newest message rows that are never edited. |
| `--jev-timeout-ms` | `10000` | Deadline for one complete scoring pass, from 1 to 120000 ms. |
| `--jev-keep-threshold` | `0.5` | Minimum Jev probability required to keep a call or full result, from 0 to 1. |
| `--jev-disabled` | `false` | Starts the extension disabled. |

For example: `pi --jev-min-tokens 24000 --jev-preserve-recent 8`.

Use the `/jev` command inside Pi:

| Command | Effect |
| --- | --- |
| `/jev status` | Shows whether pruning can run, whether a key is configured, and the cached edit count. |
| `/jev prune` | Queues a forced rescore for the next model request; it does not make an LLM request by itself. |
| `/jev on` / `/jev off` | Enables or disables automatic pruning for the active branch. |
| `/jev reset` / `/jev restore` | Clears cached edits and keeps automatic pruning enabled if it was enabled. |

After a successful score, the extension reuses the same edits until a new user
prompt arrives, eight new message rows appear, or `/jev prune` forces a new
score. `/tree` navigation restores the cached edits for the newly active
branch. Native Pi compaction, malformed persisted state, and configuration
changes invalidate a cache.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
