/**
 * OpenChamber Queue — rail panel and background frame.
 *
 * Two data modes:
 *  - `backend`: the `contributes.service` grant exists and the service is
 *    reachable. The service owns the queue and keeps dispatching with no
 *    client open.
 *  - `local`: no service grant. The panel drives with host APIs while open.
 *
 * In `backend` mode the panel does not poll: it follows the service's event
 * stream (`GET /events`), which answers the moment the queue moves and ends the
 * hold when it does not, and it re-reads from its cursor whenever a hold ends.
 * The service also exposes that stream as real SSE (`GET /events/stream`).
 *
 * Panel copy follows the OpenChamber language (`ctx.locale`); see `src/i18n.ts`.
 */

import {
  HostRequestError,
  connectHost,
  type GuestSessionsSnapshot,
  type HostClient,
} from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSeparator,
  mountSpinner,
  mountSwitch,
  mountTextField,
  type ButtonHandle,
  type TextFieldHandle,
  type TextFieldProps,
} from '@openchamber/sdk/ui';

import {
  ACTIVE_GRACE_MS,
  clearTasks,
  countTasks,
  deriveTitle,
  editTask,
  emptyQueue,
  emptyState,
  ensureQueue,
  finishRun,
  getQueue,
  hashKey,
  isOccupied,
  makeTask,
  markFailed,
  moveTask,
  planTick,
  registerProject,
  removeTask,
  repairQueue,
  retryTask,
  startTask,
  type ActiveRun,
  type ActiveStatus,
  type ProjectInfo,
  type ProjectQueue,
  type QueueEvent,
  type QueueSnapshot,
  type QueueState,
  type QueueTask,
  type SessionActivity,
} from '../src/core.ts';
import { createTranslator, type Translator } from '../src/i18n.ts';

const PROVIDER_ID = 'queue';
const STORAGE_PREFIX = 'openchamber-queue';
/**
 * How long a read of the service's event stream may hold before it answers "no
 * events yet". A parked read costs a whole connection, and a sandboxed panel
 * has only a few of them: a remount, a directory change or a return to the
 * window starts a new read and leaves the previous one parked (the host offers
 * no way to cancel it), so a long hold lets a handful of stale readers fill the
 * panel's connection budget and make every later command wait for a free slot —
 * the button spins while the request is still queued in the browser. A short
 * hold keeps that overlap small; an event still arrives the moment it happens,
 * because the read ends as soon as one does and the panel re-arms at once.
 */
const WAIT_MS = 2000;
/** A watch that fails instantly (not by expiring) waits this long before retrying. */
const WATCH_RETRY_MS = 1000;
/** Used only for a service too old to have an event stream. */
const FALLBACK_POLL_MS = 5000;
/** Foreground mode is driven by host session pushes; this is the safety net. */
const LOCAL_SAFETY_MS = 30_000;
const MAX_STEPS_PER_TICK = 4;

type Mode = 'backend' | 'local' | 'unknown';

const host: HostClient = connectHost();
const root = document.querySelector('#root') as HTMLElement;

let t: Translator = createTranslator('en');
let localeTag = 'en';
let mode: Mode = 'unknown';
let project: ProjectInfo | null = null;
let directory: string | null = null;
let queue: ProjectQueue = emptyQueue();
let renderKey = '';
let panelMounted = false;
let backgroundMounted = false;
let directoryRef: string | null = null;
let editingId: string | null = null;
let draftText = '';
/** True until the panel has read the queue for the first time. */
let loading = true;

const modeLabel = (value: Mode): string => t(`mode.${value}`);

// ---------------------------------------------------------------------------
// Busy feedback
// ---------------------------------------------------------------------------

/**
 * A slim bar across the top of the panel while a user-driven request is in
 * flight. It only appears when the request outlasts a short delay, so a fast
 * command never flashes it. The node lives outside `#root`, which every render
 * rebuilds, so it survives untouched.
 */
const BUSY_DELAY_MS = 140;

let pending = 0;
let busyTimer: number | null = null;
let busyBar: HTMLElement | null = null;

const mountBusyBar = (): void => {
  if (busyBar) return;
  busyBar = el('div', 'qx-busy');
  busyBar.hidden = true;
  document.body.appendChild(busyBar);
};

const syncBusy = (): void => {
  const bar = busyBar;
  if (!bar) return;
  if (pending > 0) {
    // Reveal late, and only if something is still running by then.
    if (busyTimer === null && bar.hidden) {
      busyTimer = window.setTimeout(() => {
        busyTimer = null;
        if (pending > 0 && busyBar) busyBar.hidden = false;
      }, BUSY_DELAY_MS);
    }
    return;
  }
  if (busyTimer !== null) {
    window.clearTimeout(busyTimer);
    busyTimer = null;
  }
  bar.hidden = true;
};

const beginPending = (): void => {
  pending += 1;
  syncBusy();
};

const endPending = (): void => {
  pending = Math.max(0, pending - 1);
  syncBusy();
};

/** Runs `task` with the button spun up until it settles. */
const withLoading = (handle: ButtonHandle, task: () => Promise<void>): void => {
  handle.update({ loading: true });
  void task().finally(() => handle.update({ loading: false }));
};

// ---------------------------------------------------------------------------
// Backend client (serviceRequest)
// ---------------------------------------------------------------------------

const isNoService = (error: unknown): boolean =>
  error instanceof HostRequestError && (error.code === 'NO_SERVICE' || error.code === 'DISABLED');

/** The service predates the service-wide event stream; fall back to polling. */
class EventsUnsupportedError extends Error {}

/** One read of `/events`: the events since a cursor, and the cursor after them. */
type EventsBatch = { reset: boolean; superseded: boolean; events: QueueEvent[]; seq: number };
/** What a command answers with: the state and cursor left behind. */
type CommandResult = { queue: ProjectQueue | null; seq: number };

const backend = {
  async request<T>(method: string, path: string, query?: Record<string, string>, body?: string): Promise<T> {
    const result = await host.serviceRequest({
      method: method as never,
      path,
      ...(query ? { query } : {}),
      ...(body ? { body } : {}),
    });
    return JSON.parse(result.body) as T;
  },
  health(): Promise<void> {
    return this.request<void>('GET', '/health');
  },
  async load(projectId: string): Promise<QueueSnapshot> {
    const data = await this.request<Partial<QueueSnapshot>>('GET', '/state', { projectId });
    if (!data.queue) throw new EventsUnsupportedError('service did not return a queue');
    return { project: data.project ?? null, queue: data.queue, seq: typeof data.seq === 'number' ? data.seq : 0 };
  },
  /**
   * Reads the service's event stream after `after`; holds until the first event
   * arrives. One stream covers every project — the events name their project —
   * so opening another project never asks for another reader.
   */
  async events(after: number): Promise<EventsBatch> {
    const data = await this.request<{
      events?: QueueEvent[]; reset?: boolean; superseded?: boolean; seq?: number;
    }>('GET', '/events', { after: String(after), wait: String(WAIT_MS) });
    if (!Array.isArray(data.events) || typeof data.seq !== 'number') {
      throw new EventsUnsupportedError('service has no event stream');
    }
    return {
      reset: data.reset === true,
      superseded: data.superseded === true,
      events: data.events,
      seq: data.seq,
    };
  },
  async command(projectId: string, command: Record<string, unknown>): Promise<CommandResult> {
    const data = await this.request<{ queue?: ProjectQueue; seq?: number }>(
      'POST',
      '/cmd',
      undefined,
      JSON.stringify({ ...command, projectId }),
    );
    return { queue: data.queue ?? null, seq: typeof data.seq === 'number' ? data.seq : 0 };
  },
};

// ---------------------------------------------------------------------------
// Local storage (no service grant)
// ---------------------------------------------------------------------------

let localState: QueueState = emptyState();
const indexKey = `${STORAGE_PREFIX}/index`;
const queueKey = (projectId: string) => `${STORAGE_PREFIX}/q/${hashKey(projectId)}`;

const loadLocal = async (): Promise<void> => {
  localState = emptyState();
  const index = (await host.storage.get(indexKey)) as { projects?: Record<string, ProjectInfo> } | undefined;
  for (const [id, info] of Object.entries(index?.projects ?? {})) {
    localState.projects[id] = info;
    const stored = (await host.storage.get(queueKey(id))) as ProjectQueue | undefined;
    localState.queues[id] = stored ? repairQueue(stored) : emptyQueue();
  }
};

const saveIndex = (): Promise<void> => host.storage.set(indexKey, { projects: localState.projects } as never);
const saveQueue = (projectId: string): Promise<void> =>
  host.storage.set(queueKey(projectId), localState.queues[projectId] as never);

// ---------------------------------------------------------------------------
// Local driver: the same tick rule, driven by host session snapshots
// ---------------------------------------------------------------------------

const activeStatusFor = (active: ActiveRun, sessions: any[]): ActiveStatus => {
  const session = sessions.find((entry) => entry.id === active.sessionId);
  if (!session) {
    // The snapshot may not include a just-created session yet.
    return Date.now() - active.startedAt >= ACTIVE_GRACE_MS ? 'free' : 'running';
  }
  if (session.archivedAt) return 'free';
  return isOccupied(session.activity as SessionActivity) ? 'running' : 'free';
};

const readSessions = async (projectId: string): Promise<GuestSessionsSnapshot | null> => {
  try {
    return await host.listSessions(projectId);
  } catch {
    return null;
  }
};

const localTick = async (projectId: string, pushed?: GuestSessionsSnapshot | null): Promise<boolean> => {
  const info = localState.projects[projectId];
  if (!info) return false;
  let mutated = false;

  for (let step = 0; step < MAX_STEPS_PER_TICK; step += 1) {
    const current = getQueue(localState, projectId);
    if (!current.active && (!current.enabled || current.tasks.length === 0)) break;

    // The first pass can reuse the snapshot the host just pushed; a later pass
    // needs a fresh one to see a session we created a moment ago.
    const snapshot = step === 0 && pushed ? pushed : await readSessions(projectId);
    // An unready snapshot must never pass for "nothing is running".
    if (snapshot?.state !== 'ready') break;
    const sessions = (snapshot.sessions ?? []).filter((session) => session.archivedAt === null);

    const decision = planTick(current, {
      projectBusy: sessions.some((session) => isOccupied(session.activity as SessionActivity)),
      activeStatus: current.active ? activeStatusFor(current.active, sessions) : 'free',
    });

    if (decision.kind === 'wait' || decision.kind === 'idle') break;
    if (decision.kind === 'finish') {
      finishRun(localState, projectId);
      mutated = true;
      continue;
    }

    const task = current.tasks.find((entry) => entry.id === decision.taskId);
    if (!task) break;
    try {
      const result = await host.startSession({
        providerId: PROVIDER_ID,
        id: task.id,
        title: deriveTitle(task.text, t('task.untitled')),
        url: '',
        text: task.text,
        projectId,
        navigation: 'preserve',
      });
      if (result.sessionId && result.sent === 'sent') {
        startTask(localState, projectId, task.id, result.sessionId);
      } else if (result.sessionId) {
        markFailed(localState, projectId, task.id, result.sent === 'no-model' ? t('reason.noModel') : t('reason.sendFailed', { sent: result.sent }));
      } else {
        markFailed(localState, projectId, task.id, t('reason.createFailed'));
      }
    } catch (error) {
      markFailed(localState, projectId, task.id, error instanceof Error ? error.message : String(error));
    }
    mutated = true;
    break;
  }
  return mutated;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const localCommand = (projectId: string, command: Record<string, unknown>): void => {
  switch (command.op) {
    case 'enqueue': {
      const text = String(command.text ?? '').trim();
      if (text) ensureQueue(localState, projectId).tasks.push(makeTask(text));
      break;
    }
    case 'edit':
      editTask(localState, projectId, String(command.taskId), String(command.text ?? ''));
      break;
    case 'remove':
      removeTask(localState, projectId, String(command.taskId));
      break;
    case 'move':
      moveTask(localState, projectId, String(command.taskId), command.direction as never);
      break;
    case 'retry':
      retryTask(localState, projectId, String(command.taskId));
      break;
    case 'clear':
      clearTasks(localState, projectId);
      break;
    case 'set-enabled':
      ensureQueue(localState, projectId).enabled = command.enabled === true;
      break;
    default:
      break;
  }
};

const pushCommand = async (command: Record<string, unknown>): Promise<void> => {
  if (!project || mode === 'unknown') return;
  beginPending();
  try {
    if (mode === 'backend') {
      // A command answers as soon as it applied its change, before the dispatch
      // it may have enabled: an event may already be ahead of that answer, so
      // the cursor only ever moves forward.
      const result = await backend.command(project.id, command);
      if (result.queue && result.seq >= seq) {
        queue = result.queue;
        seq = result.seq;
      }
    } else {
      localCommand(project.id, command);
      await saveQueue(project.id);
      if (await localTick(project.id)) await saveQueue(project.id);
    }
    await publish();
  } finally {
    endPending();
  }
};

/**
 * "Run now": create a session with the draft text immediately instead of
 * queueing it. Backend mode asks the service to do it; foreground mode uses the
 * host session API directly.
 */
const runNow = async (text: string): Promise<boolean> => {
  const trimmed = text.trim();
  if (!trimmed || !project || mode === 'unknown') return false;
  beginPending();
  try {
    if (mode === 'backend') {
      await backend.command(project.id, { op: 'run-now', text: trimmed });
    } else {
      const result = await host.startSession({
        providerId: PROVIDER_ID,
        id: `run_${Date.now()}`,
        title: deriveTitle(trimmed, t('task.untitled')),
        url: '',
        text: trimmed,
        projectId: project.id,
        navigation: 'preserve',
      });
      if (!result.sessionId || result.sent !== 'sent') {
        await host.toast({
          kind: 'error',
          message: result.sent === 'no-model' ? t('reason.noModel') : t('reason.sendFailed', { sent: result.sent }),
        });
        return false;
      }
    }
  } catch (error) {
    await host.toast({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    endPending();
  }
  await host.toast({ kind: 'success', message: t('toast.ranNow') });
  // "Run now" never touches the queue, so no event follows it: re-read state.
  await refresh();
  return true;
};

const registerProjectEverywhere = async (info: ProjectInfo): Promise<void> => {
  if (mode === 'unknown') return;
  if (mode === 'backend') {
    // The service decides whether this is news: a project it already knows is
    // answered without an event, a state write or a tick.
    await backend.command(info.id, { op: 'register', directory: info.directory, name: info.name });
    return;
  }
  if (!registerProject(localState, info)) return;
  await saveIndex();
  await saveQueue(info.id);
};

// ---------------------------------------------------------------------------
// Mode detection, change watching, local driver wiring
// ---------------------------------------------------------------------------

const detectMode = async (): Promise<void> => {
  try {
    await backend.health();
    mode = 'backend';
  } catch (error) {
    if (isNoService(error)) {
      mode = 'local';
      await loadLocal();
    } else {
      mode = 'unknown';
    }
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

let watchToken = 0;
let watchTimer: number | null = null;
let localSafetyTimer: number | null = null;
let sessionUnsubscribe: (() => void) | null = null;
/** Cursor into the service's event log: the last sequence number applied. */
let seq = 0;

/** Show whatever the model currently holds: badge plus panel. */
const publish = async (): Promise<void> => {
  await host.setBadge(countTasks(queue).pending);
  render();
};

const refresh = async (): Promise<void> => {
  if (!project) {
    render();
    return;
  }
  try {
    if (mode === 'backend') {
      const loaded = await backend.load(project.id);
      queue = loaded.queue;
      seq = loaded.seq;
    } else {
      queue = getQueue(localState, project.id);
    }
  } catch (error) {
    if (isNoService(error)) {
      await applyMode();
      queue = mode === 'local' ? getQueue(localState, project.id) : queue;
    }
  }
  await publish();
};

/**
 * Apply one read of the stream. The stream covers every project but the panel
 * shows one, so entries for the others only advance the cursor — each entry
 * carries its own project's queue as it stands after it. `reset` means the
 * cursor was from an older service run: re-read the open project instead.
 * `superseded` means a newer reader took this one's place; read again.
 */
const applyEvents = async (batch: EventsBatch): Promise<void> => {
  if (batch.reset) {
    await refresh();
    return;
  }
  for (const event of batch.events) {
    if (project && event.projectId === project.id) queue = event.queue;
  }
  seq = batch.seq;
  if (batch.events.length > 0) await publish();
};

/** One reader per panel: a second loop would only park a second connection. */
let watching = false;

const stopWatch = (): void => {
  watchToken += 1;
  watching = false;
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
  }
};

const stopLocalDriver = (): void => {
  sessionUnsubscribe?.();
  sessionUnsubscribe = null;
  if (localSafetyTimer !== null) {
    window.clearInterval(localSafetyTimer);
    localSafetyTimer = null;
  }
};

/**
 * Follow the service's event stream. Each read returns the events after the
 * cursor, or holds until one arrives; the hold also ends on its own deadline,
 * which is the ordinary case for an idle queue. The panel is therefore pushed to
 * at the moment something happens and never asks for state on a timer.
 *
 * The stream belongs to the service, not to a project, so it keeps running while
 * the user moves between projects: one reader, one connection, however many
 * projects are involved. It ends on its own when no one is looking any more — a
 * hidden window, a panel that unmounted — and `syncDrivers` starts it again when
 * one is.
 */
const streamBackend = async (token: number): Promise<void> => {
  try {
    while (token === watchToken && panelMounted && !document.hidden && mode === 'backend') {
      const startedAt = Date.now();
      let batch: EventsBatch;
      try {
        batch = await backend.events(seq);
      } catch (error) {
        if (token !== watchToken) return;
        if (isNoService(error)) {
          await applyMode();
          return;
        }
        if (error instanceof EventsUnsupportedError) {
          startSlowRetry();
          return;
        }
        // An expired hold means "nothing happened in a while": read again at
        // once. A request that failed outright would spin, so give it room.
        if (Date.now() - startedAt < WATCH_RETRY_MS) await delay(WATCH_RETRY_MS);
        continue;
      }
      if (token !== watchToken) return;
      await applyEvents(batch);
    }
  } finally {
    // A loop that ended on its own condition must let the next one start.
    if (token === watchToken) watching = false;
  }
};

/**
 * The slow path, used when the stream is not available: a service too old to
 * have one, or a mode still being decided (the service may just be starting).
 * Both end as soon as the event stream can take over.
 */
const startSlowRetry = (): void => {
  if (watchTimer !== null) return;
  watchTimer = window.setInterval(() => {
    void (async () => {
      if (!panelMounted || document.hidden) return;
      if (mode === 'unknown') await applyMode();
      await refresh();
    })();
  }, FALLBACK_POLL_MS);
};

const startWatching = (): void => {
  if (watching) return;
  if (mode !== 'backend' || !panelMounted || document.hidden) return;
  watching = true;
  void streamBackend(watchToken);
};

const startLocalDriver = async (): Promise<void> => {
  stopLocalDriver();
  if (!project || mode !== 'local') return;
  const projectId = project.id;
  const drive = async (pushed?: GuestSessionsSnapshot | null): Promise<void> => {
    if (mode !== 'local' || project?.id !== projectId) return;
    if (await localTick(projectId, pushed)) await saveQueue(projectId);
    await refresh();
  };
  try {
    sessionUnsubscribe = await host.onSessions(projectId, (snapshot) => void drive(snapshot));
  } catch {
    sessionUnsubscribe = null;
  }
  // The host pushes session changes, but a missed one would stall the queue, so
  // a slow tick is the safety net. This mode is the only driver there is, so it
  // keeps running even while the window is hidden.
  localSafetyTimer = window.setInterval(() => void drive(), LOCAL_SAFETY_MS);
};

/** Point the watcher and the local driver at whichever mode is current. */
const syncDrivers = async (): Promise<void> => {
  if (mode === 'local') {
    stopWatch();
    await startLocalDriver();
    return;
  }
  stopLocalDriver();
  startWatching();
  // "Connecting" means the service may still be coming up: keep asking, slowly.
  if (mode === 'unknown') startSlowRetry();
};

const applyMode = async (): Promise<void> => {
  await detectMode();
  await syncDrivers();
};

// Nobody is reading while the window is hidden: the backend watch is stopped and
// restarted on return. Foreground mode keeps its own driver running, because it
// is the only thing dispatching there.
document.addEventListener('visibilitychange', () => {
  if (!panelMounted) return;
  if (document.hidden) {
    stopWatch();
    return;
  }
  void (async () => {
    await refresh();
    if (mode !== 'local') await syncDrivers();
  })();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const statusLabel = (status: QueueTask['status']): string => t(`status.${status}`);

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// The rail has little vertical room: let a multiline field grow with its text
// but cap the height so a long task scrolls internally instead of pushing the
// list off-screen.
const FIELD_MAX_HEIGHT = 200;
/** One line of the SDK textarea: 0.875rem at line-height 1.45, rounded up. */
const FIELD_LINE_HEIGHT = 21;
/** The SDK textarea's vertical padding (8px top and bottom). */
const FIELD_PADDING_Y = 16;
/** Fallback for a field that declares no rows. */
const FIELD_DEFAULT_ROWS = 3;

const mountGrowingField = (root: Element, initial: TextFieldProps): TextFieldHandle => {
  const field = mountTextField(root, initial);
  const input = root.lastElementChild?.querySelector('textarea.oc-sdk-input') ?? null;
  if (!(input instanceof HTMLTextAreaElement)) return field;

  // A floor for `height: auto` before the element has been laid out, and the
  // size an empty field keeps: the panel can mount while the rail is still
  // hidden, when `scrollHeight` reads 0 and the field would otherwise collapse.
  const minHeight = (initial.rows ?? FIELD_DEFAULT_ROWS) * FIELD_LINE_HEIGHT + FIELD_PADDING_Y;
  input.style.resize = 'none';
  input.style.minHeight = `${minHeight}px`;

  const resize = (): void => {
    input.style.height = 'auto';
    const content = input.scrollHeight;
    const height = Math.min(Math.max(content, minHeight), FIELD_MAX_HEIGHT);
    input.style.height = `${height}px`;
    input.style.overflowY = content > FIELD_MAX_HEIGHT ? 'auto' : 'hidden';
  };
  input.addEventListener('input', resize);
  // Measure after the first layout so a field mounted while hidden picks up the
  // right height as soon as it is shown, and keep tracking width changes because
  // a narrower rail re-wraps the text and changes the height it needs.
  requestAnimationFrame(resize);
  let lastWidth = -1;
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (input.clientWidth === lastWidth) return;
          lastWidth = input.clientWidth;
          resize();
        });
  observer?.observe(input);
  resize();

  return {
    update: (next) => {
      field.update(next);
      resize();
    },
    dispose: () => {
      observer?.disconnect();
      input.removeEventListener('input', resize);
      field.dispose();
    },
  };
};

const disposables: Array<{ dispose: () => void }> = [];
const clearDisposables = (): void => {
  while (disposables.length > 0) disposables.pop()?.dispose();
};

const beginEdit = (task: QueueTask): void => {
  editingId = task.id;
  draftText = task.text;
  renderKey = '';
  render();
};

const endEdit = (): void => {
  editingId = null;
  draftText = '';
  renderKey = '';
  render();
};

const render = (): void => {
  if (!panelMounted) return;
  // While a card is open for editing, ignore queue updates so the textarea
  // keeps focus and the caret.
  const key = JSON.stringify({
    localeTag,
    mode,
    loading,
    project: project?.id ?? null,
    editingId,
    queue: editingId !== null ? 'editing' : queue,
  });
  if (key === renderKey) return;
  renderKey = key;

  clearDisposables();
  root.textContent = '';

  // The first read can take a moment: show that something is happening instead
  // of an empty rail.
  if (loading) {
    const loadingHost = root.appendChild(el('div', 'qx-loading'));
    disposables.push(mountSpinner(loadingHost, { label: t('loading') }));
    return;
  }

  const counts = countTasks(queue);

  // Controls live in a scrollable column so a tight panel shortens it instead of
  // pushing the footer off the bottom edge; the list below is what flexes.
  const controls = root.appendChild(el('div', 'qx-controls'));
  const header = controls.appendChild(el('div', 'qx-header'));
  const titleRow = header.appendChild(el('div', 'qx-title-row'));
  titleRow.appendChild(el('span', 'qx-title', t('title')));
  titleRow.appendChild(el('span', 'qx-project', project?.name ?? project?.directory ?? t('noProject')));
  disposables.push(mountBadge(titleRow, {
    label: modeLabel(mode),
    tone: mode === 'backend' ? 'info' : mode === 'local' ? 'warning' : 'neutral',
  }));

  if (project) {
    const countsRow = titleRow.appendChild(el('div', 'qx-counts'));
    disposables.push(mountBadge(countsRow, { label: t('count.pending', { n: counts.pending }), tone: 'neutral' }));
    disposables.push(mountBadge(countsRow, { label: t('count.completed', { n: counts.completed }), tone: 'success' }));
  }

  if (mode === 'local') {
    disposables.push(mountBanner(controls, {
      tone: 'warning',
      title: t('banner.local.title'),
      body: t('banner.local.body'),
    }));
  } else if (mode === 'unknown') {
    disposables.push(mountBanner(controls, { tone: 'error', title: t('banner.error.title'), body: t('banner.error.body') }));
  }

  if (!project) {
    disposables.push(mountEmpty(root, { title: t('empty.noProject.title'), body: t('empty.noProject.body') }));
    return;
  }

  const switchHost = controls.appendChild(el('div', 'qx-switch'));
  disposables.push(mountSwitch(switchHost, {
    label: t('switch.label'),
    description: queue.enabled ? t('switch.on') : t('switch.off'),
    checked: queue.enabled,
    onChange: (next) => void pushCommand({ op: 'set-enabled', enabled: next }),
  }));

  const composer = controls.appendChild(el('div', 'qx-composer'));
  let draft = '';
  const field = mountGrowingField(composer, {
    label: t('composer.label'),
    value: draft,
    placeholder: t('composer.placeholder'),
    multiline: true,
    rows: 3,
    onChange: (value) => {
      draft = value;
      field.update({ value });
    },
  });
  disposables.push(field);
  const composerActions = composer.appendChild(el('div', 'qx-composer-actions'));
  const runButton = mountButton(composerActions, {
    label: t('composer.runNow'),
    variant: 'outline',
    onClick: () =>
      withLoading(runButton, async () => {
        if (!draft.trim()) return;
        if (await runNow(draft)) {
          draft = '';
          field.update({ value: '' });
        }
      }),
  });
  disposables.push(runButton);
  const addButton = mountButton(composerActions, {
    label: t('composer.add'),
    onClick: () =>
      withLoading(addButton, async () => {
        if (!draft.trim()) return;
        await pushCommand({ op: 'enqueue', text: draft });
        draft = '';
        field.update({ value: '' });
      }),
  });
  disposables.push(addButton);

  disposables.push(mountSeparator(controls, {}));

  const listHost = root.appendChild(el('div', 'qx-list'));
  if (queue.tasks.length === 0) {
    disposables.push(mountEmpty(listHost, {
      title: t('list.empty.title'),
      body: queue.completed > 0 ? t('list.empty.bodyCompleted', { n: queue.completed }) : t('list.empty.body'),
    }));
  } else {
    queue.tasks.forEach((task, index) => listHost.appendChild(renderTask(task, index + 1)));
  }

  if (!queue.enabled) {
    const footer = root.appendChild(el('div', 'qx-footer'));
    const clearButton = mountButton(footer, {
      label: t('footer.clear'),
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        if (queue.tasks.length === 0) return;
        endEdit();
        withLoading(clearButton, () => pushCommand({ op: 'clear' }));
      },
    });
    disposables.push(clearButton);
  }
};

const renderTask = (task: QueueTask, position: number): HTMLElement => {
  if (editingId === task.id) return renderEditor(task);
  const row = el('div', `qx-row qx-row-${task.status}${queue.enabled ? '' : ' qx-row-editable'}`);
  row.appendChild(el('span', `qx-dot qx-dot-${task.status}`));
  row.appendChild(el('span', 'qx-pos', String(position)));

  const body = row.appendChild(el('div', 'qx-row-body'));
  body.appendChild(el('div', 'qx-row-text', deriveTitle(task.text, t('task.untitled'))));
  const subtitle = [
    statusLabel(task.status),
    task.error ?? '',
    queue.enabled ? '' : t('row.clickToEdit'),
  ].filter(Boolean).join(' · ');
  body.appendChild(el('div', 'qx-row-sub', subtitle));

  const actions = row.appendChild(el('div', 'qx-row-actions'));
  // Buttons must not open the editor.
  actions.addEventListener('click', (event) => event.stopPropagation());
  if (task.status === 'pending') {
    const topButton = mountButton(actions, {
      label: t('row.top'),
      size: 'xs',
      variant: 'ghost',
      onClick: () => withLoading(topButton, () => pushCommand({ op: 'move', taskId: task.id, direction: 'top' })),
    });
    disposables.push(topButton);
  }
  if (task.status === 'failed') {
    const retryButton = mountButton(actions, {
      label: t('row.retry'),
      size: 'xs',
      variant: 'outline',
      onClick: () => withLoading(retryButton, () => pushCommand({ op: 'retry', taskId: task.id })),
    });
    disposables.push(retryButton);
  }
  const removeButton = mountButton(actions, {
    label: t('row.delete'),
    size: 'xs',
    variant: 'ghost',
    onClick: () => withLoading(removeButton, () => pushCommand({ op: 'remove', taskId: task.id })),
  });
  disposables.push(removeButton);

  row.addEventListener('click', () => {
    if (queue.enabled) {
      void host.toast({ kind: 'info', message: t('toast.locked') });
      return;
    }
    beginEdit(task);
  });
  return row;
};

const renderEditor = (task: QueueTask): HTMLElement => {
  const card = el('div', 'qx-edit');
  const field = mountGrowingField(card, {
    value: draftText,
    multiline: true,
    rows: 4,
    onChange: (value) => {
      draftText = value;
      field.update({ value });
    },
  });
  disposables.push(field);

  const actions = card.appendChild(el('div', 'qx-edit-actions'));
  disposables.push(mountButton(actions, {
    label: t('edit.save'),
    size: 'sm',
    disabled: !draftText.trim(),
    onClick: () => {
      const text = draftText.trim();
      if (!text) return;
      const id = task.id;
      endEdit();
      void pushCommand({ op: 'edit', taskId: id, text });
    },
  }));
  disposables.push(mountButton(actions, {
    label: t('edit.cancel'),
    size: 'sm',
    variant: 'ghost',
    onClick: () => endEdit(),
  }));
  return card;
};

// ---------------------------------------------------------------------------
// Background frame: enqueue from a message action or the `/queue` command
// ---------------------------------------------------------------------------

type Target = { projectId: string; directory: string; name: string };

const resolveTarget = async (dir: string | null): Promise<Target | null> => {
  if (!dir) return null;
  try {
    const snapshot = await host.listProjects();
    const match = snapshot.projects.find((entry) => entry.directory === dir);
    if (match) return { projectId: match.id, directory: match.directory, name: match.name };
  } catch {
    // fall through to a synthetic id
  }
  return { projectId: `dir:${dir}`, directory: dir, name: dir };
};

const enqueueAnywhere = async (target: Target, text: string): Promise<void> => {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    await backend.health();
    await backend.command(target.projectId, { op: 'register', directory: target.directory, name: target.name });
    await backend.command(target.projectId, { op: 'enqueue', text: trimmed });
    return;
  } catch (error) {
    if (!isNoService(error)) throw error;
  }
  await loadLocal();
  localState.projects[target.projectId] = { id: target.projectId, directory: target.directory, name: target.name };
  ensureQueue(localState, target.projectId).tasks.push(makeTask(trimmed));
  await saveIndex();
  await saveQueue(target.projectId);
};

const mountBackground = (): void => {
  if (backgroundMounted) return;
  backgroundMounted = true;

  host.onAction(async (item) => {
    const target = await resolveTarget(item.directory ?? null);
    if (!target) {
      await host.toast({ kind: 'error', message: t('toast.noDirectory') });
      return;
    }
    const text = item.kind === 'message' ? item.text : '';
    await enqueueAnywhere(target, text);
    await host.toast({ kind: 'success', message: t('toast.enqueued') });
  });

  host.onResolve(async ({ command, args }) => {
    if (command !== 'queue') return null;
    const text = args.trim();
    if (!text) return null;
    const target = await resolveTarget(directoryRef);
    if (!target) return null;
    await enqueueAnywhere(target, text);
    return { providerId: PROVIDER_ID, id: `queue-${Date.now()}`, title: deriveTitle(text, t('task.untitled')), url: '' };
  });
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const preparePanel = async (): Promise<void> => {
  try {
    if (directory) {
      const target = await resolveTarget(directory);
      project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
    }
    await detectMode();
    if (project) await registerProjectEverywhere(project);
    await syncDrivers();
  } finally {
    // Whatever the outcome, stop showing the loading state.
    loading = false;
    render();
  }
  await refresh();
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  localeTag = ctx.locale;
  t = createTranslator(ctx.locale);
  document.body.dataset.surface = ctx.surface;
  document.documentElement.lang = ctx.locale;
  directoryRef = ctx.directory;

  if (ctx.surface === 'background') {
    mountBackground();
    return;
  }
  if (panelMounted) return;
  panelMounted = true;
  mountBusyBar();
  directory = ctx.directory;
  // Paint the loading state before the first read answers.
  render();
  void preparePanel();
});

host.onDirectory((next) => {
  directoryRef = next;
  // Background frames only need the ref for `/queue`; the panel logic below
  // must not run there.
  if (!panelMounted) return;
  if (next === directory) return;
  directory = next;
  void (async () => {
    editingId = null;
    draftText = '';
    const target = next ? await resolveTarget(next) : null;
    project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
    if (project) await registerProjectEverywhere(project);
    // The backend stream belongs to the service and carries every project, so
    // switching projects keeps the reader and the cursor: only the new project's
    // state is read. Foreground mode drives one project, so it restarts.
    if (mode === 'local') stopWatch();
    await refresh();
    await syncDrivers();
  })();
});
