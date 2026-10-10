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
  registerProject,
  removeTask,
  repairQueue,
  retryTask,
  setDraft,
  setEnabled,
  startTask,
  type ActiveRun,
  type ActiveStatus,
  type ProjectQueue,
  type SessionActivity,
  type QueueState,
  type QueueTask,
  type TickObservation,
} from '../src/core.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!PORT || !TOKEN) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const TICK_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
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

let state: QueueState = emptyState();
let writeChain: Promise<void> = Promise.resolve();

const readState = async (): Promise<QueueState> => {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as QueueState;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    parsed.projects ??= {};
    parsed.queues ??= {};
    parsed.drafts ??= {};
    for (const queue of Object.values(parsed.queues)) {
      if (queue && typeof queue === 'object') repairQueue(queue);
    }
    return parsed;
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
      console.error('[queue] failed to persist state', error);
    }
  });
  return writeChain;
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
 * executes, `free` as soon as it is idle, gone, or only waiting on a question.
 * A backgrounded shell keeps it `running`: the pause is not the end.
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
  // A question does not occupy the project, so it frees the queue as well.
  return isOccupied(await sessionActivity(session, directory, shells)) ? 'running' : 'free';
};

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

const dispatch = async (projectId: string, directory: string, task: QueueTask): Promise<QueueEventType> => {
  // Deliberately no title: OpenCode only generates a session title from the
  // first message while the session still carries its default title, so passing
  // one here would freeze the session to the task's first line and it would
  // never auto-title. Leaving it out makes a queued run look exactly like a
  // session started from the UI.
  const result = await control('session.create', { directory, prompt: task.text });
  if (result.ok && typeof result.body?.sessionId === 'string') {
    startTask(state, projectId, task.id, result.body.sessionId);
    return 'run.started';
  }
  markFailed(state, projectId, task.id, result.ok ? 'session.create returned no session id' : result.error);
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

/** Create a session for this text right away, bypassing the queue. */
const runNow = async (projectId: string, text: string): Promise<void> => {
  const info = state.projects[projectId];
  const trimmed = text.trim();
  if (!info || !trimmed) return;
  const result = await control('session.create', {
    directory: info.directory,
    prompt: trimmed,
  });
  if (!result.ok) console.error('[queue] run-now failed', result.error);
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
 * is occupied. The queue waits out `DISPATCH_DELAY_MS` of it before the next
 * dispatch, so this is where the settle window is measured from.
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
 * Re-evaluate this project the moment its settle window is up, so the next task
 * starts right after `DISPATCH_DELAY_MS` rather than at the next periodic tick.
 */
const scheduleDispatchCheck = (projectId: string): void => {
  const since = freeSince.get(projectId);
  if (since === undefined) return;
  const delayMs = Math.max(0, since + DISPATCH_DELAY_MS - Date.now());
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
    cancelDispatchCheck(projectId);
    return types;
  }

  for (let step = 0; step < MAX_STEPS_PER_TICK; step += 1) {
    const queue = getQueue(state, projectId);
    if (!queueHasWork(queue)) break;

    const sessions = await listSessions(info.directory);
    if (!sessions) break;
    const observation = await observe(info.directory, sessions, queue.active);
    const now = Date.now();
    const free = queue.active === null && !observation.projectBusy;
    const decision = planTick(queue, { ...observation, idleMs: trackIdle(projectId, free, now) });

    if (decision.kind === 'finish') {
      finishRun(state, projectId);
      types.push('run.finished');
      continue;
    }
    if (decision.kind === 'dispatch') {
      cancelDispatchCheck(projectId);
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
    console.error('[queue] tick failed', error);
  }
  if (mutated) await persist();
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
      console.error('[queue] tick failed', error);
    }
  })();
};

// ---------------------------------------------------------------------------
// Commands (called by the panel through serviceRequest)
// ---------------------------------------------------------------------------

type Command = {
  op: 'register' | 'enqueue' | 'edit' | 'remove' | 'move' | 'run' | 'retry' | 'clear' | 'set-enabled' | 'run-now' | 'set-draft' | 'tick';
  projectId?: string;
  directory?: string;
  name?: string;
  text?: string;
  taskId?: string;
  direction?: 'top' | 'up' | 'down';
  enabled?: boolean;
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
};

const applyCommand = async (command: Command): Promise<boolean> => {
  const projectId = command.projectId;
  if (!projectId) return false;
  switch (command.op) {
    case 'register':
      if (!command.directory) return false;
      return registerProject(state, { id: projectId, directory: command.directory, name: command.name ?? projectId });
    case 'enqueue':
      return enqueue(state, projectId, command.text ?? '') !== null;
    case 'edit':
      return editTask(state, projectId, command.taskId ?? '', command.text ?? '');
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
    case 'set-draft':
      return setDraft(state, projectId, command.text ?? '');
    case 'run-now':
      await runNow(projectId, command.text ?? '');
      return false;
    case 'tick':
      await tick();
      return false;
    default:
      return false;
  }
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
    console.error('[queue] request failed', error);
    json(res, 500, { error: error instanceof Error ? error.message : 'failed' });
  });
});

server.listen(PORT, '127.0.0.1');

void (async () => {
  state = await readState();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
})();

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
