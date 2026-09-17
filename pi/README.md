# fast-jev-compaction for Pi

This extension uses Jev to decide which eligible tool calls and tool results
can be omitted from the context sent to Pi's next model request. It is a
context-only transform: Pi's original session messages remain unchanged,
including the original tool output and all messages that Jev did not see or
edit. The extension only appends its branch-local cached decision entry.

Pi's built-in `/compact`, automatic compaction, overflow recovery, and branch
summaries still run normally. The extension has no custom compaction hook. If
scoring fails, is cancelled, has no API key, or a cached edit no longer matches
the active branch, it returns the original context to Pi.

## Install

Pi 0.85.1 needs Node 22.19 or newer. The standalone library in this repository
continues to support Node 18 and newer.

After the upstream merge:

```sh
pi install git:github.com/tamaratran/fast-jev-compaction
```

For a checkout during development:

```sh
pi -e ./pi/extension.ts
```

To install the fork branch as a package:

```sh
pi install git:github.com/MiguelMachado-dev/fast-jev-compaction@feat/pi-extension
```

Set `TYPESAFE_API_KEY` in Pi's environment. Without it the extension stays
inert and `/jev status` reports the missing key.

## Safety and data handling

The extension only considers a one-to-one assistant tool call and successful,
single-text tool result. It pins the first and recent configured message rows
and leaves image-bearing rows, error results, thinking blocks, signed content,
non-text/multi-part results, and tool-discovery results untouched. A persisted
edit has a fingerprint of both sides of the pair; if any edit is stale or
invalid, none of the cached edits are applied.

The TypeSafe scoring request contains conversation text, Pi summaries,
non-excluded `!` bash commands, and tool names and arguments, including
protected calls. Tool output is represented only by a length and status note,
so output bodies are not sent to the scoring API. `!!` bash executions marked
`excludeFromContext` are omitted. Do not enable the extension if those texts,
summaries, commands, or tool arguments cannot leave the environment.

`~N tokens removed` in the Pi status is an approximate context-size estimate,
not a tokenizer measurement or a response-time measurement.

## Flags

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--jev-min-tokens` | `20000` | Approximate context size needed before automatic scoring. |
| `--jev-preserve-recent` | `6` | Newest message rows never changed. |
| `--jev-timeout-ms` | `10000` | Scoring deadline in milliseconds, from 1 to 120000. |
| `--jev-keep-threshold` | `0.5` | Probability required to keep a call or full result, from 0 to 1. |
| `--jev-disabled` | `false` | Starts disabled. |

## Commands

| Command | Effect |
| --- | --- |
| `/jev status` | Reports extension state, API-key state, and cached edit count. |
| `/jev prune` | Forces scoring on the next model request; it makes no request itself. |
| `/jev on` / `/jev off` | Enables or disables automatic pruning on the current branch. |
| `/jev reset` / `/jev restore` | Clears cached edits without changing the current enabled state. |

Cached decisions are saved in branch-local custom session entries. They are
reloaded after Pi starts or `/tree` navigates to its active branch, and are
discarded after native Pi compaction or a configuration change. A new user
prompt, eight new message rows, or `/jev prune` causes a fresh score.
