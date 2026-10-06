<div align="center">

# OpenChamber Queue

**A per-project task queue for [OpenChamber](https://openchamber.dev).**
Add tasks, flip the queue on, and the next task starts on its own once the
project has been idle for 10 seconds — one task at a time, no clicks per task.

English · [简体中文](./README.zh-CN.md)

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![OpenChamber](https://img.shields.io/badge/OpenChamber-%3E%3D%202.0.0-6f42c1.svg)](https://openchamber.dev)
[![Panel languages](https://img.shields.io/badge/panel_en%20%2F%20zh--cn%20%2F%20zh--tw-2ea44f.svg)](#languages)

<img src="./demo/screenshot/demo.png" alt="The Queue panel: an enable switch, a task box and the pending list" width="640" />

</div>

A task has a single field: **the content**, which is the prompt. Model, agent and
variant come from the project's own defaults. A task starts once that project has
had **no running session for 10 seconds**, so the rail stays quiet until there is
work to do.

> Built as an OpenChamber **extension** (panel + local service), not an OpenCode plugin.

## Contents

- [Features](#features)
- [How it works](#how-it-works) · [Dispatch rules](#dispatch-rules) · [Background service](#background-service)
- [Install](#install)
- [Usage](#usage)
- [Storage and persistence](#storage-and-persistence)
- [Permissions](#permissions)
- [Limitations](#limitations)
- [Development](#development)
- [Languages](#languages)
- [License](#license)

## Features

- **One queue per project** — switching projects switches queues.
- **Automatic dispatch** — a new session is created and the prompt sent once the
  project has been idle for 10 seconds; no clicks per task.
- **Run now** — a second button sends the draft into a fresh session at once,
  without queueing it.
- **Run a queued task now** — each row has a *Run* button that starts that
  task's session immediately and removes it from the queue, counting it in *Done*.
- **Hand-off queue** — a task is removed and counted in *Done* the moment its
  session is created; an empty queue turns its own switch off.
- **Questions don't block** — a session waiting on a question does not hold the
  project, so the next task is dispatched.
- **Editable while stopped** — click a task card to edit it in place; edits are
  refused while the queue is running.
- **Works with the page closed** — the queue is driven by a server-side local
  service, not by the browser tab.
- **Localized panel** — follows the OpenChamber language (English, 简体中文, 繁體中文).

## How it works

### Dispatch rules

For each project, every tick:

1. Queue disabled, or empty → nothing to do.
2. The session this queue started is still **executing** → wait.
3. Any **other** session in the project is really executing → wait.
4. The project must then stay free for **10 seconds**. Anything that wakes up
   inside that window — a session you start, a retry on the session that just
   finished — resets the count, so the project has a moment to settle.
5. Take the first pending task → create a session → send the content. The task
   leaves the queue and is counted in *Done* right away. The 10-second window
   starts over before the task after it.
6. When that session stops executing (idle, gone, or asking a question) the
   project is free again and the window restarts. When the queue empties, the
   switch turns itself off.

The 10-second window applies to the first task too: turning the switch on with a
task waiting starts it 10 seconds later, not instantly.

"Really executing" means `running`, `retrying` or `waiting-permission`.
`waiting-question` is **not** considered occupied, so an agent that is asking a
question never blocks the queue — its task is already handed off — while a session
you started yourself does make the queue wait its turn. A session that sent a
command to the background also counts as executing: it reports idle while the
command runs, and the queue waits for that command to finish before it moves on.

### Background service

The queue is owned by a Node process the host starts for
`contributes.service`. It talks to the local OpenChamber control API — the same
route the bundled `openchamber` CLI uses — to read session state, create sessions
and send prompts, and it keeps running with no panel or window open.

The panel is only a view onto that service. It does **not** keep a second,
panel-owned copy of the queue; when the service is not up yet the panel shows a
connecting state and retries until it answers. Because of that, a task added
while the service is starting is never written to a store the service cannot
see — it either reaches the service or the panel says it is still connecting.

The local service must be approved at install time. The queue does not work
without it; approving it is what lets the queue keep running in the background.

## Install

OpenChamber **2.0.0 or newer**, web or desktop.

1. **Settings → Extensions**.
2. Paste one of these into **folder, ZIP or URL** and press **Add**:
   - the latest packaged zip — this URL always points at the newest build:
     `https://github.com/open-tecmz/openchamber-queue/releases/latest/download/openchamber-queue-latest.zip`
   - the `.zip` file from the latest **Releases** page,
   - the `dist/` folder of a local clone (run `npm run build` once first),
   - the git URL of the `release` branch —
     `https://github.com/open-tecmz/openchamber-queue.git#release`
     (git installs can **Update** from Settings → Extensions when `package.json`
     version increases; a zip install cannot, so re-add the newer zip by hand).
3. Approve the permission dialog (**Allow and enable**). It lists `prompt`,
   `sessions` and `service`; the local service runs with your full user rights.

## Usage

Open the **Queue** panel from the extensions area of the rail:

1. Type a task in the box → **Run now** to start a session immediately, or
   **Add to queue** to line it up.
2. Turn on **Enable queue**.
3. Leave it alone. Once the project has been idle for 10 seconds the first task
   runs; when it finishes the next one starts.

The header shows the mode and two counters on the right: **pending / done**. Each
row has *Run*, *Top*, *Retry* (failed only) and *Delete*. *Run* starts that task's
session immediately and removes it from the queue, without waiting for the project
to be idle. With the queue stopped, click a row to expand it into an editor with
**Save** / **Cancel**.

Other ways to add a task:

- message menu → **Add to queue** (queues the message text);
- composer slash command → `/queue <content>`.

## Storage and persistence

| Data | Location |
| --- | --- |
| Queue state | `~/.config/openchamber-queue/state.json`, or `$OPENCHAMBER_QUEUE_DATA_DIR/state.json` |
| Install record and grants | `<OpenChamber data dir>/extensions.json` |

The queue keeps its own file *beside* the host's data dir — never inside
a project. The host data dir is `~/.config/openchamber`, unless `OPENCHAMBER_DATA_DIR`
is set on the host (a service process does not receive that variable, so a custom
host dir is not mirrored).

Data is a plain JSON file, so it survives restarts, updates and uninstalling. The
**worker, however, does not auto-start**: OpenChamber spawns a guest service only on
demand, so after the OpenChamber process restarts the queue is paused until you open
the panel once (or run a message action / `/queue` command). After that it is
resident again. A queue that was enabled resumes where it left off.

Uninstalling the extension clears its install record and grants; delete
`~/.config/openchamber-queue/` by hand to wipe the queue state too.

## Permissions

| Capability | Why |
| --- | --- |
| `sessions` | list projects and sessions, create sessions |
| `prompt` | send the task content to the new session |
| `service` | the local service that owns the queue; it is required and runs with your full user rights |

The queue has no panel-side fallback: if the local service is not approved, the
panel stays on the connecting state until it is.

## Limitations

- **Cold start** — see *Storage and persistence*: one panel open (or an action) per
  OpenChamber process start is needed to bring the background worker up.
- **Non-public interface** — the service uses the product's own control API and
  proxied OpenCode session routes. These are what the bundled CLI uses, but they are
  not a guest-facing contract and may change between OpenChamber versions.
- **A task counts as done when it is handed off** — the queue sends the prompt but
  cannot tell whether the agent succeeded. Check the session in OpenChamber for the
  result.
- **Manifest strings are not localizable** — the extension API takes a fixed panel
  name, command description and action label, so they stay in the declared language
  while the panel itself follows OpenChamber's.
- Extensions do not load in VS Code or the mobile app, so the queue does not either.

## Development

```bash
npm install
npm run build       # assembles the installable package into dist/
npm run typecheck
npm test            # builds, then runs an isolated end-to-end test against a stub
```

`npm run build` writes the whole installable package to `dist/`: `dist/package.json`,
`dist/icon.svg`, `dist/panel/{index,background}.html`, and the two bundles
`dist/panel/main.js` (browser IIFE) + `dist/service/main.js` (Node ESM). The host
loads built `.js` files as they sit in the package, so the pages and their bundles
must stay in the same folder. `dist/` is generated and **not committed**; CI builds
it on every push to `main`.

To run your build while developing, folder-install `dist/` (Settings → Extensions):
it runs from your folder, so edit, rebuild, and reload. `npm test` covers the
headless service.

The host never compiles an extension: ship built files only. Editing `src/i18n.ts`
and rebuilding is enough to add a language. These are the only `devDependencies`;
nothing here ships `node_modules`. Record every change in `changelog.md` before you
finish — the repo rule lives in `AGENTS.md`.

## Languages

The panel follows the OpenChamber language and falls back to English. Panel copy
ships in `en`, `zh-cn` and `zh-tw`; add one by extending `DICTIONARIES` in
`src/i18n.ts` — the dictionary type makes a missing key a compile error. This
documentation ships in English (this file) and 简体中文
([README.zh-CN.md](./README.zh-CN.md)).

## License

[Apache-2.0](./LICENSE).
