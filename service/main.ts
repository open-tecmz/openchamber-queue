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
  clearTasks,
  completeTask,
  countTasks,
  deriveTitle,
  editTask,
  emptyState,
  enqueue,
  getQueue,
  isOccupied,
  markFailed,
  markRunning,
  moveTask,
  planTick,
  registerProject,
  releaseTask,
  removeTask,
  retryTask,
  setEnabled,
  type ActiveStatus,
  type ProjectQueue,
  type SessionActivity,
  type QueueState,
  type QueueTask,
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
 * Activity of one session. The control API only reports busy/idle, so a busy
 * session is probed for a pending permission or question — the same
 * permission-then-form precedence the app uses for its own session list.
 */
const sessionActivity = async (session: any, directory: string): Promise<SessionActivity> => {
  if (isStatusIdle(session)) return 'idle';
  const [permission, form] = await Promise.all([
    serverGet(`/api/session/${encodeURIComponent(session.id)}/permission`, directory),
    serverGet(`/api/session/${encodeURIComponent(session.id)}/form`, directory),
  ]);
  if (hasPending(permission)) return 'waiting-permission';
  if (hasPending(form)) return 'waiting-question';
  const type = session?.status?.type;
  return type === 'retry' || type === 'retrying' ? 'retrying' : 'running';
};

type ProjectObservation = {
  activityOf: (sessionId: string) => SessionActivity;
  projectBusy: boolean;
};

const observeProject = async (directory: string, sessions: any[]): Promise<ProjectObservation> => {
  const activities = new Map<string, SessionActivity>();
  const busy = sessions.filter((session) => !session?.archivedAt && !isStatusIdle(session));
  await Promise.all(busy.map(async (session) => {
    activities.set(session.id, await sessionActivity(session, directory));
  }));
  return {
    activityOf: (sessionId: string) => activities.get(sessionId) ?? 'idle',
    projectBusy: [...activities.values()].some(isOccupied),
  };
};

const activeStatusFor = (
  active: { sessionId: string; startedAt: number },
  sessions: any[],
  observation: ProjectObservation,
): ActiveStatus => {
  const session = sessions.find((entry) => entry?.id === active.sessionId);
  if (!session) {
    // The list may not include a just-created session yet; only call it gone
    // once past the grace window, so a fresh dispatch is not completed instantly.
    return Date.now() - active.startedAt < ACTIVE_GRACE_MS ? 'running' : 'gone';
  }
  if (session.archivedAt) return 'gone';
  const activity = observation.activityOf(session.id);
  if (activity === 'waiting-question') return 'question';
  return activity === 'idle' ? 'idle' : 'running';
};

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

let ticking = false;

const dispatch = async (projectId: string, directory: string, task: QueueTask): Promise<void> => {
  const title = deriveTitle(task.text);
  const result = await control('session.create', { directory, prompt: task.text, title });
  if (result.ok && typeof result.body?.sessionId === 'string') {
    markRunning(state, projectId, task.id, result.body.sessionId);
    return;
  }
  markFailed(state, projectId, task.id, result.ok ? 'session.create returned no session id' : result.error);
};

/**
 * One project, one step at a time: completing or releasing the active task
 * frees the project, so we ask again and may dispatch in the same tick.
 */
const runProject = async (projectId: string): Promise<boolean> => {
  const info = state.projects[projectId];
  if (!info) return false;
  let mutated = false;

  for (let step = 0; step < MAX_STEPS_PER_TICK; step += 1) {
    const queue = getQueue(state, projectId);
    if (!queue.active && (!queue.enabled || queue.tasks.length === 0)) break;

    const sessions = await listSessions(info.directory);
    if (!sessions) break;
    const observation = await observeProject(info.directory, sessions);
    const decision = planTick(queue, {
      projectBusy: observation.projectBusy,
      activeStatus: queue.active ? activeStatusFor(queue.active, sessions, observation) : 'idle',
    });

    if (decision.kind === 'wait' || decision.kind === 'idle') break;
    if (decision.kind === 'complete') {
      completeTask(state, projectId, decision.taskId);
      mutated = true;
      continue;
    }
    if (decision.kind === 'release') {
      releaseTask(state, projectId, decision.taskId);
      mutated = true;
      continue;
    }
    const task = queue.tasks.find((entry) => entry.id === decision.taskId);
    if (!task) break;
    await dispatch(projectId, info.directory, task);
    mutated = true;
    break;
  }
  return mutated;
};

const runTick = async (): Promise<boolean> => {
  let mutated = false;
  for (const projectId of Object.keys(state.projects)) {
    if (await runProject(projectId)) mutated = true;
  }
  return mutated;
};

const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    if (await runTick()) await persist();
  } catch (error) {
    console.error('[queue] tick failed', error);
  } finally {
    ticking = false;
  }
};

// ---------------------------------------------------------------------------
// Commands (called by the panel through serviceRequest)
// ---------------------------------------------------------------------------

type Command = {
  op: 'register' | 'enqueue' | 'edit' | 'remove' | 'move' | 'retry' | 'clear' | 'set-enabled' | 'tick';
  projectId?: string;
  directory?: string;
  name?: string;
  text?: string;
  taskId?: string;
  direction?: 'top' | 'up' | 'down';
  enabled?: boolean;
};

const applyCommand = async (command: Command): Promise<boolean> => {
  const projectId = command.projectId;
  if (!projectId) return false;
  switch (command.op) {
    case 'register':
      if (!command.directory) return false;
      registerProject(state, { id: projectId, directory: command.directory, name: command.name ?? projectId });
      return true;
    case 'enqueue':
      return enqueue(state, projectId, command.text ?? '') !== null;
    case 'edit':
      return editTask(state, projectId, command.taskId ?? '', command.text ?? '');
    case 'remove':
      return removeTask(state, projectId, command.taskId ?? '');
    case 'move':
      return moveTask(state, projectId, command.taskId ?? '', command.direction ?? 'top');
    case 'retry':
      return retryTask(state, projectId, command.taskId ?? '');
    case 'clear':
      return clearTasks(state, projectId);
    case 'set-enabled':
      return setEnabled(state, projectId, command.enabled === true);
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
      json(res, 200, {
        backend: true,
        projectId,
        project: state.projects[projectId] ?? null,
        queue: getQueue(state, projectId),
        counts: summarize(getQueue(state, projectId)),
      });
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
      if (command.op !== 'tick') {
        if (changed) {
          await persist();
          // A mutation may make a project dispatchable: evaluate right away so
          // the panel sees the effect on this response instead of next tick.
          await tick();
          await persist();
        }
      }
      json(res, 200, { ok: true, queue: command.projectId ? getQueue(state, command.projectId) : undefined });
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
