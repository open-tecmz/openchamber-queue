/**
 * OpenChamber Queue — rail panel and background frame.
 *
 * The queue lives in the extension's local service (`contributes.service`).
 * The service owns the state and keeps dispatching with no client open; the
 * panel is only a view onto that service. When the service is not up yet the
 * panel shows a connecting state and retries until it answers, rather than
 * keeping a second, panel-owned copy of the queue.
 *
 * The panel does not poll: it follows the service's event stream (`GET
 * /events`), which answers the moment the queue moves and ends the hold when it
 * does not, and it re-reads from its cursor whenever a hold ends. The service
 * also exposes that stream as real SSE (`GET /events/stream`).
 *
 * Panel copy follows the OpenChamber language (`ctx.locale`); see `src/i18n.ts`.
 */

import {
  HostRequestError,
  connectHost,
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
  countTasks,
  deriveTitle,
  emptyQueue,
  type ProjectInfo,
  type ProjectQueue,
  type QueueEvent,
  type QueueSnapshot,
  type QueueTask,
} from '../src/core.ts';
import { createTranslator, type Translator } from '../src/i18n.ts';

const PROVIDER_ID = 'queue';
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
/** How often a panel that has no service yet re-checks for one. */
const FALLBACK_POLL_MS = 5000;

type Mode = 'backend' | 'unknown';

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
/** The composer text for the open project, kept across renders and mirrored to the service. */
let composerDraft = '';
/** The project `composerDraft` belongs to, so a refresh only adopts the service draft. */
let composerProject: string | null = null;
/** True when `composerDraft` has changed since it was last saved. */
let draftDirty = false;
/** The composer field has focus: hold queue-driven re-renders so typing is never disturbed. */
let composerFocused = false;
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
    return {
      project: data.project ?? null,
      queue: data.queue,
      draft: typeof data.draft === 'string' ? data.draft : '',
      seq: typeof data.seq === 'number' ? data.seq : 0,
    };
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
// Draft persistence
// ---------------------------------------------------------------------------

/**
 * How long typing must pause before the draft is written. Kept short so a hard
 * exit loses at most a moment of typing; a flush also runs when the window is
 * hidden, so the common "switch away then quit" never waits on it at all.
 */
const DRAFT_SAVE_MS = 400;

let draftSaveTimer: number | null = null;

/**
 * Write the draft for `projectId` to the service, which owns it on disk. Best
 * effort: a failure is retried by the next keystroke, and nothing depends on it.
 */
const persistDraft = async (projectId: string, text: string): Promise<void> => {
  if (mode !== 'backend') return;
  try {
    await backend.command(projectId, { op: 'set-draft', text });
    if (composerProject === projectId && composerDraft === text) draftDirty = false;
  } catch {
    // Leave `draftDirty` set so a later keystroke or flush tries again.
  }
};

/** Arm (or re-arm) the debounced write of the current draft. */
const scheduleDraftSave = (): void => {
  if (!project || mode !== 'backend' || !draftDirty) return;
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  const projectId = project.id;
  const text = composerDraft;
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = null;
    void persistDraft(projectId, text);
  }, DRAFT_SAVE_MS);
};

/** Write the current draft now — at a switch, hide or exit — instead of waiting. */
const flushDraftSave = (): void => {
  if (draftSaveTimer !== null) {
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  if (composerProject && draftDirty) void persistDraft(composerProject, composerDraft);
};

/** Forget the current draft (a project switch, or the panel going away). */
const resetDraft = (): void => {
  if (draftSaveTimer !== null) {
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  composerDraft = '';
  composerProject = null;
  draftDirty = false;
  composerFocused = false;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const pushCommand = async (command: Record<string, unknown>): Promise<void> => {
  if (!project || mode === 'unknown') return;
  beginPending();
  try {
    // A command answers as soon as it applied its change, before the dispatch it
    // may have enabled: an event may already be ahead of that answer, so the
    // cursor only ever moves forward.
    const result = await backend.command(project.id, command);
    if (result.queue && result.seq >= seq) {
      queue = result.queue;
      seq = result.seq;
    }
    await publish();
  } finally {
    endPending();
  }
};

/**
 * "Run now": create a session with the draft text immediately instead of
 * queueing it. The service owns dispatch, so the command is all this sends.
 */
const runNow = async (text: string): Promise<boolean> => {
  const trimmed = text.trim();
  if (!trimmed || !project || mode === 'unknown') return false;
  beginPending();
  try {
    await backend.command(project.id, { op: 'run-now', text: trimmed });
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

const registerProject = async (info: ProjectInfo): Promise<void> => {
  if (mode === 'unknown') return;
  // The service decides whether this is news: a project it already knows is
  // answered without an event, a state write or a tick.
  await backend.command(info.id, { op: 'register', directory: info.directory, name: info.name });
};

// ---------------------------------------------------------------------------
// Mode detection, change watching
// ---------------------------------------------------------------------------

/**
 * The service is the only queue there is. It starts on demand: the first request
 * wakes it, so a failure here usually just means it is not up yet. Stay in
 * `unknown` and let the slow retry ask again, rather than keeping a second,
 * panel-owned queue that the service would not see once it is up — that is what
 * made tasks added while the service was starting disappear on the next reload.
 */
const detectMode = async (): Promise<void> => {
  try {
    await backend.health();
    mode = 'backend';
  } catch {
    mode = 'unknown';
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

let watchToken = 0;
let watchTimer: number | null = null;
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
    const loaded = await backend.load(project.id);
    queue = loaded.queue;
    seq = loaded.seq;
    if (composerProject === project.id) {
      // This project's draft is already loaded. Keep what the user has typed
      // even if it is still unsaved (the service may only just have come up),
      // and push it so the two agree.
      if (draftDirty) scheduleDraftSave();
    } else {
      // First read for this project: take the draft the service has on disk,
      // which is what survives a reload, an OpenChamber restart or a hard exit.
      composerDraft = loaded.draft;
      composerProject = project.id;
      draftDirty = false;
    }
  } catch (error) {
    // The service may have gone away; switch to the connecting state and let
    // the slow retry bring it back. Keep the last known queue on screen.
    if (isNoService(error)) await applyMode();
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

/** Stop the connecting retry (it and the watch share the timer slot). */
const stopSlowRetry = (): void => {
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
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
      // The mode may have just become `backend`; the watch owns the timer now.
      else stopSlowRetry();
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

/** Start the event watch for a reachable service, or retry while it starts. */
const syncDrivers = async (): Promise<void> => {
  if (mode === 'backend') {
    stopSlowRetry();
    startWatching();
    return;
  }
  // "Connecting" means the service may still be coming up: keep asking, slowly.
  startSlowRetry();
};

/**
 * The service owns the queue, so any project the panel shows must be registered
 * with it once it is reachable. `detectMode` may have answered `unknown` on the
 * first try (the service starts on demand), so registering on every upgrade to
 * `backend` is what makes the project known after a cold start.
 */
const applyMode = async (): Promise<void> => {
  await detectMode();
  if (mode === 'backend' && project) await registerProject(project);
  await syncDrivers();
};

// Nobody is reading while the window is hidden: the watch is stopped and
// restarted on return. The draft is written before the window goes away, so a
// quit or a crash right after switching away still keeps what was typed.
document.addEventListener('visibilitychange', () => {
  if (!panelMounted) return;
  if (document.hidden) {
    stopWatch();
    // The user is no longer typing: release the render hold so the panel catches
    // up on return, and write the draft before the window goes away.
    composerFocused = false;
    flushDraftSave();
    return;
  }
  void (async () => {
    await refresh();
    await syncDrivers();
  })();
});

// The last chance on a real exit. The request may not outlive the page, but the
// debounce and the visibility flush have almost always saved it by now.
window.addEventListener('pagehide', () => {
  if (panelMounted) flushDraftSave();
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

const mountGrowingField = (
  root: Element,
  initial: TextFieldProps,
  options: { field?: string; onFocus?: () => void; onBlur?: () => void } = {},
): TextFieldHandle => {
  const field = mountTextField(root, initial);
  const input = root.lastElementChild?.querySelector('textarea.oc-sdk-input') ?? null;
  if (!(input instanceof HTMLTextAreaElement)) return field;

  if (options.field) input.dataset.qxField = options.field;
  if (options.onFocus) input.addEventListener('focus', options.onFocus);
  if (options.onBlur) input.addEventListener('blur', options.onBlur);

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

/**
 * The state a render depends on. A field that must not be disturbed while it is
 * being used — the open editor, or the composer while it has focus — maps to a
 * fixed token so a background change of that state does not force a rebuild.
 */
const computeRenderKey = (): string =>
  JSON.stringify({
    localeTag,
    mode,
    loading,
    project: project?.id ?? null,
    editingId,
    queue: editingId !== null ? 'editing' : composerFocused ? 'composing' : queue,
  });

const render = (): void => {
  if (!panelMounted) return;
  const key = computeRenderKey();
  if (key === renderKey) return;
  renderKey = key;

  // Keep the caret with its field across the rebuild: the composer remains
  // editable while the panel repaints around it (for example when a task is
  // added elsewhere), and losing focus mid-sentence would be disruptive.
  const active = document.activeElement;
  const restoreFocus =
    active instanceof HTMLTextAreaElement && active.dataset.qxField
      ? { field: active.dataset.qxField, start: active.selectionStart, end: active.selectionEnd }
      : null;

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
  // pushing the list off the bottom edge; the list below is what flexes.
  const controls = root.appendChild(el('div', 'qx-controls'));
  const header = controls.appendChild(el('div', 'qx-header'));
  const titleRow = header.appendChild(el('div', 'qx-title-row'));
  titleRow.appendChild(el('span', 'qx-title', t('title')));
  titleRow.appendChild(el('span', 'qx-project', project?.name ?? project?.directory ?? t('noProject')));
  disposables.push(mountBadge(titleRow, {
    label: modeLabel(mode),
    tone: mode === 'backend' ? 'info' : 'warning',
  }));

  if (project) {
    const countsRow = titleRow.appendChild(el('div', 'qx-counts'));
    disposables.push(mountBadge(countsRow, { label: t('count.pending', { n: counts.pending }), tone: 'neutral' }));
    disposables.push(mountBadge(countsRow, { label: t('count.completed', { n: counts.completed }), tone: 'success' }));
  }

  if (mode === 'unknown') {
    disposables.push(mountBanner(controls, { tone: 'warning', title: t('banner.error.title'), body: t('banner.error.body') }));
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
  const field = mountGrowingField(
    composer,
    {
      label: t('composer.label'),
      value: composerDraft,
      placeholder: t('composer.placeholder'),
      multiline: true,
      rows: 3,
      onChange: (value) => {
        composerDraft = value;
        composerProject = project?.id ?? null;
        draftDirty = true;
        field.update({ value });
        scheduleDraftSave();
      },
    },
    {
      field: 'composer',
      onFocus: () => {
        composerFocused = true;
        // Seal the render key so the next background queue event is a no-op for
        // this field: rebuilding it would drop the caret and break an
        // in-progress IME composition.
        renderKey = computeRenderKey();
      },
      onBlur: () => {
        composerFocused = false;
        // Deferred so a click on Add/Run — which blurs the box first — still
        // reaches its button before the repaint replaces it.
        window.setTimeout(() => {
          if (!composerFocused) render();
        }, 0);
      },
    },
  );
  disposables.push(field);
  const composerActions = composer.appendChild(el('div', 'qx-composer-actions'));
  // Empty the box and persist the empty draft before a command repaints the
  // panel, so the repaint never resurrects the text it just consumed.
  const clearComposer = (): void => {
    composerDraft = '';
    composerProject = project?.id ?? null;
    draftDirty = true;
    field.update({ value: '' });
    flushDraftSave();
  };
  const restoreComposer = (text: string): void => {
    composerDraft = text;
    composerProject = project?.id ?? null;
    draftDirty = true;
    field.update({ value: text });
    scheduleDraftSave();
  };
  const runButton = mountButton(composerActions, {
    label: t('composer.runNow'),
    variant: 'outline',
    size: 'sm',
    onClick: () =>
      withLoading(runButton, async () => {
        const text = composerDraft.trim();
        if (!text) return;
        clearComposer();
        if (!(await runNow(text))) restoreComposer(text);
      }),
  });
  disposables.push(runButton);
  const addButton = mountButton(composerActions, {
    label: t('composer.add'),
    size: 'sm',
    onClick: () =>
      withLoading(addButton, async () => {
        const text = composerDraft.trim();
        if (!text) return;
        clearComposer();
        try {
          await pushCommand({ op: 'enqueue', text });
        } catch (error) {
          restoreComposer(text);
          throw error;
        }
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

  if (restoreFocus) {
    const input = root.querySelector<HTMLTextAreaElement>(`textarea[data-qx-field="${restoreFocus.field}"]`);
    if (input) {
      input.focus();
      try {
        input.setSelectionRange(restoreFocus.start, restoreFocus.end);
      } catch {
        // The field refused the range; the default caret is good enough.
      }
    }
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
  // Run this task now: create its session at once and drop it from the queue.
  const runTaskButton = mountButton(actions, {
    label: t('row.run'),
    size: 'xs',
    variant: 'outline',
    onClick: () => withLoading(runTaskButton, () => pushCommand({ op: 'run', taskId: task.id })),
  });
  disposables.push(runTaskButton);
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
  }, { field: 'editor' });
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

/** Queue a task from a message action or the `/queue` command; the service owns it. */
const enqueueAnywhere = async (target: Target, text: string): Promise<void> => {
  const trimmed = text.trim();
  if (!trimmed) return;
  await backend.health();
  await backend.command(target.projectId, { op: 'register', directory: target.directory, name: target.name });
  await backend.command(target.projectId, { op: 'enqueue', text: trimmed });
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
    try {
      await enqueueAnywhere(target, text);
    } catch {
      await host.toast({ kind: 'error', message: t('toast.noService') });
      return;
    }
    await host.toast({ kind: 'success', message: t('toast.enqueued') });
  });

  host.onResolve(async ({ command, args }) => {
    if (command !== 'queue') return null;
    const text = args.trim();
    if (!text) return null;
    const target = await resolveTarget(directoryRef);
    if (!target) return null;
    try {
      await enqueueAnywhere(target, text);
    } catch {
      await host.toast({ kind: 'error', message: t('toast.noService') });
      return null;
    }
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
    if (project) await registerProject(project);
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
  // Switching projects: write the draft for the project being left first, then
  // forget it so the new project's own draft can be read.
  flushDraftSave();
  resetDraft();
  directory = next;
  void (async () => {
    editingId = null;
    draftText = '';
    const target = next ? await resolveTarget(next) : null;
    project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
    if (project) await registerProject(project);
    // The stream belongs to the service and carries every project, so switching
    // projects keeps the reader and the cursor: only the new project's state is
    // read.
    await refresh();
    await syncDrivers();
  })();
});
