# OpenChamber Queue

English · [简体中文](./README.zh-CN.md)

A per-project task queue for [OpenChamber](https://openchamber.dev). Add tasks to a
project, turn the queue on, and OpenChamber starts a session with the next task
whenever that project has **no running session**. One queue task runs per project at
a time.

A task has a single field: **the content**, which is the prompt. Model, agent and
variant come from the project's own defaults.

> Built as an OpenChamber **extension** (panel + local service), not an OpenCode plugin.

## Features

- **One queue per project** — switching projects switches queues.
- **Automatic dispatch** — a new session is created and the prompt sent as soon as
  the project is idle; no clicks per task.
- **Self-cleaning** — a finished task is deleted and counted in *Done*; an empty
  queue turns its own switch off.
- **Questions don't block** — if the agent stops to ask a question, that task goes
  back to the queue and the next one runs.
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
   - If it is **waiting on a question** → the task returns to the queue (at the
     back) and the next task is dispatched.
3. Any **other** session in the project is really executing → wait.
4. Otherwise take the first pending task → create a session → send the content.
5. When that session goes idle → delete the task, *Done + 1*, continue. When the
   queue empties, the switch turns itself off.

"Really executing" means `running`, `retrying` or `waiting-permission`.
`waiting-question` is **not** considered occupied, so an agent that is asking a
question never blocks the queue, while a session you started yourself does make the
queue wait its turn.

### Background vs foreground

| Mode | When | Works with the page closed |
| --- | --- | --- |
| **Background** (recommended) | The extension's local service is approved and reachable | Yes |
| **Foreground** | No service grant, or the service is unavailable | No |

Background mode is handled by a Node process the host starts for
`contributes.service`. It talks to the local OpenChamber control API — the same
route the bundled `openchamber` CLI uses — to read session state, create sessions
and send prompts. Foreground mode falls back to host APIs and only runs while a
panel is open; the panel shows a banner when that happens.

## Install

OpenChamber **2.0.0 or newer**, web or desktop.

1. **Settings → Extensions**.
2. Paste one of these into **folder, ZIP or URL** and press **Add**:
   - the `dist/` folder of a local clone (run `npm run build` once first),
   - the `.zip` from the latest **Releases** page,
   - the git URL of the `release` branch —
     `https://github.com/<owner>/openchamber-queue.git#release`
     (git installs can **Update** from Settings → Extensions when `package.json`
     version increases; a zip install cannot, so re-add the newer zip by hand).
3. Approve the permission dialog (**Allow and enable**). It lists `prompt`,
   `sessions` and `service`; the local service runs with your full user rights.

## Usage

Open the **Queue** panel from the extensions area of the rail:

1. Type a task in the box → **Add to queue**.
2. Turn on **Enable queue**.
3. Leave it alone. When the project is idle the first task runs; when it finishes
   the next one starts.

The header shows the mode and three counters on the right: **pending / running /
done**. Each row has *Session*, *Top*, *Retry* (failed only) and *Delete*. With the
queue stopped, click a row to expand it into an editor with **Save** / **Cancel**.

Other ways to add a task:

- message menu → **Add to queue** (queues the message text);
- composer slash command → `/queue <content>`.

## Storage and persistence

| Data | Location |
| --- | --- |
| Queue state (background mode) | `<OpenChamber data dir>/openchamber-queue/state.json` |
| Queue state (foreground mode) | host storage, `<OpenChamber data dir>/guest-storage/queue.json` |
| Install record and grants | `<OpenChamber data dir>/extensions.json` |

The data dir defaults to `~/.config/openchamber` (`%APPDATA%\openchamber` on
Windows, `~/Library/Application Support/openchamber` where the desktop app sets
one), unless `OPENCHAMBER_DATA_DIR` is set.

Data is a plain JSON file, so it survives restarts, updates and uninstalling. The
**worker, however, does not auto-start**: OpenChamber spawns a guest service only on
demand, so after the OpenChamber process restarts the queue is paused until you open
the panel once (or run a message action / `/queue` command). After that it is
resident again. A queue that was enabled resumes where it left off.

Uninstalling the extension removes the host-owned foreground storage; delete
`<data dir>/openchamber-queue/` by hand to wipe the background queue too.

## Permissions

| Capability | Why |
| --- | --- |
| `sessions` | list projects and sessions, create sessions |
| `prompt` | send the task content to the new session |
| `service` | granted together with the local service; it runs with your full user rights |

## Limitations

- **Cold start** — see *Storage and persistence*: one panel open (or an action) per
  OpenChamber process start is needed to bring the background worker up.
- **Non-public interface** — the service uses the product's own control API and
  proxied OpenCode session routes. These are what the bundled CLI uses, but they are
  not a guest-facing contract and may change between OpenChamber versions.
- **A failed turn still counts as done** — the queue detects that the session went
  idle, not whether the agent liked the result. Follow the session link to check.
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
nothing here ships `node_modules`.

## Project layout

```
package.json            extension manifest + scripts
icon.svg                rail icon
scripts/build.mjs       assembles dist/ (the installable package)
.github/workflows/      CI: build dist/, publish the release branch + zip
src/core.ts             queue model and the pure planTick rule (shared)
src/i18n.ts             panel copy per locale
panel/main.ts           panel + background frame  -> dist/panel/main.js
panel/index.html        rail panel page
panel/background.html   on-demand page for actions and /queue
service/main.ts         background worker         -> dist/service/main.js
dist/                   built installable package (generated, not committed)
PROPOSAL.md             original design notes
README.zh-CN.md         简体中文说明
_temp/                  local test harness (not shipped)
```

## Languages

The panel follows the OpenChamber language and falls back to English. Panel copy
ships in `en`, `zh-cn` and `zh-tw`; add one by extending `DICTIONARIES` in
`src/i18n.ts` — the dictionary type makes a missing key a compile error. This
documentation ships in English (this file) and 简体中文
([README.zh-CN.md](./README.zh-CN.md)).

## License

[MIT](./LICENSE).
