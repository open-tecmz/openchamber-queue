// service/main.ts
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// src/core.ts
var STATE_VERSION = 1;
var ACTIVE_GRACE_MS = 15000;
var DISPATCH_DELAY_MS = 1e4;
var emptyState = () => ({
  version: STATE_VERSION,
  projects: {},
  queues: {}
});
var emptyQueue = () => ({
  enabled: false,
  completed: 0,
  tasks: [],
  active: null
});
var deriveTitle = (text, fallback = "Queue task") => {
  const firstLine = text.trim().split(`
`)[0]?.trim() ?? "";
  if (!firstLine)
    return fallback;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
};
var nextId = () => {
  const random = Math.random().toString(36).slice(2, 8);
  return `t_${Date.now().toString(36)}_${random}`;
};
var normalizeQueue = (queue) => {
  if (queue.tasks.length === 0) {
    queue.enabled = false;
    queue.active = null;
  }
};
var ensureQueue = (state, projectId) => {
  if (!state.queues[projectId])
    state.queues[projectId] = emptyQueue();
  return state.queues[projectId];
};
var getQueue = (state, projectId) => state.queues[projectId] ?? emptyQueue();
var makeTask = (text, now = Date.now()) => ({
  id: nextId(),
  text: text.trim(),
  status: "pending",
  createdAt: now,
  finishedAt: null,
  error: null
});
var enqueue = (state, projectId, text, now = Date.now()) => {
  const trimmed = text.trim();
  if (!trimmed)
    return null;
  const task = makeTask(trimmed, now);
  ensureQueue(state, projectId).tasks.push(task);
  return task;
};
var removeTask = (state, projectId, taskId) => {
  const queue = state.queues[projectId];
  if (!queue)
    return false;
  const before = queue.tasks.length;
  queue.tasks = queue.tasks.filter((task) => task.id !== taskId);
  normalizeQueue(queue);
  return queue.tasks.length !== before;
};
var editTask = (state, projectId, taskId, text) => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  const trimmed = text.trim();
  if (!queue || !task || !trimmed)
    return false;
  task.text = trimmed;
  return true;
};
var moveTask = (state, projectId, taskId, direction) => {
  const queue = state.queues[projectId];
  if (!queue)
    return false;
  const index = queue.tasks.findIndex((task2) => task2.id === taskId);
  if (index < 0)
    return false;
  if (direction === "top" && index > 0) {
    const [task2] = queue.tasks.splice(index, 1);
    queue.tasks.unshift(task2);
    return true;
  }
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= queue.tasks.length)
    return false;
  const [task] = queue.tasks.splice(index, 1);
  queue.tasks.splice(target, 0, task);
  return true;
};
var retryTask = (state, projectId, taskId, now = Date.now()) => {
  const task = state.queues[projectId]?.tasks.find((entry) => entry.id === taskId);
  if (!task)
    return false;
  task.status = "pending";
  task.finishedAt = null;
  task.error = null;
  task.createdAt = now;
  return true;
};
var clearTasks = (state, projectId) => {
  const queue = state.queues[projectId];
  if (!queue)
    return false;
  queue.tasks = [];
  normalizeQueue(queue);
  return true;
};
var setEnabled = (state, projectId, enabled) => {
  ensureQueue(state, projectId).enabled = enabled;
  return true;
};
var registerProject = (state, project) => {
  const known = state.projects[project.id];
  if (known?.directory === project.directory && known?.name === project.name && state.queues[project.id]) {
    return false;
  }
  state.projects[project.id] = { ...project };
  ensureQueue(state, project.id);
  return true;
};
var firstPending = (queue) => queue.tasks.find((task) => task.status === "pending") ?? null;
var startTask = (state, projectId, taskId, sessionId, now = Date.now()) => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  if (!queue || !task)
    return;
  queue.tasks = queue.tasks.filter((entry) => entry.id !== taskId);
  queue.completed += 1;
  queue.active = { sessionId, startedAt: now };
};
var finishRun = (state, projectId) => {
  const queue = state.queues[projectId];
  if (!queue?.active)
    return;
  queue.active = null;
  normalizeQueue(queue);
};
var markFailed = (state, projectId, taskId, error, now = Date.now()) => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  if (!queue || !task)
    return;
  task.status = "failed";
  task.finishedAt = now;
  task.error = error;
};
var isOccupied = (activity) => activity === "running" || activity === "retrying" || activity === "waiting-permission";
var planTick = (queue, observation) => {
  if (queue.active) {
    return observation.activeStatus === "running" ? { kind: "wait" } : { kind: "finish" };
  }
  if (observation.projectBusy)
    return { kind: "wait" };
  if (observation.idleMs < DISPATCH_DELAY_MS)
    return { kind: "wait" };
  const next = firstPending(queue);
  return next ? { kind: "dispatch", taskId: next.id } : { kind: "idle" };
};
var countTasks = (queue) => {
  const counts = { pending: 0, failed: 0, completed: queue.completed };
  for (const task of queue.tasks) {
    if (task.status === "pending")
      counts.pending += 1;
    else if (task.status === "failed")
      counts.failed += 1;
  }
  return counts;
};
var repairQueue = (queue) => {
  queue.tasks = (queue.tasks ?? []).filter((task) => task?.status === "pending" || task?.status === "failed");
  queue.completed = typeof queue.completed === "number" && Number.isFinite(queue.completed) ? queue.completed : 0;
  if (queue.active && typeof queue.active.sessionId !== "string")
    queue.active = null;
  return queue;
};

// service/main.ts
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!PORT || !TOKEN) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var TICK_MS = 5000;
var REQUEST_TIMEOUT_MS = 8000;
var SESSION_LIMIT = 30;
var MAX_STEPS_PER_TICK = 4;
var WAIT_MAX_MS = 2000;
var WAIT_MIN_MS = 500;
var HOST_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), ".config", "openchamber");
var STATE_DIR = process.env.OPENCHAMBER_QUEUE_DATA_DIR || path.join(os.homedir(), ".config", "openchamber-queue");
var STATE_FILE = path.join(STATE_DIR, "state.json");
var state = emptyState();
var writeChain = Promise.resolve();
var readState = async () => {
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return emptyState();
    parsed.projects ??= {};
    parsed.queues ??= {};
    for (const queue of Object.values(parsed.queues)) {
      if (queue && typeof queue === "object")
        repairQueue(queue);
    }
    return parsed;
  } catch {
    return emptyState();
  }
};
var persist = () => {
  writeChain = writeChain.then(async () => {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(STATE_DIR, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fsp.rename(tmp, STATE_FILE);
    } catch (error) {
      console.error("[queue] failed to persist state", error);
    }
  });
  return writeChain;
};
var EVENT_LOG_MAX = 100;
var log = [];
var seq = 0;
var subscribers = new Set;
var snapshotQueue = (queue) => JSON.parse(JSON.stringify(queue));
var subscribe = (listener) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};
var emit = (projectId, type) => {
  seq += 1;
  const event = {
    seq,
    at: Date.now(),
    projectId,
    type,
    queue: snapshotQueue(getQueue(state, projectId))
  };
  log.push(event);
  if (log.length > EVENT_LOG_MAX)
    log.splice(0, log.length - EVENT_LOG_MAX);
  for (const listener of [...subscribers])
    listener(event);
};
var eventsAfter = (after, projectId) => {
  const oldest = log.length > 0 ? log[0].seq : seq + 1;
  if (after > seq || after < oldest - 1)
    return { reset: true };
  return { events: log.filter((event) => event.seq > after && (!projectId || event.projectId === projectId)) };
};
var PARKED_GRACE_MS = 1000;
var parked = null;
var target = null;
var withTimeout = (url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
var isHealthy = async (port) => {
  try {
    const response = await withTimeout(`http://127.0.0.1:${port}/health`, {}, 1500);
    return response.ok;
  } catch {
    return false;
  }
};
var readInstancePassword = async (port) => {
  try {
    const raw = await fsp.readFile(path.join(HOST_DATA_DIR, "run", `openchamber-${port}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.uiPassword === "string" && parsed.uiPassword ? parsed.uiPassword : null;
  } catch {
    return null;
  }
};
var readDesktop = async () => {
  try {
    const raw = await fsp.readFile(path.join(HOST_DATA_DIR, "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      port: Number.isFinite(parsed.desktopLocalPort) ? Number(parsed.desktopLocalPort) : null,
      token: typeof parsed.desktopLocalClientToken === "string" ? parsed.desktopLocalClientToken : null
    };
  } catch {
    return { port: null, token: null };
  }
};
var candidatePorts = async () => {
  const ports = [];
  const desktop = await readDesktop();
  if (desktop.port)
    ports.push(desktop.port);
  try {
    const entries = await fsp.readdir(path.join(HOST_DATA_DIR, "run"));
    for (const name of entries) {
      const match = /^openchamber-(\d+)\.json$/.exec(name);
      if (match)
        ports.push(Number(match[1]));
    }
  } catch {}
  if (!ports.includes(3000))
    ports.push(3000);
  return [...new Set(ports)];
};
var login = async (base, password) => {
  try {
    const response = await withTimeout(`${base}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok)
      return null;
    const header = response.headers.get("set-cookie");
    if (!header)
      return null;
    const match = header.match(/oc_ui_session(?:_\d+)?=[^;]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
};
var ensureTarget = async () => {
  if (target)
    return target;
  const desktop = await readDesktop();
  for (const port of await candidatePorts()) {
    if (!await isHealthy(port))
      continue;
    const base = `http://127.0.0.1:${port}`;
    const bearer = desktop.port === port ? desktop.token : null;
    const password = await readInstancePassword(port);
    const cookie = password ? await login(base, password) : null;
    target = { base, cookie, bearer };
    return target;
  }
  return null;
};
var authHeaders = (current) => {
  const headers = { Accept: "application/json" };
  if (current.cookie)
    headers.Cookie = current.cookie;
  if (!current.cookie && current.bearer)
    headers.Authorization = `Bearer ${current.bearer}`;
  return headers;
};
var serverGet = async (pathname, directory) => {
  const current = await ensureTarget();
  if (!current)
    return { ok: false, error: "OpenChamber server not reachable" };
  try {
    const response = await withTimeout(`${current.base}${pathname}`, {
      headers: { ...authHeaders(current), ...directory ? { "x-opencode-directory": directory } : {} }
    });
    if (response.status === 401) {
      target = null;
      return { ok: false, error: "unauthorized" };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok)
      return { ok: false, error: `GET ${pathname} failed (${response.status})` };
    return { ok: true, body };
  } catch (error) {
    target = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
var control = async (action, input) => {
  const current = await ensureTarget();
  if (!current)
    return { ok: false, error: "OpenChamber server not reachable" };
  try {
    const response = await withTimeout(`${current.base}/api/openchamber/control`, {
      method: "POST",
      headers: { ...authHeaders(current), "Content-Type": "application/json" },
      body: JSON.stringify({ action, input })
    });
    if (response.status === 401) {
      target = null;
      return { ok: false, error: "unauthorized" };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.error === "string" ? body.error : `control ${action} failed (${response.status})`;
      return { ok: false, error: message };
    }
    return { ok: true, body };
  } catch (error) {
    target = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
var isStatusIdle = (session) => {
  const type = session?.status?.type;
  return !type || type === "idle";
};
var listSessions = async (directory) => {
  const result = await control("session.list", { directory, limit: SESSION_LIMIT, all: false, withStatus: true });
  if (!result.ok)
    return null;
  return Array.isArray(result.body?.sessions) ? result.body.sessions : [];
};
var hasPending = (result) => result.ok && Array.isArray(result.body?.data) && result.body.data.length > 0;
var sessionActivity = async (session, directory) => {
  if (isStatusIdle(session))
    return "idle";
  const [permission, form] = await Promise.all([
    serverGet(`/api/session/${encodeURIComponent(session.id)}/permission`, directory),
    serverGet(`/api/session/${encodeURIComponent(session.id)}/form`, directory)
  ]);
  if (hasPending(permission))
    return "waiting-permission";
  if (hasPending(form))
    return "waiting-question";
  const type = session?.status?.type;
  return type === "retry" || type === "retrying" ? "retrying" : "running";
};
var observe = async (directory, sessions, active) => {
  if (active) {
    return { activeStatus: await activeStatusFor(active, sessions, directory), projectBusy: false };
  }
  const activities = new Map;
  const busy = sessions.filter((session) => !session?.archivedAt && !isStatusIdle(session));
  await Promise.all(busy.map(async (session) => {
    activities.set(session.id, await sessionActivity(session, directory));
  }));
  return {
    activeStatus: "free",
    projectBusy: [...activities.values()].some(isOccupied)
  };
};
var activeStatusFor = async (active, sessions, directory) => {
  const session = sessions.find((entry) => entry?.id === active.sessionId);
  if (!session) {
    return Date.now() - active.startedAt < ACTIVE_GRACE_MS ? "running" : "free";
  }
  if (session.archivedAt)
    return "free";
  return isOccupied(await sessionActivity(session, directory)) ? "running" : "free";
};
var dispatch = async (projectId, directory, task) => {
  const title = deriveTitle(task.text);
  const result = await control("session.create", { directory, prompt: task.text, title });
  if (result.ok && typeof result.body?.sessionId === "string") {
    startTask(state, projectId, task.id, result.body.sessionId);
    return "run.started";
  }
  markFailed(state, projectId, task.id, result.ok ? "session.create returned no session id" : result.error);
  return "task.failed";
};
var runTask = async (projectId, taskId) => {
  const info = state.projects[projectId];
  const task = getQueue(state, projectId).tasks.find((entry) => entry.id === taskId);
  if (!info || !task)
    return;
  const type = await dispatch(projectId, info.directory, task);
  await persist();
  emit(projectId, type);
};
var runNow = async (projectId, text) => {
  const info = state.projects[projectId];
  const trimmed = text.trim();
  if (!info || !trimmed)
    return;
  const result = await control("session.create", {
    directory: info.directory,
    prompt: trimmed,
    title: deriveTitle(trimmed)
  });
  if (!result.ok)
    console.error("[queue] run-now failed", result.error);
};
var queueHasWork = (queue) => queue.active !== null || queue.enabled && firstPending(queue) !== null;
var freeSince = new Map;
var dispatchChecks = new Map;
var cancelDispatchCheck = (projectId) => {
  const timer = dispatchChecks.get(projectId);
  if (timer)
    clearTimeout(timer);
  dispatchChecks.delete(projectId);
};
var trackIdle = (projectId, free, now) => {
  if (!free) {
    freeSince.delete(projectId);
    return 0;
  }
  const since = freeSince.get(projectId) ?? now;
  freeSince.set(projectId, since);
  return now - since;
};
var scheduleDispatchCheck = (projectId) => {
  const since = freeSince.get(projectId);
  if (since === undefined)
    return;
  const delayMs = Math.max(0, since + DISPATCH_DELAY_MS - Date.now());
  cancelDispatchCheck(projectId);
  const timer = setTimeout(() => {
    dispatchChecks.delete(projectId);
    evaluateProject(projectId);
  }, delayMs);
  timer.unref?.();
  dispatchChecks.set(projectId, timer);
};
var runProject = async (projectId) => {
  const info = state.projects[projectId];
  if (!info)
    return [];
  const types = [];
  if (!queueHasWork(getQueue(state, projectId))) {
    freeSince.delete(projectId);
    cancelDispatchCheck(projectId);
    return types;
  }
  for (let step = 0;step < MAX_STEPS_PER_TICK; step += 1) {
    const queue = getQueue(state, projectId);
    if (!queueHasWork(queue))
      break;
    const sessions = await listSessions(info.directory);
    if (!sessions)
      break;
    const observation = await observe(info.directory, sessions, queue.active);
    const now = Date.now();
    const free = queue.active === null && !observation.projectBusy;
    const decision = planTick(queue, { ...observation, idleMs: trackIdle(projectId, free, now) });
    if (decision.kind === "finish") {
      finishRun(state, projectId);
      types.push("run.finished");
      continue;
    }
    if (decision.kind === "dispatch") {
      cancelDispatchCheck(projectId);
      const task = queue.tasks.find((entry) => entry.id === decision.taskId);
      if (!task)
        break;
      types.push(await dispatch(projectId, info.directory, task));
      break;
    }
    if (free && firstPending(queue))
      scheduleDispatchCheck(projectId);
    else
      cancelDispatchCheck(projectId);
    break;
  }
  return types;
};
var tickingProjects = new Set;
var tickProject = async (projectId) => {
  if (tickingProjects.has(projectId))
    return false;
  tickingProjects.add(projectId);
  try {
    const types = await runProject(projectId);
    for (const type of types)
      emit(projectId, type);
    return types.length > 0;
  } finally {
    tickingProjects.delete(projectId);
  }
};
var projectsWithWork = () => Object.keys(state.projects).filter((projectId) => queueHasWork(getQueue(state, projectId)));
var tick = async () => {
  let mutated = false;
  try {
    for (const projectId of projectsWithWork()) {
      if (await tickProject(projectId))
        mutated = true;
    }
  } catch (error) {
    console.error("[queue] tick failed", error);
  }
  if (mutated)
    await persist();
};
var evaluateProject = (projectId) => {
  (async () => {
    try {
      if (await tickProject(projectId))
        await persist();
    } catch (error) {
      console.error("[queue] tick failed", error);
    }
  })();
};
var COMMAND_EVENTS = {
  register: "project.registered",
  enqueue: "task.enqueued",
  edit: "task.edited",
  remove: "task.removed",
  move: "task.moved",
  retry: "task.retried",
  clear: "queue.cleared",
  "set-enabled": "queue.enabled"
};
var applyCommand = async (command) => {
  const projectId = command.projectId;
  if (!projectId)
    return false;
  switch (command.op) {
    case "register":
      if (!command.directory)
        return false;
      return registerProject(state, { id: projectId, directory: command.directory, name: command.name ?? projectId });
    case "enqueue":
      return enqueue(state, projectId, command.text ?? "") !== null;
    case "edit":
      return editTask(state, projectId, command.taskId ?? "", command.text ?? "");
    case "remove":
      return removeTask(state, projectId, command.taskId ?? "");
    case "move":
      return moveTask(state, projectId, command.taskId ?? "", command.direction ?? "top");
    case "run":
      await runTask(projectId, command.taskId ?? "");
      return false;
    case "retry":
      return retryTask(state, projectId, command.taskId ?? "");
    case "clear":
      return clearTasks(state, projectId);
    case "set-enabled":
      return setEnabled(state, projectId, command.enabled === true);
    case "run-now":
      await runNow(projectId, command.text ?? "");
      return false;
    case "tick":
      await tick();
      return false;
    default:
      return false;
  }
};
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2000000)
      reject(new Error("request too large"));
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
var summarize = (queue) => countTasks(queue);
var server = http.createServer((req, res) => {
  (async () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      json(res, 200, { ok: true, pid: process.pid });
      return;
    }
    if (url.pathname === "/state") {
      const projectId = url.searchParams.get("projectId") ?? "";
      const queue = getQueue(state, projectId);
      const snapshot = {
        project: state.projects[projectId] ?? null,
        queue,
        seq
      };
      json(res, 200, { backend: true, projectId, ...snapshot, counts: summarize(queue) });
      return;
    }
    if (url.pathname === "/events") {
      const projectId = url.searchParams.get("projectId");
      const after = Number(url.searchParams.get("after") ?? "0");
      const requested = Number(url.searchParams.get("wait") ?? WAIT_MAX_MS);
      const hold = Number.isFinite(requested) ? Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, requested)) : WAIT_MAX_MS;
      const answer = (payload) => {
        const queue = getQueue(state, projectId ?? "");
        json(res, 200, {
          backend: true,
          ...projectId ? { projectId, queue, counts: summarize(queue) } : {},
          seq,
          events: [],
          ...payload
        });
      };
      const pending = eventsAfter(after, projectId);
      if ("reset" in pending) {
        answer({ reset: true });
        return;
      }
      if (pending.events.length > 0) {
        answer({ events: pending.events });
        return;
      }
      let settled = false;
      let timer = null;
      let unsubscribe = null;
      const finish = (payload) => {
        if (settled)
          return;
        settled = true;
        if (timer !== null)
          clearTimeout(timer);
        unsubscribe?.();
        if (parked?.settle === finish)
          parked = null;
        if (payload)
          answer(payload);
      };
      if (parked && Date.now() - parked.at >= PARKED_GRACE_MS) {
        const previous = parked;
        parked = null;
        previous.settle({ superseded: true });
      }
      unsubscribe = subscribe((event) => finish({ events: [event] }));
      parked = { at: Date.now(), settle: finish };
      timer = setTimeout(() => finish({}), hold);
      timer.unref?.();
      res.on("close", () => finish(null));
      return;
    }
    if (url.pathname === "/events/stream") {
      const projectId = url.searchParams.get("projectId");
      const after = Number(url.searchParams.get("after") ?? "0");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      res.write(`retry: 2000

`);
      let unsubscribe = null;
      let heartbeat = null;
      const stop = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null)
          clearInterval(heartbeat);
        heartbeat = null;
      };
      const send = (event) => {
        if (projectId && event.projectId !== projectId)
          return;
        res.write(`id: ${event.seq}
event: ${event.type}
data: ${JSON.stringify(event)}

`);
      };
      const pending = eventsAfter(after, projectId);
      if ("reset" in pending) {
        const queue = projectId ? getQueue(state, projectId) : null;
        res.write(`event: reset
data: ${JSON.stringify({ seq, ...queue ? { queue, counts: summarize(queue) } : {} })}

`);
      } else {
        for (const event of pending.events)
          send(event);
      }
      unsubscribe = subscribe(send);
      heartbeat = setInterval(() => res.write(`: ping

`), 15000);
      heartbeat.unref?.();
      res.on("close", stop);
      return;
    }
    if (url.pathname === "/all") {
      json(res, 200, {
        backend: true,
        state,
        counts: Object.fromEntries(Object.keys(state.queues).map((id) => [id, summarize(state.queues[id])]))
      });
      return;
    }
    if (url.pathname === "/cmd" && req.method === "POST") {
      const raw = await readBody(req);
      const command = JSON.parse(raw || "{}");
      const changed = await applyCommand(command);
      if (command.op !== "tick" && changed) {
        await persist();
        const type = command.projectId ? COMMAND_EVENTS[command.op] : undefined;
        if (type && command.projectId)
          emit(command.projectId, type);
        if (command.projectId)
          evaluateProject(command.projectId);
      }
      const projectId = command.projectId ?? "";
      const queue = command.projectId ? getQueue(state, projectId) : null;
      json(res, 200, {
        ok: true,
        seq,
        queue: queue ?? undefined,
        counts: queue ? summarize(queue) : undefined
      });
      return;
    }
    json(res, 404, { error: "not-found" });
  })().catch((error) => {
    console.error("[queue] request failed", error);
    json(res, 500, { error: error instanceof Error ? error.message : "failed" });
  });
});
server.listen(PORT, "127.0.0.1");
(async () => {
  state = await readState();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  tick();
})();
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
