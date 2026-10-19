/**
 * OpenChamber Queue — local service.
 *
 * Runs as a child process of the OpenChamber host (`contributes.service`), so
 * it keeps working while no browser or desktop client is open. It owns the
 * queue state on disk and drives dispatch by talking to the local OpenChamber
 * control API, exactly the way the bundled `openchamber` CLI does.
 *
 * Protocol: the host passes OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN; every request needs `Authorization: Bearer <token>`.
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ACTIVE_GRACE_MS,
  DISPATCH_DELAY_MS,
  IMAGE_ID,
  QUESTION_DISPATCH_DELAY_MS,
  clearTasks,
  type QueueEvent,
  type QueueEventType,
  type QueueSnapshot,
  countTasks,
  editTask,
  emptyState,
  enqueue,
  finishRun,
  firstPending,
  getDraft,
  getQueue,
  isOccupied,
  markFailed,
  moveTask,
  planTick,
  referencedImageIds,
  registerProject,
  removeTask,
  repairState,
  sanitizeImages,
  retryTask,
  setDraft,
  setEnabled,
  setTaskEnabled,
  startTask,
  type ActiveRun,
  type ActiveStatus,
  type ProjectQueue,
  type QueueState,
  type QueueTask,
  type SessionActivity,
  type TaskImage,
  type TaskTarget,
  type TickObservation,
} from '../src/core.ts';
import { createLogger } from './log.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!PORT || !TOKEN) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const TICK_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
/**
 * A prompt carrying images rides one request whose body is the whole image as
 * base64, so it is given room the ordinary calls do not need.
 */
const DISPATCH_TIMEOUT_MS = 60000;
const SESSION_LIMIT = 30;
const MAX_STEPS_PER_TICK = 4;

/**
 * How long a read of `/events` may hold the connection open waiting for the
 * first event. A parked reader is not free: the host proxies one
 * request/response, and a sandboxed panel can only keep a handful of
 * connections to that origin open, so a long hold lets a few overlapping
 * readers (a remount, a directory change, a return to the window — the host
 * cannot cancel a request already in flight) starve every later command behind
 * them. The hold therefore stays short; a caller that has to wait longer simply
 * asks again from the cursor it already has, and an event still arrives the
 * moment it happens because the hold ends as soon as one does.
 */
const WAIT_MAX_MS = 2000;
const WAIT_MIN_MS = 500;

// ---------------------------------------------------------------------------
// Data directories and persistence
// ---------------------------------------------------------------------------

/**
 * Where the host keeps its own files: the run file and settings.json we read to
 * find the OpenChamber server. This must match the host's own resolution
 * (`OPENCHAMBER_DATA_DIR`, else `~/.config/openchamber`). HOME is inherited by
 * the service, but OPENCHAMBER_DATA_DIR is not, so a custom host dir is not
 * visible here — the default is the only case we can mirror.
 */
const HOST_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  || path.join(os.homedir(), '.config', 'openchamber');

/**
 * Our own queue state, kept beside the host data dir rather than inside it:
 * `~/.config/openchamber-queue/state.json`. Never inside a project.
 */
const STATE_DIR = process.env.OPENCHAMBER_QUEUE_DATA_DIR
  || path.join(os.homedir(), '.config', 'openchamber-queue');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/**
 * Diagnostic logs, kept beside the state: one active file that rolls over at
 * 10 MB plus timestamped backups. This is where to look after the fact — the
 * host's own capture of the child's output is short-lived and hard to find.
 * `OPENCHAMBER_QUEUE_LOG_DIR` moves it for a caller that wants somewhere else.
 */
const LOG_DIR = process.env.OPENCHAMBER_QUEUE_LOG_DIR
  || path.join(STATE_DIR, 'logs');
const logger = createLogger(LOG_DIR);

let state: QueueState = emptyState();
let writeChain: Promise<void> = Promise.resolve();

const readState = async (): Promise<QueueState> => {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as QueueState;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    // Brings an older file forward: tasks gain an empty image list and a draft
    // stored as a plain string becomes a composer without images.
    return repairState(parsed);
  } catch {
    return emptyState();
  }
};

/** Serialized, atomic write: a reader never sees a half-written state file. */
const persist = (): Promise<void> => {
  writeChain = writeChain.then(async () => {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(STATE_DIR, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fsp.rename(tmp, STATE_FILE);
    } catch (error) {
      logger.error('[queue] failed to persist state', error);
    }
  });
  return writeChain;
};

// ---------------------------------------------------------------------------
// Image store
// ---------------------------------------------------------------------------

/**
 * Attachments live beside the state, one file per image: `<data dir>/images/`
 * holds `<id>` (the bytes), `<id>.thumb` (a small preview data URL the panel
 * draws) and `<id>.part` while an upload is still arriving. `state.json` only
 * ever carries `TaskImage` metadata, so it stays small and fast to write.
 *
 * The panel has no filesystem access of its own and the host caps one request
 * body at 64 kB, so an image arrives in chunks: `begin` → `chunk`… → `end`.
 */
const IMAGE_DIR = path.join(STATE_DIR, 'images');

/** One image's worth of prompt attachment. Beyond this the panel refuses it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Base64 characters accepted in one `chunk`. Kept a multiple of four so every
 * chunk decodes on its own (base64 quanta never straddle a boundary) and well
 * under the host's 64 kB request-body cap once the JSON envelope is added.
 */
const MAX_IMAGE_CHUNK_CHARS = 48000;

/** A preview is small; anything longer than this is not one. */
const MAX_THUMB_CHARS = 200000;

/**
 * How long an image must have been unreferenced before the sweep removes it.
 *
 * Measured from the moment the state stopped naming it, never from the file's
 * own age: the panel clears a draft and enqueues the task in two separate
 * calls, so an image loses and regains its reference within a moment of a
 * normal "add to queue", and a picture attached to a task hours ago must not be
 * deleted in the gap. `OPENCHAMBER_QUEUE_IMAGE_ORPHAN_MS` shortens it for tests.
 */
const IMAGE_ORPHAN_MS = (() => {
  const override = Number(process.env.OPENCHAMBER_QUEUE_IMAGE_ORPHAN_MS);
  return Number.isFinite(override) && override > 0 ? override : 10 * 60 * 1000;
})();

/**
 * The settle windows before the next dispatch: 30 seconds ordinarily, and 5
 * minutes after a run that ended on a question. `OPENCHAMBER_QUEUE_DISPATCH_MS`
 * and `OPENCHAMBER_QUEUE_QUESTION_DISPATCH_MS` shorten them for tests, the same
 * way `OPENCHAMBER_QUEUE_IMAGE_ORPHAN_MS` shortens the image window.
 */
const envDelayMs = (name: string, fallback: number): number => {
  const override = Number(process.env[name]);
  return Number.isFinite(override) && override > 0 ? override : fallback;
};

const DISPATCH_MS = envDelayMs('OPENCHAMBER_QUEUE_DISPATCH_MS', DISPATCH_DELAY_MS);
const QUESTION_DISPATCH_MS = envDelayMs('OPENCHAMBER_QUEUE_QUESTION_DISPATCH_MS', QUESTION_DISPATCH_DELAY_MS);

/** How often a quiet service still looks for images to let go of. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Uploads in flight, so a chunk never arrives for a file we never started. */
const uploads = new Map<string, ImageSession>();

/**
 * When each unreferenced image was first seen without a reference. The sweep
 * runs often (every mutation, and on a timer); the clock is what decides, so an
 * image that gets its reference back is simply forgotten again.
 */
const orphans = new Map<string, number>();

const imagePath = (id: string, suffix = ''): string => path.join(IMAGE_DIR, `${id}${suffix}`);

/** Whether an id may name a file in the store. */
const isImageId = (value: unknown): value is string => typeof value === 'string' && IMAGE_ID.test(value);

const readJson = async (file: string): Promise<any> => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Let go of images nothing refers to any more — a task that was deleted or
 * already dispatched, a composer that was emptied, and the debris of an upload
 * nobody finished. An image is only removed once it has stayed unreferenced for
 * the whole orphan window, so the two calls a normal "add to queue" makes (clear
 * the composer, then enqueue) can never race a deletion.
 */
const sweepImages = async (): Promise<void> => {
  let entries: string[];
  try {
    entries = await fsp.readdir(IMAGE_DIR);
  } catch {
    return; // no store yet
  }
  const referenced = referencedImageIds(state);
  const now = Date.now();
  for (const entry of entries) {
    const id = entry.replace(/\.(part|thumb)$/, '');
    if (referenced.has(id) || uploads.has(id)) {
      orphans.delete(id);
      continue;
    }
    const since = orphans.get(id);
    if (since === undefined) {
      // First sighting: start its clock. A file the sweep meets again in a
      // later pass and the state still does not name is the garbage.
      orphans.set(id, now);
      continue;
    }
    if (now - since < IMAGE_ORPHAN_MS) continue;
    orphans.delete(id);
    await fsp.rm(path.join(IMAGE_DIR, entry), { force: true }).catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------
// Events: one ordered log for the whole service, pushed to every subscriber
// ---------------------------------------------------------------------------

/**
 * Clients follow the queue as one event stream for the service: `GET /events`
 * for a batched, cursor-based read (what a sandboxed panel can use, since the
 * host buffers one request/response and will not stream), and
 * `GET /events/stream` as real SSE for anything that can hold a connection open
 * (the CLI, a script, tooling).
 *
 * One log, not one per project: a client keeps a single cursor, so opening
 * another project never costs another reader — and a reader costs a whole
 * connection, which a sandboxed panel has only a few of. `projectId` on a read
 * is nothing but a filter for callers that want one project's slice.
 *
 * The log is in-memory only. `seq` restarts at 1 with the process, so a client
 * whose cursor is ahead of the log is told to reset and re-reads the state.
 */
type Subscriber = (event: QueueEvent) => void;

const EVENT_LOG_MAX = 100;

const log: QueueEvent[] = [];
let seq = 0;
const subscribers = new Set<Subscriber>();

/** The log keeps its own copy: the live queue keeps mutating in place. */
const snapshotQueue = (queue: ProjectQueue): ProjectQueue =>
  JSON.parse(JSON.stringify(queue)) as ProjectQueue;

const subscribe = (listener: Subscriber): (() => void) => {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
};

/** Append one event and hand it to everyone listening. */
const emit = (projectId: string, type: QueueEventType): void => {
  seq += 1;
  const event: QueueEvent = {
    seq,
    at: Date.now(),
    projectId,
    type,
    queue: snapshotQueue(getQueue(state, projectId)),
  };
  log.push(event);
  if (log.length > EVENT_LOG_MAX) log.splice(0, log.length - EVENT_LOG_MAX);
  for (const listener of [...subscribers]) listener(event);
};

type EventsRead = { events: QueueEvent[] } | { reset: true };

/**
 * Everything after `after` (optionally only `projectId`'s entries), or a reset
 * when the cursor cannot be replayed.
 */
const eventsAfter = (after: number, projectId?: string | null): EventsRead => {
  const oldest = log.length > 0 ? log[0].seq : seq + 1;
  if (after > seq || after < oldest - 1) return { reset: true };
  return { events: log.filter((event) => event.seq > after && (!projectId || event.projectId === projectId)) };
};

/**
 * The reader that is parked right now, if any.
 *
 * A parked reader is not free: it holds a connection from the host to this
 * process, and the panel that owns it has only a few connections to spend. The
 * host cannot cancel a request already in flight, so when a panel reloads, the
 * read its previous document left behind keeps holding until it expires. The
 * newest reader therefore wins: an older one is answered at once so its
 * connection frees, but only once it has been parked for a grace period, so a
 * client that keeps losing its reader (two panels watching at once) backs off
 * instead of spinning.
 */
const PARKED_GRACE_MS = 1000;

type ParkedReader = {
  at: number;
  settle: (payload: { events?: QueueEvent[]; superseded?: true } | null) => void;
};

let parked: ParkedReader | null = null;

// ---------------------------------------------------------------------------
// Local OpenChamber client (control API + proxied OpenCode session routes)
// ---------------------------------------------------------------------------

type Target = { base: string; cookie: string | null; bearer: string | null };

let target: Target | null = null;

const withTimeout = (url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

const isHealthy = async (port: number): Promise<boolean> => {
  try {
    const response = await withTimeout(`http://127.0.0.1:${port}/health`, {}, 1500);
    return response.ok;
  } catch {
    return false;
  }
};

const readInstancePassword = async (port: number): Promise<string | null> => {
  try {
    const raw = await fsp.readFile(path.join(HOST_DATA_DIR, 'run', `openchamber-${port}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { uiPassword?: string };
    return typeof parsed.uiPassword === 'string' && parsed.uiPassword ? parsed.uiPassword : null;
  } catch {
    return null;
  }
};

const readDesktop = async (): Promise<{ port: number | null; token: string | null }> => {
  try {
    const raw = await fsp.readFile(path.join(HOST_DATA_DIR, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { desktopLocalPort?: number; desktopLocalClientToken?: string };
    return {
      port: Number.isFinite(parsed.desktopLocalPort) ? Number(parsed.desktopLocalPort) : null,
      token: typeof parsed.desktopLocalClientToken === 'string' ? parsed.desktopLocalClientToken : null,
    };
  } catch {
    return { port: null, token: null };
  }
};

const candidatePorts = async (): Promise<number[]> => {
  const ports: number[] = [];
  const desktop = await readDesktop();
  if (desktop.port) ports.push(desktop.port);
  try {
    const entries = await fsp.readdir(path.join(HOST_DATA_DIR, 'run'));
    for (const name of entries) {
      const match = /^openchamber-(\d+)\.json$/.exec(name);
      if (match) ports.push(Number(match[1]));
    }
  } catch {
    // no run directory yet
  }
  if (!ports.includes(3000)) ports.push(3000);
  return [...new Set(ports)];
};

/** Log in with the instance password and keep the session cookie for later calls. */
const login = async (base: string, password: string): Promise<string | null> => {
  try {
    const response = await withTimeout(`${base}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) return null;
    const header = response.headers.get('set-cookie');
    if (!header) return null;
    const match = header.match(/oc_ui_session(?:_\d+)?=[^;]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
};

/** Resolve (and cache) the OpenChamber server this service belongs to. */
const ensureTarget = async (): Promise<Target | null> => {
  if (target) return target;
  const desktop = await readDesktop();
  for (const port of await candidatePorts()) {
    if (!(await isHealthy(port))) continue;
    const base = `http://127.0.0.1:${port}`;
    const bearer = desktop.port === port ? desktop.token : null;
    const password = await readInstancePassword(port);
    const cookie = password ? await login(base, password) : null;
    target = { base, cookie, bearer };
    logger.info('[queue] connected to OpenChamber', { base, authenticated: cookie !== null || bearer !== null });
    return target;
  }
  return null;
};

const authHeaders = (current: Target): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (current.cookie) headers.Cookie = current.cookie;
  if (!current.cookie && current.bearer) headers.Authorization = `Bearer ${current.bearer}`;
  return headers;
};

type JsonResult = { ok: true; body: any } | { ok: false; error: string };

/** GET against the OpenChamber server; `directory` scopes the proxied OpenCode route. */
const serverGet = async (pathname: string, directory?: string): Promise<JsonResult> => {
  const current = await ensureTarget();
  if (!current) return { ok: false, error: 'OpenChamber server not reachable' };
  try {
    const response = await withTimeout(`${current.base}${pathname}`, {
      headers: { ...authHeaders(current), ...(directory ? { 'x-opencode-directory': directory } : {}) },
    });
    if (response.status === 401) {
      target = null;
      return { ok: false, error: 'unauthorized' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: `GET ${pathname} failed (${response.status})` };
    return { ok: true, body };
  } catch (error) {
    target = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * POST one JSON body to the OpenChamber server. Used for the session routes the
 * control API does not cover — a prompt carrying images, which the control
 * action takes only as text.
 */
const serverPost = async (
  pathname: string,
  directory: string | undefined,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonResult> => {
  const current = await ensureTarget();
  if (!current) return { ok: false, error: 'OpenChamber server not reachable' };
  try {
    const response = await withTimeout(`${current.base}${pathname}`, {
      method: 'POST',
      headers: {
        ...authHeaders(current),
        'Content-Type': 'application/json',
        ...(directory ? { 'x-opencode-directory': directory } : {}),
      },
      body: JSON.stringify(body),
    }, timeoutMs);
    if (response.status === 401) {
      target = null;
      return { ok: false, error: 'unauthorized' };
    }
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof parsed?.error === 'string' ? parsed.error : `POST ${pathname} failed (${response.status})`;
      return { ok: false, error: message };
    }
    return { ok: true, body: parsed };
  } catch (error) {
    target = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const control = async (action: string, input: Record<string, unknown>): Promise<JsonResult> => {
  const current = await ensureTarget();
  if (!current) return { ok: false, error: 'OpenChamber server not reachable' };
  try {
    const response = await withTimeout(`${current.base}/api/openchamber/control`, {
      method: 'POST',
      headers: { ...authHeaders(current), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, input }),
    });
    if (response.status === 401) {
      // The session cookie expired: drop the cache so the next call logs in again.
      target = null;
      return { ok: false, error: 'unauthorized' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : `control ${action} failed (${response.status})`;
      return { ok: false, error: message };
    }
    return { ok: true, body };
  } catch (error) {
    target = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ---------------------------------------------------------------------------
// Observation: live activity of every session in one project
// ---------------------------------------------------------------------------

const isStatusIdle = (session: any): boolean => {
  const type = session?.status?.type;
  return !type || type === 'idle';
};

const listSessions = async (directory: string): Promise<any[] | null> => {
  const result = await control('session.list', { directory, limit: SESSION_LIMIT, all: false, withStatus: true });
  if (!result.ok) return null;
  return Array.isArray(result.body?.sessions) ? result.body.sessions : [];
};

const hasPending = (result: JsonResult): boolean =>
  result.ok && Array.isArray(result.body?.data) && result.body.data.length > 0;

/**
 * The sessions in this project that a running shell command belongs to.
 *
 * A session that ended its turn but backgrounded a shell command reports idle,
 * and OpenCode gives it no child session to notice — only the paused turn does.
 * `GET /api/shell` lists the running commands themselves, each naming its
 * session, so it is the one signal that says the task is not finished yet. Only
 * a positive answer adds occupancy: a host without the route, or a failed read,
 * leaves the check exactly as it was, so an older OpenChamber never stalls.
 */
const runningShellSessions = async (directory: string): Promise<Set<string>> => {
  const result = await serverGet('/api/shell', directory);
  if (!result.ok) return new Set();
  const shells = Array.isArray(result.body?.data) ? result.body.data : [];
  const ids = new Set<string>();
  for (const shell of shells) {
    const sessionId = shell?.metadata?.sessionID;
    if (typeof sessionId === 'string' && sessionId) ids.add(sessionId);
  }
  return ids;
};

/**
 * Activity of one session. The control API only reports busy/idle, so a busy
 * session is probed for a pending permission or question — the same
 * permission-then-form precedence the app uses for its own session list. An idle
 * session is still not finished when a shell it backgrounded is still running,
 * so that pause is reported as `background`.
 */
const sessionActivity = async (
  session: any,
  directory: string,
  shells: Set<string>,
): Promise<SessionActivity> => {
  if (isStatusIdle(session)) return shells.has(session.id) ? 'background' : 'idle';
  const [permission, form] = await Promise.all([
    serverGet(`/api/session/${encodeURIComponent(session.id)}/permission`, directory),
    serverGet(`/api/session/${encodeURIComponent(session.id)}/form`, directory),
  ]);
  if (hasPending(permission)) return 'waiting-permission';
  if (hasPending(form)) return 'waiting-question';
  const type = session?.status?.type;
  return type === 'retry' || type === 'retrying' ? 'retrying' : 'running';
};

/**
 * What the tick needs to know about one project's sessions.
 *
 * Only the sessions the decision actually reads are probed. While a run this
 * queue started is in flight the decision is about that run alone
 * (`planTick` ignores `projectBusy` then), so probing the rest of the project
 * would be thrown away. Without one, any busy session decides whether the
 * project is free, so all of them are probed, together.
 *
 * Running shell commands are read once for the project: a session that
 * backgrounded one looks idle but is not finished, and it must keep both a run
 * of the queue's own and any other session from being treated as free.
 */
const observe = async (
  directory: string,
  sessions: any[],
  active: ActiveRun | null,
): Promise<Omit<TickObservation, 'idleMs'>> => {
  const shells = await runningShellSessions(directory);
  if (active) {
    return { activeStatus: await activeStatusFor(active, sessions, directory, shells), projectBusy: false };
  }
  const activities = new Map<string, SessionActivity>();
  const busy = sessions.filter((session) => !session?.archivedAt && !isStatusIdle(session));
  await Promise.all(busy.map(async (session) => {
    activities.set(session.id, await sessionActivity(session, directory, shells));
  }));
  return {
    activeStatus: 'free',
    projectBusy: [...activities.values()].some(isOccupied) || shells.size > 0,
  };
};

/**
 * Status of the session this queue itself dispatched: `running` while it really
 * executes, `question` when it only stopped to ask the user something, and
 * `free` as soon as it is idle or gone. A backgrounded shell keeps it `running`:
 * the pause is not the end.
 */
const activeStatusFor = async (
  active: ActiveRun,
  sessions: any[],
  directory: string,
  shells: Set<string>,
): Promise<ActiveStatus> => {
  const session = sessions.find((entry) => entry?.id === active.sessionId);
  if (!session) {
    // The list may not include a just-created session yet; only call it free
    // once past the grace window, so a fresh dispatch is not finished instantly.
    return Date.now() - active.startedAt < ACTIVE_GRACE_MS ? 'running' : 'free';
  }
  if (session.archivedAt) return 'free';
  // A question frees the project, so it ends the run — but it is reported on its
  // own so the caller can give the user the longer window to answer it.
  const activity = await sessionActivity(session, directory, shells);
  if (activity === 'waiting-question') return 'question';
  return isOccupied(activity) ? 'running' : 'free';
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The model/agent/variant a new session should start on, as far as we can tell. */
type Selection = { model?: string; agent?: string; variant?: string };

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * The model and agent a session created without a prompt would come out on.
 *
 * The control API resolves the project's defaults itself — but only when it is
 * handed the prompt, and it takes no attachments. An image task therefore
 * creates its session bare and sends the prompt separately, so the selection
 * has to be named here. It is read from the host's own settings, the same two
 * levels the host resolves first (the project's choice, then the global one);
 * with nothing configured nothing is sent, and OpenCode applies its own default
 * — which is what the host's own resolution falls back to at the end.
 */
const defaultSelection = async (projectId: string, directory: string): Promise<Selection> => {
  const settings = await readJson(path.join(HOST_DATA_DIR, 'settings.json'));
  if (!settings || typeof settings !== 'object') return {};
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const project = projects.find((entry: any) => entry?.id === projectId)
    ?? projects.find((entry: any) => entry?.path === directory);
  const pick = (key: 'defaultModel' | 'defaultAgent' | 'defaultVariant'): string | null =>
    asText(project?.[key]) ?? asText(settings[key]);
  const selection: Selection = {};
  const model = pick('defaultModel');
  const agent = pick('defaultAgent');
  const variant = pick('defaultVariant');
  if (model) selection.model = model;
  if (agent) selection.agent = agent;
  if (variant) selection.variant = variant;
  return selection;
};

/** `provider/model`, the spelling the host's settings store. */
const splitModel = (value: string): { providerID: string; modelID: string } | null => {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
};

/**
 * Put the resolved selection on a session. In v2 the model and agent belong to
 * the session rather than to a prompt, so they are switched on before the
 * prompt goes out — the same two calls the app's own composer makes.
 */
const applySelection = async (
  sessionId: string,
  directory: string,
  selection: Selection,
): Promise<JsonResult> => {
  const model = selection.model ? splitModel(selection.model) : null;
  if (model) {
    const applied = await serverPost(`/api/session/${encodeURIComponent(sessionId)}/model`, directory, {
      model: {
        id: model.modelID,
        providerID: model.providerID,
        ...(selection.variant ? { variant: selection.variant } : {}),
      },
    });
    if (!applied.ok) return applied;
  }
  if (selection.agent) {
    const applied = await serverPost(`/api/session/${encodeURIComponent(sessionId)}/agent`, directory, {
      agent: selection.agent,
    });
    if (!applied.ok) return applied;
  }
  return { ok: true, body: null };
};

/** One prompt to send: its text and the images that travel with it. */
type Prompt = { text: string; images: TaskImage[] };

/**
 * Send one prompt to a session that already exists, with its images.
 *
 * The control API's `session.create` takes the prompt as plain text, so an
 * image task goes the way the app's own composer does: the session is created
 * first, then the prompt is posted on the session route with one `file` part
 * per image, each carrying the bytes as a data URL.
 */
const sendPrompt = async (sessionId: string, directory: string, prompt: Prompt): Promise<JsonResult> => {
  const files: Array<{ uri: string; name: string }> = [];
  for (const image of prompt.images) {
    const bytes = await fsp.readFile(imagePath(image.id)).catch(() => null);
    if (!bytes) {
      return { ok: false, error: `attached image ${image.name} is missing from the image store` };
    }
    files.push({ uri: `data:${image.mime};base64,${bytes.toString('base64')}`, name: image.name });
  }
  return serverPost(
    `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    directory,
    { text: prompt.text, files },
    DISPATCH_TIMEOUT_MS,
  );
};

/**
 * Hand one prompt to a new session. A prompt with images needs two calls
 * (create, then the prompt on the session route); a text-only prompt keeps the
 * single `session.create` call it always had, which is also what resolves the
 * project's default model and lets OpenCode auto-title the session.
 */
const startSessionFor = async (
  projectId: string,
  directory: string,
  prompt: Prompt,
): Promise<{ sessionId: string } | { error: string }> => {
  if (prompt.images.length === 0) {
    // Deliberately no title: OpenCode only generates a session title from the
    // first message while the session still carries its default title, so
    // passing one here would freeze the session to the task's first line and it
    // would never auto-title. Leaving it out makes a queued run look exactly
    // like a session started from the UI.
    const result = await control('session.create', { directory, prompt: prompt.text });
    if (result.ok && typeof result.body?.sessionId === 'string') return { sessionId: result.body.sessionId };
    return { error: result.ok ? 'session.create returned no session id' : result.error };
  }

  const selection = await defaultSelection(projectId, directory);
  const created = await control('session.create', { directory });
  if (!created.ok || typeof created.body?.sessionId !== 'string') {
    return { error: created.ok ? 'session.create returned no session id' : created.error };
  }
  const sessionId: string = created.body.sessionId;
  if (selection.model || selection.agent) {
    const applied = await applySelection(sessionId, directory, selection);
    // A session on the wrong model still runs; one that never starts does not.
    // The host refuses a selection it cannot use, and OpenCode applies its own.
    if (!applied.ok) logger.warn('[queue] could not set the session selection', applied.error);
  }
  const sent = await sendPrompt(sessionId, directory, prompt);
  if (!sent.ok) return { error: sent.error };
  return { sessionId };
};

/**
 * Append one prompt to a session that already exists: the target an "append"
 * task recorded when it was queued. Nothing is created and no model is switched
 * — the session keeps its own model, agent and history, and the task is simply
 * its next message, sent when the queue dispatches it.
 */
const appendToSession = async (
  directory: string,
  sessionId: string,
  prompt: Prompt,
): Promise<{ sessionId: string } | { error: string }> => {
  const sent = await sendPrompt(sessionId, directory, prompt);
  if (!sent.ok) return { error: sent.error };
  return { sessionId };
};

const dispatch = async (projectId: string, directory: string, task: QueueTask): Promise<QueueEventType> => {
  // An append task names the session it belongs to; everything else creates a
  // fresh session. Either way the dispatched session is remembered as the run.
  const prompt: Prompt = { text: task.text, images: task.images };
  const started = task.target
    ? await appendToSession(directory, task.target.sessionId, prompt)
    : await startSessionFor(projectId, directory, prompt);
  if ('sessionId' in started) {
    startTask(state, projectId, task.id, started.sessionId);
    logger.info('[queue] dispatched task', {
      projectId,
      taskId: task.id,
      sessionId: started.sessionId,
      images: task.images.length,
      appended: Boolean(task.target),
    });
    return 'run.started';
  }
  markFailed(state, projectId, task.id, started.error);
  logger.error('[queue] dispatch failed', { projectId, taskId: task.id, reason: started.error });
  return 'task.failed';
};

/**
 * Run one queued task right away: it is dispatched exactly like the scheduler
 * would dispatch it, just without waiting for the project to be free. On success
 * it leaves the queue at once (counted in `completed`, its session remembered as
 * the active run); on failure it stays as a failed task.
 */
const runTask = async (projectId: string, taskId: string): Promise<void> => {
  const info = state.projects[projectId];
  const task = getQueue(state, projectId).tasks.find((entry) => entry.id === taskId);
  if (!info || !task) return;
  const type = await dispatch(projectId, info.directory, task);
  await persist();
  emit(projectId, type);
};

/** Create a session for this composer right away, bypassing the queue. */
const runNow = async (projectId: string, text: string, images: TaskImage[]): Promise<void> => {
  const info = state.projects[projectId];
  const trimmed = text.trim();
  if (!info || !trimmed) return;
  const started = await startSessionFor(projectId, info.directory, { text: trimmed, images });
  if ('error' in started) logger.error('[queue] run-now failed', started.error);
};

/**
 * Whether one queue has anything for the worker to do: a run this queue started
 * that is still in flight, or a task waiting to start. A queue that is idle,
 * off, or holds only failed tasks is skipped without a single request — the
 * worker never asks about a project just because it is registered.
 */
const queueHasWork = (queue: ProjectQueue): boolean =>
  queue.active !== null || (queue.enabled && firstPending(queue) !== null);

/**
 * A project's idle clock: the moment it was last seen free, or absent while it
 * is occupied. The queue waits out its settle window of it before the next
 * dispatch — `DISPATCH_DELAY_MS` ordinarily, `QUESTION_DISPATCH_DELAY_MS` after
 * a run ended on a question — so this is where that window is measured from.
 */
const freeSince = new Map<string, number>();

/** The dispatch checks armed for a project, so an idle clock only has one. */
const dispatchChecks = new Map<string, NodeJS.Timeout>();

const cancelDispatchCheck = (projectId: string): void => {
  const timer = dispatchChecks.get(projectId);
  if (timer) clearTimeout(timer);
  dispatchChecks.delete(projectId);
};

/**
 * Advance this project's idle clock. `free` means neither the queue's own run
 * nor any other session is executing; when false the clock is forgotten so the
 * next window starts from zero.
 */
const trackIdle = (projectId: string, free: boolean, now: number): number => {
  if (!free) {
    freeSince.delete(projectId);
    return 0;
  }
  const since = freeSince.get(projectId) ?? now;
  freeSince.set(projectId, since);
  return now - since;
};

/**
 * The settle window to use for a project's next dispatch, when it differs from
 * `DISPATCH_DELAY_MS`. A run that ended on a question arms the longer
 * `QUESTION_DISPATCH_DELAY_MS` here; the entry is cleared the moment the project
 * stops being free or a task is dispatched, so it only ever applies to the
 * dispatch that follows that one run.
 */
const nextSettleMs = new Map<string, number>();

/** The settle window a project's next dispatch must wait out. */
const settleDelayFor = (projectId: string): number =>
  nextSettleMs.get(projectId) ?? DISPATCH_MS;

/** Forget a project's armed settle window; it no longer has one to honour. */
const clearSettle = (projectId: string): void => {
  nextSettleMs.delete(projectId);
};

/**
 * Re-evaluate this project the moment its settle window is up, so the next task
 * starts right after it rather than at the next periodic tick.
 */
const scheduleDispatchCheck = (projectId: string): void => {
  const since = freeSince.get(projectId);
  if (since === undefined) return;
  const delayMs = Math.max(0, since + settleDelayFor(projectId) - Date.now());
  cancelDispatchCheck(projectId);
  const timer = setTimeout(() => {
    dispatchChecks.delete(projectId);
    evaluateProject(projectId);
  }, delayMs);
  timer.unref?.();
  dispatchChecks.set(projectId, timer);
};

/**
 * One project, one step at a time: finishing the active run frees the project,
 * so we ask again and may dispatch in the same tick.
 */
const runProject = async (projectId: string): Promise<QueueEventType[]> => {
  const info = state.projects[projectId];
  if (!info) return [];
  const types: QueueEventType[] = [];

  if (!queueHasWork(getQueue(state, projectId))) {
    // Nothing queued: the settle window only starts once there is work to run.
    freeSince.delete(projectId);
    clearSettle(projectId);
    cancelDispatchCheck(projectId);
    offlineProjects.delete(projectId);
    return types;
  }

  for (let step = 0; step < MAX_STEPS_PER_TICK; step += 1) {
    const queue = getQueue(state, projectId);
    if (!queueHasWork(queue)) break;

    const sessions = await listSessions(info.directory);
    if (!sessions) {
      // The host refused the read (unreachable, unauthorized, or its own error).
      // One line per outage, not one per tick, so a host that is down for a while
      // does not bury everything else in the log.
      if (!offlineProjects.has(projectId)) {
        offlineProjects.add(projectId);
        logger.warn('[queue] cannot read sessions', { projectId, directory: info.directory });
      }
      break;
    }
    if (offlineProjects.delete(projectId)) {
      logger.info('[queue] sessions reachable again', { projectId });
    }
    const observation = await observe(info.directory, sessions, queue.active);
    const now = Date.now();
    const free = queue.active === null && !observation.projectBusy;
    // Anything but a free project ends the current window, so a run in flight
    // cannot carry an armed question window over to the dispatch that follows it.
    if (!free) clearSettle(projectId);
    const decision = planTick(queue, {
      ...observation,
      idleMs: trackIdle(projectId, free, now),
      settleMs: settleDelayFor(projectId),
    });

    if (decision.kind === 'finish') {
      // A run that ended on a question hands the floor to the user: arm the
      // longer window so the next task does not run over the pending answer. Any
      // other finish clears it and settles for the ordinary window.
      if (observation.activeStatus === 'question') nextSettleMs.set(projectId, QUESTION_DISPATCH_MS);
      else clearSettle(projectId);
      finishRun(state, projectId);
      types.push('run.finished');
      continue;
    }
    if (decision.kind === 'dispatch') {
      cancelDispatchCheck(projectId);
      clearSettle(projectId);
      const task = queue.tasks.find((entry) => entry.id === decision.taskId);
      if (!task) break;
      types.push(await dispatch(projectId, info.directory, task));
      break;
    }
    // Waiting on the settle window (or occupied): re-check when it is up.
    if (free && firstPending(queue)) scheduleDispatchCheck(projectId);
    else cancelDispatchCheck(projectId);
    break;
  }
  return types;
};

/**
 * Evaluate one project and report whether it changed anything. A project already
 * being evaluated is skipped: two passes over the same queue could both decide
 * to dispatch its head task. The guard is per project rather than one global
 * lock, so a command's pass is not held back by the periodic sweep of another
 * project — and it never queues behind a pass it would then duplicate.
 */
const tickingProjects = new Set<string>();

/**
 * Projects whose last session read failed, so an unreachable host is reported
 * once instead of on every tick while it stays down.
 */
const offlineProjects = new Set<string>();

const tickProject = async (projectId: string): Promise<boolean> => {
  if (tickingProjects.has(projectId)) return false;
  tickingProjects.add(projectId);
  try {
    const types = await runProject(projectId);
    for (const type of types) emit(projectId, type);
    return types.length > 0;
  } finally {
    tickingProjects.delete(projectId);
  }
};

/** The registered queues that have something to do, in registration order. */
const projectsWithWork = (): string[] =>
  Object.keys(state.projects).filter((projectId) => queueHasWork(getQueue(state, projectId)));

/**
 * The periodic sweep: whatever has work, because a run may have ended since the
 * last pass and freed its queue. The work set comes from the queues, not from
 * the registry: a project with nothing queued is never asked about.
 */
const tick = async (): Promise<void> => {
  let mutated = false;
  try {
    for (const projectId of projectsWithWork()) {
      if (await tickProject(projectId)) mutated = true;
    }
  } catch (error) {
    // One project must not stop the sweep or raise an unhandled rejection.
    logger.error('[queue] tick failed', error);
  }
  if (mutated) {
    await persist();
    // A dispatched task's images are no longer referenced: the sweep starts
    // their clock now and lets them go once the window has passed.
    void sweepImages();
  }
};

/**
 * Evaluate one project behind the caller. A panel command answers as soon as it
 * changed the state; the dispatch it may have made possible runs on from here.
 * Firing a task starts a session and sends its prompt, which takes seconds, and
 * a button must not spin for that. The panel follows the event stream, so it
 * learns the outcome the moment it is known.
 */
const evaluateProject = (projectId: string): void => {
  void (async () => {
    try {
      if (await tickProject(projectId)) await persist();
    } catch (error) {
      logger.error('[queue] tick failed', error);
    }
  })();
};

// ---------------------------------------------------------------------------
// Commands (called by the panel through serviceRequest)
// ---------------------------------------------------------------------------

type Command = {
  op: 'register' | 'enqueue' | 'edit' | 'remove' | 'move' | 'run' | 'retry' | 'clear' | 'set-enabled' | 'set-task-enabled' | 'run-now' | 'set-draft' | 'tick';
  projectId?: string;
  directory?: string;
  name?: string;
  text?: string;
  /** Image references the panel holds; the bytes are already in the store. */
  images?: TaskImage[];
  taskId?: string;
  direction?: 'top' | 'up' | 'down';
  /** The queue switch for `set-enabled`, or the new task's own switch for `enqueue`. */
  enabled?: boolean;
  /** "Append" enqueue: the session the new task should be sent to at dispatch. */
  targetSessionId?: string;
  targetSessionTitle?: string;
};

/** Which event a command reports once it changed something. */
const COMMAND_EVENTS: Partial<Record<Command['op'], QueueEventType>> = {
  register: 'project.registered',
  enqueue: 'task.enqueued',
  edit: 'task.edited',
  remove: 'task.removed',
  move: 'task.moved',
  retry: 'task.retried',
  clear: 'queue.cleared',
  'set-enabled': 'queue.enabled',
  'set-task-enabled': 'task.enabled',
};

const applyCommand = async (command: Command): Promise<boolean> => {
  const projectId = command.projectId;
  if (!projectId) return false;
  switch (command.op) {
    case 'register':
      if (!command.directory) return false;
      return registerProject(state, { id: projectId, directory: command.directory, name: command.name ?? projectId });
    case 'enqueue': {
      // An "append" task names the session recorded by the panel; a plain
      // enqueue leaves it off and dispatch creates a session as before.
      const target: TaskTarget | undefined = command.targetSessionId
        ? { sessionId: command.targetSessionId, title: command.targetSessionTitle }
        : undefined;
      return enqueue(state, projectId, command.text ?? '', {
        images: sanitizeImages(command.images),
        target,
        enabled: command.enabled !== false,
      }) !== null;
    }
    case 'edit':
      return editTask(state, projectId, command.taskId ?? '', command.text ?? '', sanitizeImages(command.images));
    case 'remove':
      return removeTask(state, projectId, command.taskId ?? '');
    case 'move':
      return moveTask(state, projectId, command.taskId ?? '', command.direction ?? 'top');
    case 'run':
      // Persists and emits its own event (run.started / task.failed), so it
      // reports no generic change to the caller.
      await runTask(projectId, command.taskId ?? '');
      return false;
    case 'retry':
      return retryTask(state, projectId, command.taskId ?? '');
    case 'clear':
      return clearTasks(state, projectId);
    case 'set-enabled':
      return setEnabled(state, projectId, command.enabled === true);
    case 'set-task-enabled':
      return setTaskEnabled(state, projectId, command.taskId ?? '', command.enabled === true);
    case 'set-draft':
      return setDraft(state, projectId, { text: command.text ?? '', images: sanitizeImages(command.images) });
    case 'run-now':
      await runNow(projectId, command.text ?? '', sanitizeImages(command.images));
      return false;
    case 'tick':
      await tick();
      return false;
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------
// Image uploads
// ---------------------------------------------------------------------------

type ImageSession = { name: string; mime: string; bytes: number };

/** Base64 characters only: the panel sends chunks of an encoded image. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A preview is a data URL the panel itself produced. */
const isThumb = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:image/') && value.length <= MAX_THUMB_CHARS;

/** Answer with an error and report the request as handled. */
const badRequest = (res: http.ServerResponse, status: number, error: string): boolean => {
  json(res, status, { error });
  return true;
};

/**
 * The image store's HTTP surface.
 *
 * The panel holds no filesystem access and the host caps one request body at
 * 64 kB, so an image arrives in chunks and is assembled here: `begin` opens a
 * part file, every `chunk` appends to it, and `end` promotes it to the store
 * and records the preview. The bytes never travel back — the panel only reads
 * the small preview it may need after a reload. Returns true when the request
 * was one of these routes.
 */
const handleImageRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> => {
  const thumbMatch = /^\/image\/([^/]+)\/thumb$/.exec(url.pathname);
  if (thumbMatch && req.method === 'GET') {
    const id = thumbMatch[1];
    if (!isImageId(id)) return badRequest(res, 400, 'bad image id');
    const thumb = await fsp.readFile(imagePath(id, '.thumb'), 'utf8').catch(() => null);
    json(res, 200, { id, thumb: isThumb(thumb) ? thumb : null });
    return true;
  }

  if (url.pathname !== '/image/begin' && url.pathname !== '/image/chunk'
    && url.pathname !== '/image/end' && url.pathname !== '/image/abort') {
    return false;
  }
  if (req.method !== 'POST') return badRequest(res, 405, 'method not allowed');

  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
  } catch {
    return badRequest(res, 400, 'invalid body');
  }
  const id = body?.id;
  if (!isImageId(id)) return badRequest(res, 400, 'bad image id');

  if (url.pathname === '/image/begin') {
    const name = asText(body?.name) ?? 'image';
    const mime = asText(body?.mime) ?? 'application/octet-stream';
    if (uploads.has(id)) return badRequest(res, 409, 'upload already started');
    await fsp.mkdir(IMAGE_DIR, { recursive: true });
    await fsp.writeFile(imagePath(id, '.part'), '');
    uploads.set(id, { name, mime, bytes: 0 });
    json(res, 200, { ok: true, id });
    return true;
  }

  const session = uploads.get(id);
  if (!session) return badRequest(res, 409, 'upload not started');

  if (url.pathname === '/image/abort') {
    uploads.delete(id);
    await fsp.rm(imagePath(id, '.part'), { force: true }).catch(() => undefined);
    json(res, 200, { ok: true, id });
    return true;
  }

  if (url.pathname === '/image/chunk') {
    const data = typeof body?.data === 'string' ? body.data : '';
    if (!data || data.length > MAX_IMAGE_CHUNK_CHARS || !BASE64.test(data)) {
      return badRequest(res, 400, 'bad chunk');
    }
    const bytes = Buffer.from(data, 'base64');
    if (session.bytes + bytes.length > MAX_IMAGE_BYTES) {
      uploads.delete(id);
      await fsp.rm(imagePath(id, '.part'), { force: true }).catch(() => undefined);
      return badRequest(res, 413, `image is larger than ${MAX_IMAGE_BYTES} bytes`);
    }
    await fsp.appendFile(imagePath(id, '.part'), bytes);
    session.bytes += bytes.length;
    json(res, 200, { ok: true, id, received: session.bytes });
    return true;
  }

  // `end`: promote the part file into the store and keep its preview.
  uploads.delete(id);
  const image = sanitizeImages([{ id, name: session.name, mime: session.mime, size: session.bytes }])[0];
  if (!image) {
    await fsp.rm(imagePath(id, '.part'), { force: true }).catch(() => undefined);
    return badRequest(res, 400, 'empty image');
  }
  const thumb = isThumb(body?.thumb) ? body.thumb : null;
  try {
    await fsp.mkdir(IMAGE_DIR, { recursive: true });
    await fsp.rename(imagePath(id, '.part'), imagePath(id));
    if (thumb) await fsp.writeFile(imagePath(id, '.thumb'), thumb, 'utf8');
  } catch (error) {
    logger.error('[queue] failed to store image', error);
    return badRequest(res, 500, 'could not store the image');
  }
  json(res, 200, { ok: true, image });
  return true;
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 2_000_000) reject(new Error('request too large'));
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const summarize = (queue: ProjectQueue) => countTasks(queue);

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, pid: process.pid });
      return;
    }

    if (url.pathname === '/state') {
      const projectId = url.searchParams.get('projectId') ?? '';
      const queue = getQueue(state, projectId);
      const snapshot: QueueSnapshot = {
        project: state.projects[projectId] ?? null,
        queue,
        draft: getDraft(state, projectId),
        seq,
      };
      json(res, 200, { backend: true, projectId, ...snapshot, counts: summarize(queue) });
      return;
    }

    if (await handleImageRequest(req, res, url)) return;

    /**
     * The event stream, in batches: everything after `after`, or the events that
     * arrive while the call is held (up to `wait` ms). One stream for the whole
     * service — `projectId` only narrows the answer, it does not select a
     * different log — and it is the shape a sandboxed panel can consume, since
     * the host buffers one request/response and will not stream.
     * `/events/stream` below carries the very same events for clients that can.
     */
    if (url.pathname === '/events') {
      const projectId = url.searchParams.get('projectId');
      const after = Number(url.searchParams.get('after') ?? '0');
      const requested = Number(url.searchParams.get('wait') ?? WAIT_MAX_MS);
      const hold = Number.isFinite(requested)
        ? Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, requested))
        : WAIT_MAX_MS;

      const answer = (payload: { events?: QueueEvent[]; reset?: true; superseded?: true }): void => {
        const queue = getQueue(state, projectId ?? '');
        json(res, 200, {
          backend: true,
          ...(projectId ? { projectId, queue, counts: summarize(queue) } : {}),
          seq,
          events: [],
          ...payload,
        });
      };

      // Checked and subscribed without awaiting in between: no event can slip
      // through the gap and leave the caller parked until the hold expires.
      const pending = eventsAfter(after, projectId);
      if ('reset' in pending) {
        answer({ reset: true });
        return;
      }
      if (pending.events.length > 0) {
        answer({ events: pending.events });
        return;
      }

      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;
      const finish = (payload: { events?: QueueEvent[]; superseded?: true } | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        unsubscribe?.();
        if (parked?.settle === finish) parked = null;
        if (payload) answer(payload);
      };

      // One parked reader at most: the newest wins, so a reader left behind by a
      // reloaded or switched panel is dropped instead of holding a connection.
      if (parked && Date.now() - parked.at >= PARKED_GRACE_MS) {
        const previous = parked;
        parked = null;
        previous.settle({ superseded: true });
      }

      unsubscribe = subscribe((event) => finish({ events: [event] }));
      parked = { at: Date.now(), settle: finish };
      timer = setTimeout(() => finish({}), hold);
      timer.unref?.();
      // The panel closing or reloading drops the connection; stop holding then.
      res.on('close', () => finish(null));
      return;
    }

    /** The same events as a real SSE stream, for clients that can hold a socket. */
    if (url.pathname === '/events/stream') {
      const projectId = url.searchParams.get('projectId');
      const after = Number(url.searchParams.get('after') ?? '0');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');

      let unsubscribe: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      const stop = (): void => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
      };

      const send = (event: QueueEvent): void => {
        if (projectId && event.projectId !== projectId) return;
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const pending = eventsAfter(after, projectId);
      if ('reset' in pending) {
        const queue = projectId ? getQueue(state, projectId) : null;
        res.write(`event: reset\ndata: ${JSON.stringify({ seq, ...(queue ? { queue, counts: summarize(queue) } : {}) })}\n\n`);
      } else {
        for (const event of pending.events) send(event);
      }
      unsubscribe = subscribe(send);
      heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      heartbeat.unref?.();
      res.on('close', stop);
      return;
    }

    if (url.pathname === '/all') {
      json(res, 200, {
        backend: true,
        state,
        counts: Object.fromEntries(Object.keys(state.queues).map((id) => [id, summarize(state.queues[id])])),
      });
      return;
    }

    if (url.pathname === '/cmd' && req.method === 'POST') {
      const raw = await readBody(req);
      const command = JSON.parse(raw || '{}') as Command;
      const changed = await applyCommand(command);
      if (command.op !== 'tick' && changed) {
        await persist();
        // Whatever the change unreferenced (a deleted task, a cleared
        // composer) starts its orphan clock here; an upload in flight and a
        // reference that is about to come back are both protected.
        void sweepImages();
        // A draft is only bookkeeping for the panel that typed it: persist it,
        // but do not emit an event or re-evaluate the project. An echo would
        // race the caret back into the box mid-keystroke, and a draft cannot
        // make a queue dispatchable.
        if (command.op !== 'set-draft') {
          const type = command.projectId ? COMMAND_EVENTS[command.op] : undefined;
          if (type && command.projectId) emit(command.projectId, type);
          // A mutation may make a project dispatchable: evaluate it right away so
          // the panel does not wait a whole tick — but do it behind this response
          // (the event stream carries the result), so a click never waits on the
          // session a dispatch has to create.
          if (command.projectId) evaluateProject(command.projectId);
        }
      }
      const projectId = command.projectId ?? '';
      const queue = command.projectId ? getQueue(state, projectId) : null;
      json(res, 200, {
        ok: true,
        seq,
        queue: queue ?? undefined,
        counts: queue ? summarize(queue) : undefined,
      });
      return;
    }

    json(res, 404, { error: 'not-found' });
  })().catch((error) => {
    logger.error('[queue] request failed', error);
    json(res, 500, { error: error instanceof Error ? error.message : 'failed' });
  });
});

server.on('error', (error) => logger.error('[queue] server error', error));
server.listen(PORT, '127.0.0.1', () => {
  logger.info('[queue] service listening', {
    pid: process.pid,
    port: PORT,
    stateFile: STATE_FILE,
    imageDir: IMAGE_DIR,
    logFile: logger.file,
  });
});

void (async () => {
  state = await readState();
  // Images nothing refers to any more — a store from an older run, a task
  // dispatched while the service was down — start their clock now and go at the
  // next pass, once they have been unreferenced for the whole window.
  void sweepImages();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  // A service with nothing to do still has to let go of old images.
  const sweeper = setInterval(() => void sweepImages(), SWEEP_INTERVAL_MS);
  sweeper.unref?.();
  void tick();
})();

// Anything the service did not catch still reaches the log, so a crash leaves a
// trace behind instead of only on a stream the host may have already dropped.
process.on('unhandledRejection', (reason) => {
  logger.error('[queue] unhandled rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('[queue] uncaught exception', error);
  void logger.flush().finally(() => process.exit(1));
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info(`[queue] received ${signal}, shutting down`);
  server.close(() => { void logger.flush().finally(() => process.exit(0)); });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
