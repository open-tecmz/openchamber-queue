// service/main.ts
import http from "node:http";
import fsp2 from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";

// src/core.ts
var MAX_IMAGES_PER_TASK = 4;
var IMAGE_ID = /^img_[A-Za-z0-9_-]{1,64}$/;
var sanitizeImage = (value) => {
  if (!value || typeof value !== "object")
    return null;
  const image = value;
  if (typeof image.id !== "string" || !IMAGE_ID.test(image.id))
    return null;
  if (typeof image.name !== "string")
    return null;
  if (typeof image.mime !== "string")
    return null;
  if (typeof image.size !== "number" || !Number.isFinite(image.size) || image.size <= 0)
    return null;
  return {
    id: image.id,
    name: image.name.slice(0, 200),
    mime: image.mime.slice(0, 100),
    size: image.size
  };
};
var sanitizeImages = (value) => {
  if (!Array.isArray(value))
    return [];
  const images = [];
  const seen = new Set;
  for (const entry of value) {
    const image = sanitizeImage(entry);
    if (!image || seen.has(image.id))
      continue;
    seen.add(image.id);
    images.push(image);
    if (images.length >= MAX_IMAGES_PER_TASK)
      break;
  }
  return images;
};
var sanitizeTarget = (value) => {
  if (!value || typeof value !== "object")
    return;
  const target = value;
  if (typeof target.sessionId !== "string" || !target.sessionId.trim())
    return;
  const sessionId = target.sessionId.trim().slice(0, 256);
  const title = typeof target.title === "string" && target.title.trim() ? target.title.trim().slice(0, 200) : undefined;
  return title ? { sessionId, title } : { sessionId };
};
var STATE_VERSION = 1;
var ACTIVE_GRACE_MS = 15000;
var DISPATCH_DELAY_MS = 30000;
var QUESTION_DISPATCH_DELAY_MS = 300000;
var BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
var MIN_DELAY_MS = 1000;
var MAX_DELAY_MS = 24 * 60 * 60 * 1000;
var DEFAULT_IDLE_POLICY = {
  questionBlocks: false,
  permissionBlocks: true,
  backgroundBlocks: true,
  otherSessionsBlock: true
};
var MAX_CONSECUTIVE_FAILURES = 2;
var MAX_FAILURES_LIMIT = 1000;
var DEFAULT_QUEUE_SETTINGS = {
  dispatchDelayMs: DISPATCH_DELAY_MS,
  questionDelayMs: QUESTION_DISPATCH_DELAY_MS,
  backgroundTimeoutMs: BACKGROUND_TIMEOUT_MS,
  maxFailures: MAX_CONSECUTIVE_FAILURES,
  idle: DEFAULT_IDLE_POLICY
};
var sanitizeDelay = (value, fallback) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    return fallback;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(value)));
};
var sanitizeFailureLimit = (value, fallback) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    return fallback;
  return Math.min(MAX_FAILURES_LIMIT, Math.max(0, Math.round(value)));
};
var sanitizeBackgroundTimeout = (value, fallback) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    return fallback;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(value)));
};
var sanitizeFlag = (value, fallback) => typeof value === "boolean" ? value : fallback;
var sanitizeSettings = (value, fallback = DEFAULT_QUEUE_SETTINGS) => {
  const raw = value && typeof value === "object" ? value : {};
  const idle = raw.idle && typeof raw.idle === "object" ? raw.idle : {};
  return {
    dispatchDelayMs: sanitizeDelay(raw.dispatchDelayMs, fallback.dispatchDelayMs),
    questionDelayMs: sanitizeDelay(raw.questionDelayMs, fallback.questionDelayMs),
    backgroundTimeoutMs: sanitizeBackgroundTimeout(raw.backgroundTimeoutMs, fallback.backgroundTimeoutMs),
    maxFailures: sanitizeFailureLimit(raw.maxFailures, fallback.maxFailures),
    idle: {
      questionBlocks: sanitizeFlag(idle.questionBlocks, fallback.idle.questionBlocks),
      permissionBlocks: sanitizeFlag(idle.permissionBlocks, fallback.idle.permissionBlocks),
      backgroundBlocks: sanitizeFlag(idle.backgroundBlocks, fallback.idle.backgroundBlocks),
      otherSessionsBlock: sanitizeFlag(idle.otherSessionsBlock, fallback.idle.otherSessionsBlock)
    }
  };
};
var sameSettings = (left, right) => left.dispatchDelayMs === right.dispatchDelayMs && left.questionDelayMs === right.questionDelayMs && left.backgroundTimeoutMs === right.backgroundTimeoutMs && left.maxFailures === right.maxFailures && left.idle.questionBlocks === right.idle.questionBlocks && left.idle.permissionBlocks === right.idle.permissionBlocks && left.idle.backgroundBlocks === right.idle.backgroundBlocks && left.idle.otherSessionsBlock === right.idle.otherSessionsBlock;
var settingsOf = (queue, fallback = DEFAULT_QUEUE_SETTINGS) => queue.settings ?? fallback;
var updateSettings = (state, projectId, patch, defaults = DEFAULT_QUEUE_SETTINGS) => {
  const queue = ensureQueue(state, projectId);
  const base = settingsOf(queue, defaults);
  const next = sanitizeSettings({
    dispatchDelayMs: patch.dispatchDelayMs ?? base.dispatchDelayMs,
    questionDelayMs: patch.questionDelayMs ?? base.questionDelayMs,
    backgroundTimeoutMs: patch.backgroundTimeoutMs ?? base.backgroundTimeoutMs,
    maxFailures: patch.maxFailures ?? base.maxFailures,
    idle: { ...base.idle, ...patch.idle ?? {} }
  }, defaults);
  if (queue.settings ? sameSettings(next, queue.settings) : sameSettings(next, defaults))
    return false;
  queue.settings = next;
  return true;
};
var emptyState = () => ({
  version: STATE_VERSION,
  projects: {},
  queues: {},
  drafts: {}
});
var emptyQueue = () => ({
  enabled: false,
  completed: 0,
  tasks: [],
  active: null
});
var emptyDraft = () => ({ text: "", images: [] });
var noteFailure = (state, projectId, cause, detail, settings, now = Date.now()) => {
  const queue = ensureQueue(state, projectId);
  const guard = queue.guard ?? (queue.guard = { failures: 0 });
  if (guard.pause)
    return null;
  if (settings.maxFailures <= 0)
    return null;
  guard.failures += 1;
  if (guard.failures < settings.maxFailures)
    return null;
  const pause = { at: now, cause, detail };
  guard.pause = pause;
  return pause;
};
var noteHealthyRun = (state, projectId) => {
  const guard = state.queues[projectId]?.guard;
  if (!guard || guard.pause)
    return;
  guard.failures = 0;
};
var clearPause = (state, projectId, resetFailures = true) => {
  const guard = state.queues[projectId]?.guard;
  if (!guard?.pause)
    return false;
  delete guard.pause;
  if (resetFailures)
    guard.failures = 0;
  return true;
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
var getDraft = (state, projectId, fallback = emptyDraft()) => {
  if (!projectId)
    return { text: fallback.text, images: [...fallback.images] };
  const draft = state.drafts[projectId];
  if (!draft)
    return { text: fallback.text, images: [...fallback.images] };
  return { text: draft.text, images: [...draft.images] };
};
var setDraft = (state, projectId, draft) => {
  if (!projectId)
    return false;
  const next = { text: draft.text, images: sanitizeImages(draft.images) };
  const current = state.drafts[projectId];
  if (current && current.text === next.text && sameImages(current.images, next.images))
    return false;
  state.drafts[projectId] = next;
  return true;
};
var sameImages = (left, right) => left.length === right.length && left.every((image, index) => image.id === right[index].id && image.name === right[index].name && image.mime === right[index].mime && image.size === right[index].size);
var makeTask = (text, options = {}) => {
  const task = {
    id: nextId(),
    text: text.trim(),
    images: sanitizeImages(options.images),
    status: "pending",
    enabled: options.enabled !== false,
    createdAt: options.now ?? Date.now(),
    finishedAt: null,
    error: null
  };
  const target = sanitizeTarget(options.target);
  if (target)
    task.target = target;
  return task;
};
var enqueue = (state, projectId, text, options = {}) => {
  const trimmed = text.trim();
  if (!trimmed)
    return null;
  const task = makeTask(trimmed, options);
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
var editTask = (state, projectId, taskId, text, images) => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  const trimmed = text.trim();
  if (!queue || !task || !trimmed)
    return false;
  task.text = trimmed;
  if (images !== undefined)
    task.images = sanitizeImages(images);
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
var setTaskEnabled = (state, projectId, taskId, enabled) => {
  const task = state.queues[projectId]?.tasks.find((entry) => entry.id === taskId);
  if (!task || task.enabled === enabled)
    return false;
  task.enabled = enabled;
  return true;
};
var clearTasks = (state, projectId) => {
  const queue = state.queues[projectId];
  if (!queue)
    return false;
  queue.tasks = [];
  normalizeQueue(queue);
  const guard = queue.guard;
  if (guard) {
    delete guard.pause;
    guard.failures = 0;
  }
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
var firstPending = (queue) => queue.tasks.find((task) => task.status === "pending" && task.enabled) ?? null;
var startTask = (state, projectId, taskId, sessionId, options = {}) => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  if (!queue || !task)
    return;
  queue.tasks = queue.tasks.filter((entry) => entry.id !== taskId);
  queue.completed += 1;
  queue.active = {
    sessionId,
    startedAt: options.now ?? Date.now(),
    taskId,
    ...options.baselineAt !== undefined ? { baselineAt: options.baselineAt } : {}
  };
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
var isOccupied = (activity, policy = DEFAULT_IDLE_POLICY) => {
  switch (activity) {
    case "running":
    case "retrying":
      return true;
    case "waiting-permission":
      return policy.permissionBlocks;
    case "waiting-question":
      return policy.questionBlocks;
    case "background":
      return policy.backgroundBlocks;
    default:
      return false;
  }
};
var planTick = (queue, observation) => {
  if (queue.active) {
    return observation.activeStatus === "running" ? { kind: "wait" } : { kind: "finish" };
  }
  if (queue.guard?.pause)
    return { kind: "wait" };
  if (observation.projectBusy)
    return { kind: "wait" };
  if (observation.idleMs < (observation.settleMs ?? DISPATCH_DELAY_MS))
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
  queue.tasks = (queue.tasks ?? []).filter((task) => task?.status === "pending" || task?.status === "failed").map((task) => {
    const next = {
      ...task,
      images: sanitizeImages(task?.images),
      enabled: task?.enabled !== false
    };
    const target = sanitizeTarget(task?.target);
    if (target)
      next.target = target;
    else
      delete next.target;
    return next;
  });
  queue.completed = typeof queue.completed === "number" && Number.isFinite(queue.completed) ? queue.completed : 0;
  if (queue.active && typeof queue.active.sessionId !== "string")
    queue.active = null;
  if (queue.active && queue.active.taskId !== undefined && typeof queue.active.taskId !== "string") {
    delete queue.active.taskId;
  }
  if (queue.active && queue.active.baselineAt !== undefined && (typeof queue.active.baselineAt !== "number" || !Number.isFinite(queue.active.baselineAt))) {
    delete queue.active.baselineAt;
  }
  if (queue.active && "task" in queue.active) {
    delete queue.active.task;
  }
  if (queue.settings !== undefined)
    queue.settings = sanitizeSettings(queue.settings);
  if (queue.guard !== undefined)
    queue.guard = repairGuard(queue.guard);
  return queue;
};
var repairGuard = (value) => {
  const raw = value && typeof value === "object" ? value : {};
  const guard = {
    failures: typeof raw.failures === "number" && Number.isFinite(raw.failures) ? Math.max(0, Math.round(raw.failures)) : 0
  };
  const pause = raw.pause;
  if (pause && typeof pause.at === "number" && Number.isFinite(pause.at) && typeof pause.detail === "string") {
    guard.pause = {
      at: pause.at,
      cause: pause.cause === "dispatch" ? "dispatch" : "run",
      detail: pause.detail
    };
  }
  return guard;
};
var repairState = (state) => {
  state.projects ??= {};
  state.queues ??= {};
  state.drafts ??= {};
  for (const queue of Object.values(state.queues)) {
    if (queue && typeof queue === "object")
      repairQueue(queue);
  }
  const drafts = {};
  for (const [projectId, stored] of Object.entries(state.drafts)) {
    if (typeof stored === "string") {
      drafts[projectId] = { text: stored, images: [] };
      continue;
    }
    if (stored && typeof stored === "object") {
      const draft = stored;
      drafts[projectId] = {
        text: typeof draft.text === "string" ? draft.text : "",
        images: sanitizeImages(draft.images)
      };
    }
  }
  state.drafts = drafts;
  return state;
};
var referencedImageIds = (state) => {
  const ids = new Set;
  for (const queue of Object.values(state.queues ?? {})) {
    for (const task of queue?.tasks ?? []) {
      for (const image of task?.images ?? [])
        ids.add(image.id);
    }
  }
  for (const draft of Object.values(state.drafts ?? {})) {
    for (const image of draft?.images ?? [])
      ids.add(image.id);
  }
  return ids;
};

// service/log.ts
import fsp from "node:fs/promises";
import path from "node:path";
var DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
var DEFAULT_KEEP = 5;
var ACTIVE_NAME = "service.log";
var pad = (value, width = 2) => String(value).padStart(width, "0");
var stamp = () => {
  const now = new Date;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};
var describe = (detail) => {
  if (detail === undefined)
    return "";
  if (detail instanceof Error)
    return ` ${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  if (typeof detail === "string")
    return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
};
var exists = (file) => fsp.stat(file).then(() => true).catch(() => false);
var createLogger = (dir, options = {}) => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = Math.max(0, options.keep ?? DEFAULT_KEEP);
  const mirror = options.mirror ?? true;
  const active = path.join(dir, ACTIVE_NAME);
  const backupRe = /^service-(\d+)(?:-\d+)?\.log$/;
  let started = null;
  let size = 0;
  let broken = false;
  let chain = Promise.resolve();
  const start = () => {
    if (!started) {
      started = (async () => {
        await fsp.mkdir(dir, { recursive: true });
        const info = await fsp.stat(active).catch(() => null);
        size = info?.size ?? 0;
      })().catch(() => {
        broken = true;
      });
    }
    return started;
  };
  const prune = async () => {
    if (keep <= 0)
      return;
    const names = await fsp.readdir(dir).catch(() => []);
    const backups = names.map((name) => {
      const match = backupRe.exec(name);
      return match ? { name, at: Number(match[1]) } : null;
    }).filter((entry) => entry !== null).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    await Promise.all(backups.slice(keep).map((entry) => fsp.rm(path.join(dir, entry.name), { force: true }).catch(() => {})));
  };
  const rotate = async () => {
    const at = Date.now();
    let target = path.join(dir, `service-${at}.log`);
    for (let n = 1;await exists(target); n += 1)
      target = path.join(dir, `service-${at}-${n}.log`);
    try {
      await fsp.rename(active, target);
    } catch {
      await fsp.writeFile(active, "");
    }
    size = 0;
    await prune();
  };
  const write = (level, message, detail) => {
    const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}${describe(detail)}
`;
    if (mirror) {
      if (level === "info")
        process.stdout.write(line);
      else
        process.stderr.write(line);
    }
    if (broken)
      return;
    const bytes = Buffer.byteLength(line);
    chain = chain.then(async () => {
      await start();
      if (broken)
        return;
      try {
        if (size > 0 && size + bytes > maxBytes)
          await rotate();
        await fsp.appendFile(active, line, "utf8");
        size += bytes;
      } catch {
        broken = true;
      }
    });
  };
  return {
    info: (message, detail) => write("info", message, detail),
    warn: (message, detail) => write("warn", message, detail),
    error: (message, detail) => write("error", message, detail),
    flush: () => chain.catch(() => {}),
    file: active
  };
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
var DISPATCH_TIMEOUT_MS = 60000;
var SESSION_LIMIT = 30;
var MAX_STEPS_PER_TICK = 4;
var WAIT_MAX_MS = 2000;
var WAIT_MIN_MS = 500;
var HOST_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR || path2.join(os.homedir(), ".config", "openchamber");
var STATE_DIR = process.env.OPENCHAMBER_QUEUE_DATA_DIR || path2.join(os.homedir(), ".config", "openchamber-queue");
var STATE_FILE = path2.join(STATE_DIR, "state.json");
var LOG_DIR = process.env.OPENCHAMBER_QUEUE_LOG_DIR || path2.join(STATE_DIR, "logs");
var logger = createLogger(LOG_DIR);
var state = emptyState();
var writeChain = Promise.resolve();
var readState = async () => {
  try {
    const raw = await fsp2.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return emptyState();
    return repairState(parsed);
  } catch {
    return emptyState();
  }
};
var persist = () => {
  writeChain = writeChain.then(async () => {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      await fsp2.mkdir(STATE_DIR, { recursive: true });
      await fsp2.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fsp2.rename(tmp, STATE_FILE);
    } catch (error) {
      logger.error("[queue] failed to persist state", error);
    }
  });
  return writeChain;
};
var IMAGE_DIR = path2.join(STATE_DIR, "images");
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var MAX_IMAGE_CHUNK_CHARS = 48000;
var MAX_THUMB_CHARS = 200000;
var IMAGE_ORPHAN_MS = (() => {
  const override = Number(process.env.OPENCHAMBER_QUEUE_IMAGE_ORPHAN_MS);
  return Number.isFinite(override) && override > 0 ? override : 10 * 60 * 1000;
})();
var envDelayMs = (name, fallback) => {
  const override = Number(process.env[name]);
  return Number.isFinite(override) && override > 0 ? override : fallback;
};
var DISPATCH_MS = envDelayMs("OPENCHAMBER_QUEUE_DISPATCH_MS", DISPATCH_DELAY_MS);
var QUESTION_DISPATCH_MS = envDelayMs("OPENCHAMBER_QUEUE_QUESTION_DISPATCH_MS", QUESTION_DISPATCH_DELAY_MS);
var SERVICE_SETTINGS = {
  ...DEFAULT_QUEUE_SETTINGS,
  dispatchDelayMs: DISPATCH_MS,
  questionDelayMs: QUESTION_DISPATCH_MS,
  idle: { ...DEFAULT_QUEUE_SETTINGS.idle }
};
var queueSettings = (queue) => settingsOf(queue, SERVICE_SETTINGS);
var SWEEP_INTERVAL_MS = 5 * 60 * 1000;
var uploads = new Map;
var orphans = new Map;
var imagePath = (id, suffix = "") => path2.join(IMAGE_DIR, `${id}${suffix}`);
var isImageId = (value) => typeof value === "string" && IMAGE_ID.test(value);
var readJson = async (file) => {
  try {
    return JSON.parse(await fsp2.readFile(file, "utf8"));
  } catch {
    return null;
  }
};
var sweepImages = async () => {
  let entries;
  try {
    entries = await fsp2.readdir(IMAGE_DIR);
  } catch {
    return;
  }
  const referenced = referencedImageIds(state);
  const now = Date.now();
  for (const entry of entries) {
    const id = entry.replace(/\.(part|thumb)$/, "");
    if (referenced.has(id) || uploads.has(id)) {
      orphans.delete(id);
      continue;
    }
    const since = orphans.get(id);
    if (since === undefined) {
      orphans.set(id, now);
      continue;
    }
    if (now - since < IMAGE_ORPHAN_MS)
      continue;
    orphans.delete(id);
    await fsp2.rm(path2.join(IMAGE_DIR, entry), { force: true }).catch(() => {
      return;
    });
  }
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
    const raw = await fsp2.readFile(path2.join(HOST_DATA_DIR, "run", `openchamber-${port}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.uiPassword === "string" && parsed.uiPassword ? parsed.uiPassword : null;
  } catch {
    return null;
  }
};
var readDesktop = async () => {
  try {
    const raw = await fsp2.readFile(path2.join(HOST_DATA_DIR, "settings.json"), "utf8");
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
    const entries = await fsp2.readdir(path2.join(HOST_DATA_DIR, "run"));
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
    logger.info("[queue] connected to OpenChamber", { base, authenticated: cookie !== null || bearer !== null });
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
var serverPost = async (pathname, directory, body, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const current = await ensureTarget();
  if (!current)
    return { ok: false, error: "OpenChamber server not reachable" };
  try {
    const response = await withTimeout(`${current.base}${pathname}`, {
      method: "POST",
      headers: {
        ...authHeaders(current),
        "Content-Type": "application/json",
        ...directory ? { "x-opencode-directory": directory } : {}
      },
      body: JSON.stringify(body)
    }, timeoutMs);
    if (response.status === 401) {
      target = null;
      return { ok: false, error: "unauthorized" };
    }
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof parsed?.error === "string" ? parsed.error : `POST ${pathname} failed (${response.status})`;
      return { ok: false, error: message };
    }
    return { ok: true, body: parsed };
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
var asPid = (value) => {
  const pid = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};
var pidAlive = (pid) => {
  if (pid === null)
    return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
var runningShells = async (directory) => {
  const shells = new Map;
  const result = await serverGet("/api/shell", directory);
  if (!result.ok)
    return shells;
  const data = Array.isArray(result.body?.data) ? result.body.data : [];
  for (const shell of data) {
    if (typeof shell?.status === "string" && shell.status !== "running")
      continue;
    const sessionId = shell?.metadata?.sessionID;
    if (typeof sessionId !== "string" || !sessionId)
      continue;
    const pid = asPid(shell?.pid);
    if (!pidAlive(pid))
      continue;
    const list = shells.get(sessionId) ?? [];
    list.push({
      id: typeof shell.id === "string" ? shell.id : `${sessionId}:${list.length}`,
      command: typeof shell.command === "string" ? shell.command : "",
      pid
    });
    shells.set(sessionId, list);
  }
  return shells;
};
var backgroundSince = new Map;
var backgroundGivenUp = new Map;
var clearBackgroundClocks = (sessions) => {
  for (const session of sessions) {
    const id = session?.id;
    if (typeof id !== "string")
      continue;
    backgroundSince.delete(id);
    backgroundGivenUp.delete(id);
  }
};
var backgroundHolders = (projectId, shells, paused, limitMs, now) => {
  const holding = new Set;
  for (const [sessionId, list] of shells) {
    const key = list.map((shell) => shell.id).sort().join(",");
    if (!paused.has(sessionId)) {
      backgroundSince.set(sessionId, { key, since: now });
      backgroundGivenUp.delete(sessionId);
      continue;
    }
    const previous = backgroundSince.get(sessionId);
    const since = previous && previous.key === key ? previous.since : now;
    backgroundSince.set(sessionId, { key, since });
    if (limitMs > 0 && now - since >= limitMs) {
      if (backgroundGivenUp.get(sessionId) !== key) {
        backgroundGivenUp.set(sessionId, key);
        logger.warn("[queue] background command still running, no longer waiting for it", {
          projectId,
          sessionId,
          command: list[0]?.command,
          waitedMs: now - since
        });
      }
      continue;
    }
    holding.add(sessionId);
  }
  for (const sessionId of [...backgroundSince.keys()]) {
    if (shells.has(sessionId))
      continue;
    backgroundSince.delete(sessionId);
    backgroundGivenUp.delete(sessionId);
  }
  return holding;
};
var sessionActivity = async (session, directory, background) => {
  if (isStatusIdle(session))
    return background.has(session.id) ? "background" : "idle";
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
var observe = async (projectId, directory, sessions, active, settings) => {
  const idle = settings.idle;
  if (!active && !idle.otherSessionsBlock) {
    clearBackgroundClocks(sessions);
    return { activeStatus: "free", projectBusy: false };
  }
  let holding = new Set;
  if (idle.backgroundBlocks) {
    const paused = new Set(sessions.filter((session) => !session?.archivedAt && isStatusIdle(session)).map((session) => session.id));
    holding = backgroundHolders(projectId, await runningShells(directory), paused, settings.backgroundTimeoutMs, Date.now());
  } else {
    clearBackgroundClocks(sessions);
  }
  if (active) {
    return {
      activeStatus: await activeStatusFor(active, sessions, directory, holding, idle),
      projectBusy: false
    };
  }
  const activities = new Map;
  const busy = sessions.filter((session) => !session?.archivedAt && !isStatusIdle(session));
  await Promise.all(busy.map(async (session) => {
    activities.set(session.id, await sessionActivity(session, directory, holding));
  }));
  return {
    activeStatus: "free",
    projectBusy: [...activities.values()].some((activity) => isOccupied(activity, idle)) || holding.size > 0
  };
};
var descendantIds = (sessions, sessionId) => {
  const byParent = new Map;
  for (const entry of sessions) {
    const parent = entry?.parentID;
    const id = entry?.id;
    if (typeof parent !== "string" || typeof id !== "string")
      continue;
    const list = byParent.get(parent) ?? [];
    list.push(id);
    byParent.set(parent, list);
  }
  const ids = [];
  const pending = [...byParent.get(sessionId) ?? []];
  const seen = new Set;
  while (pending.length > 0) {
    const id = pending.shift();
    if (seen.has(id))
      continue;
    seen.add(id);
    ids.push(id);
    pending.push(...byParent.get(id) ?? []);
  }
  return ids;
};
var activeStatusFor = async (active, sessions, directory, holding, idle) => {
  const session = sessions.find((entry) => entry?.id === active.sessionId);
  if (!session) {
    return Date.now() - active.startedAt < ACTIVE_GRACE_MS ? "running" : "free";
  }
  if (session.archivedAt)
    return "free";
  const activity = await sessionActivity(session, directory, holding);
  if (activity === "waiting-question")
    return idle.questionBlocks ? "running" : "question";
  const byId = new Map;
  for (const entry of sessions) {
    if (typeof entry?.id === "string")
      byId.set(entry.id, entry);
  }
  for (const id of descendantIds(sessions, active.sessionId)) {
    const child = byId.get(id);
    if (!child || child.archivedAt)
      continue;
    if (!isStatusIdle(child) || holding.has(id))
      return "running";
  }
  return isOccupied(activity, idle) ? "running" : "free";
};
var asText = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
var defaultSelection = async (projectId, directory) => {
  const settings = await readJson(path2.join(HOST_DATA_DIR, "settings.json"));
  if (!settings || typeof settings !== "object")
    return {};
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const project = projects.find((entry) => entry?.id === projectId) ?? projects.find((entry) => entry?.path === directory);
  const pick = (key) => asText(project?.[key]) ?? asText(settings[key]);
  const selection = {};
  const model = pick("defaultModel");
  const agent = pick("defaultAgent");
  const variant = pick("defaultVariant");
  if (model)
    selection.model = model;
  if (agent)
    selection.agent = agent;
  if (variant)
    selection.variant = variant;
  return selection;
};
var splitModel = (value) => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1)
    return null;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
};
var applySelection = async (sessionId, directory, selection) => {
  const model = selection.model ? splitModel(selection.model) : null;
  if (model) {
    const applied = await serverPost(`/api/session/${encodeURIComponent(sessionId)}/model`, directory, {
      model: {
        id: model.modelID,
        providerID: model.providerID,
        ...selection.variant ? { variant: selection.variant } : {}
      }
    });
    if (!applied.ok)
      return applied;
  }
  if (selection.agent) {
    const applied = await serverPost(`/api/session/${encodeURIComponent(sessionId)}/agent`, directory, {
      agent: selection.agent
    });
    if (!applied.ok)
      return applied;
  }
  return { ok: true, body: null };
};
var sendPrompt = async (sessionId, directory, prompt) => {
  const files = [];
  for (const image of prompt.images) {
    const bytes = await fsp2.readFile(imagePath(image.id)).catch(() => null);
    if (!bytes) {
      return { ok: false, error: `attached image ${image.name} is missing from the image store` };
    }
    files.push({ uri: `data:${image.mime};base64,${bytes.toString("base64")}`, name: image.name });
  }
  return serverPost(`/api/session/${encodeURIComponent(sessionId)}/prompt`, directory, { text: prompt.text, files }, DISPATCH_TIMEOUT_MS);
};
var startSessionFor = async (projectId, directory, prompt) => {
  if (prompt.images.length === 0) {
    const result = await control("session.create", { directory, prompt: prompt.text });
    if (result.ok && typeof result.body?.sessionId === "string")
      return { sessionId: result.body.sessionId };
    return { error: result.ok ? "session.create returned no session id" : result.error };
  }
  const selection = await defaultSelection(projectId, directory);
  const created = await control("session.create", { directory });
  if (!created.ok || typeof created.body?.sessionId !== "string") {
    return { error: created.ok ? "session.create returned no session id" : created.error };
  }
  const sessionId = created.body.sessionId;
  if (selection.model || selection.agent) {
    const applied = await applySelection(sessionId, directory, selection);
    if (!applied.ok)
      logger.warn("[queue] could not set the session selection", applied.error);
  }
  const sent = await sendPrompt(sessionId, directory, prompt);
  if (!sent.ok)
    return { error: sent.error };
  return { sessionId };
};
var appendToSession = async (directory, sessionId, prompt) => {
  const sent = await sendPrompt(sessionId, directory, prompt);
  if (!sent.ok)
    return { error: sent.error };
  return { sessionId };
};
var TURN_IDLE_SLACK_MS = 1e4;
var describeTurnError = (error) => {
  const rawType = typeof error?.type === "string" ? error.type : error?.name;
  const rawMessage = typeof error?.message === "string" ? error.message : error?.data?.message;
  const type = typeof rawType === "string" ? rawType.trim() : "";
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (type && message)
    return `${type}: ${message}`.slice(0, 400);
  return (message || type || "The session ended with an error").slice(0, 400);
};
var latestMessageAt = async (sessionId, directory) => {
  const result = await serverGet(`/api/session/${encodeURIComponent(sessionId)}/message?limit=1&order=desc`, directory);
  if (!result.ok)
    return;
  const records = Array.isArray(result.body?.data) ? result.body.data : [];
  const at = Number(records[0]?.time?.created ?? records[0]?.info?.time?.created);
  return Number.isFinite(at) ? at : undefined;
};
var lastTurnOutcome = async (sessionId, directory, startedAt, baselineAt) => {
  const result = await serverGet(`/api/session/${encodeURIComponent(sessionId)}/message?limit=5&order=desc`, directory);
  if (!result.ok) {
    logger.warn("[queue] could not read the session outcome", { sessionId, reason: result.error });
    return { outcome: "unknown" };
  }
  const records = Array.isArray(result.body?.data) ? result.body.data : [];
  const recent = records.map((record) => ({
    type: record?.type ?? record?.info?.role,
    at: Number(record?.time?.created ?? record?.info?.time?.created),
    outcome: record?.outcome,
    error: record?.error ?? record?.info?.error,
    finish: record?.finish ?? record?.info?.finish
  })).filter((record) => Number.isFinite(record.at) && (baselineAt !== undefined ? record.at > baselineAt : record.at >= startedAt - TURN_IDLE_SLACK_MS));
  const idle = recent.filter((record) => record.type === "idle" && typeof record.outcome === "string").sort((left, right) => left.at - right.at)[0];
  if (idle) {
    if (idle.outcome === "succeeded" || idle.outcome === "failed" || idle.outcome === "interrupted") {
      return { outcome: idle.outcome, error: idle.error };
    }
    return { outcome: "unknown" };
  }
  const assistant = recent.filter((record) => record.type === "assistant").sort((left, right) => right.at - left.at)[0];
  if (assistant) {
    if (assistant.finish === "error") {
      const type = typeof assistant.error?.type === "string" ? assistant.error.type : typeof assistant.error?.name === "string" ? assistant.error.name : "";
      const aborted = type === "aborted" || type === "MessageAbortedError";
      return { outcome: aborted ? "interrupted" : "failed", error: assistant.error };
    }
    if (typeof assistant.finish === "string")
      return { outcome: "succeeded" };
  }
  return { outcome: "unknown" };
};
var dispatch = async (projectId, directory, task) => {
  const prompt = { text: task.text, images: task.images };
  const baselineAt = task.target ? await latestMessageAt(task.target.sessionId, directory) : undefined;
  const started = task.target ? await appendToSession(directory, task.target.sessionId, prompt) : await startSessionFor(projectId, directory, prompt);
  if ("sessionId" in started) {
    startTask(state, projectId, task.id, started.sessionId, { baselineAt });
    logger.info("[queue] dispatched task", {
      projectId,
      taskId: task.id,
      sessionId: started.sessionId,
      images: task.images.length,
      appended: Boolean(task.target)
    });
    return ["run.started"];
  }
  markFailed(state, projectId, task.id, started.error);
  const pause = noteFailure(state, projectId, "dispatch", started.error, queueSettings(getQueue(state, projectId)));
  logger.error("[queue] dispatch failed", { projectId, taskId: task.id, reason: started.error });
  if (!pause)
    return ["task.failed"];
  setEnabled(state, projectId, false);
  logger.warn("[queue] paused after failed dispatches", { projectId, detail: pause.detail });
  return ["task.failed", "queue.paused"];
};
var runTask = async (projectId, taskId) => {
  const info = state.projects[projectId];
  const task = getQueue(state, projectId).tasks.find((entry) => entry.id === taskId);
  if (!info || !task)
    return;
  const types = await dispatch(projectId, info.directory, task);
  if (types.includes("queue.paused"))
    resetIdleClock(projectId);
  await persist();
  for (const type of types)
    emit(projectId, type);
};
var runNow = async (projectId, text, images) => {
  const info = state.projects[projectId];
  const trimmed = text.trim();
  if (!info || !trimmed)
    return;
  const started = await startSessionFor(projectId, info.directory, { text: trimmed, images });
  if ("error" in started)
    logger.error("[queue] run-now failed", started.error);
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
var resetIdleClock = (projectId) => {
  freeSince.delete(projectId);
  cancelDispatchCheck(projectId);
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
var nextSettleMs = new Map;
var settleDelayFor = (projectId) => nextSettleMs.get(projectId) ?? queueSettings(getQueue(state, projectId)).dispatchDelayMs;
var clearSettle = (projectId) => {
  nextSettleMs.delete(projectId);
};
var scheduleDispatchCheck = (projectId) => {
  const since = freeSince.get(projectId);
  if (since === undefined)
    return;
  const delayMs = Math.max(0, since + settleDelayFor(projectId) - Date.now());
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
  const pausedQueue = getQueue(state, projectId);
  if (!pausedQueue.active && pausedQueue.guard?.pause)
    return types;
  if (!queueHasWork(getQueue(state, projectId))) {
    freeSince.delete(projectId);
    clearSettle(projectId);
    cancelDispatchCheck(projectId);
    offlineProjects.delete(projectId);
    return types;
  }
  for (let step = 0;step < MAX_STEPS_PER_TICK; step += 1) {
    const queue = getQueue(state, projectId);
    if (!queueHasWork(queue))
      break;
    const sessions = await listSessions(info.directory);
    if (!sessions) {
      if (!offlineProjects.has(projectId)) {
        offlineProjects.add(projectId);
        logger.warn("[queue] cannot read sessions", { projectId, directory: info.directory });
      }
      break;
    }
    if (offlineProjects.delete(projectId)) {
      logger.info("[queue] sessions reachable again", { projectId });
    }
    const observation = await observe(projectId, info.directory, sessions, queue.active, queueSettings(queue));
    const now = Date.now();
    const free = queue.active === null && !observation.projectBusy;
    if (!free)
      clearSettle(projectId);
    const decision = planTick(queue, {
      ...observation,
      idleMs: trackIdle(projectId, free, now),
      settleMs: settleDelayFor(projectId)
    });
    if (decision.kind === "finish") {
      const settingsNow = queueSettings(queue);
      if (observation.activeStatus === "question") {
        nextSettleMs.set(projectId, settingsNow.questionDelayMs);
        noteHealthyRun(state, projectId);
        finishRun(state, projectId);
        types.push("run.finished");
        continue;
      }
      const run = queue.active;
      const turn = run ? await lastTurnOutcome(run.sessionId, info.directory, run.startedAt, run.baselineAt) : { outcome: "unknown" };
      const current = getQueue(state, projectId).active;
      const stillThisRun = run !== null && current?.sessionId === run.sessionId && current.startedAt === run.startedAt;
      if (stillThisRun)
        finishRun(state, projectId);
      if (turn.outcome === "failed") {
        const detail = describeTurnError(turn.error);
        const pause = noteFailure(state, projectId, "run", detail, settingsNow, now);
        types.push("run.failed");
        logger.warn("[queue] turn failed", { projectId, sessionId: run?.sessionId, detail });
        if (pause) {
          setEnabled(state, projectId, false);
          resetIdleClock(projectId);
          types.push("queue.paused");
          logger.warn("[queue] paused after failed turns", {
            projectId,
            failures: settingsNow.maxFailures,
            detail
          });
        }
      } else if (turn.outcome === "succeeded") {
        noteHealthyRun(state, projectId);
      } else if (turn.outcome === "unknown") {
        logger.warn("[queue] turn outcome unknown", { projectId, sessionId: run?.sessionId });
      }
      types.push("run.finished");
      continue;
    }
    if (decision.kind === "dispatch") {
      cancelDispatchCheck(projectId);
      clearSettle(projectId);
      const task = queue.tasks.find((entry) => entry.id === decision.taskId);
      if (!task)
        break;
      types.push(...await dispatch(projectId, info.directory, task));
      if (types.includes("queue.paused"))
        resetIdleClock(projectId);
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
var offlineProjects = new Set;
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
    logger.error("[queue] tick failed", error);
  }
  if (mutated) {
    await persist();
    sweepImages();
  }
};
var evaluateProject = (projectId) => {
  (async () => {
    try {
      if (await tickProject(projectId))
        await persist();
    } catch (error) {
      logger.error("[queue] tick failed", error);
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
  "set-enabled": "queue.enabled",
  "set-task-enabled": "task.enabled",
  "set-settings": "queue.settings",
  resume: "queue.resumed"
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
    case "enqueue": {
      const target2 = command.targetSessionId ? { sessionId: command.targetSessionId, title: command.targetSessionTitle } : undefined;
      return enqueue(state, projectId, command.text ?? "", {
        images: sanitizeImages(command.images),
        target: target2,
        enabled: command.enabled !== false
      }) !== null;
    }
    case "edit":
      return editTask(state, projectId, command.taskId ?? "", command.text ?? "", sanitizeImages(command.images));
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
      clearPause(state, projectId, true);
      resetIdleClock(projectId);
      return setEnabled(state, projectId, command.enabled === true);
    case "resume": {
      const cleared = clearPause(state, projectId, true);
      resetIdleClock(projectId);
      const wasEnabled = getQueue(state, projectId).enabled;
      if (!wasEnabled)
        setEnabled(state, projectId, true);
      return cleared || !wasEnabled;
    }
    case "set-task-enabled":
      return setTaskEnabled(state, projectId, command.taskId ?? "", command.enabled === true);
    case "set-settings": {
      const changed = updateSettings(state, projectId, command.settings ?? {}, SERVICE_SETTINGS);
      if (changed)
        clearSettle(projectId);
      return changed;
    }
    case "set-draft":
      return setDraft(state, projectId, { text: command.text ?? "", images: sanitizeImages(command.images) });
    case "run-now":
      await runNow(projectId, command.text ?? "", sanitizeImages(command.images));
      return false;
    case "tick":
      await tick();
      return false;
    default:
      return false;
  }
};
var BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
var isThumb = (value) => typeof value === "string" && value.startsWith("data:image/") && value.length <= MAX_THUMB_CHARS;
var badRequest = (res, status, error) => {
  json(res, status, { error });
  return true;
};
var handleImageRequest = async (req, res, url) => {
  const thumbMatch = /^\/image\/([^/]+)\/thumb$/.exec(url.pathname);
  if (thumbMatch && req.method === "GET") {
    const id2 = thumbMatch[1];
    if (!isImageId(id2))
      return badRequest(res, 400, "bad image id");
    const thumb2 = await fsp2.readFile(imagePath(id2, ".thumb"), "utf8").catch(() => null);
    json(res, 200, { id: id2, thumb: isThumb(thumb2) ? thumb2 : null });
    return true;
  }
  if (url.pathname !== "/image/begin" && url.pathname !== "/image/chunk" && url.pathname !== "/image/end" && url.pathname !== "/image/abort") {
    return false;
  }
  if (req.method !== "POST")
    return badRequest(res, 405, "method not allowed");
  let body = null;
  try {
    body = JSON.parse(await readBody(req) || "{}");
  } catch {
    return badRequest(res, 400, "invalid body");
  }
  const id = body?.id;
  if (!isImageId(id))
    return badRequest(res, 400, "bad image id");
  if (url.pathname === "/image/begin") {
    const name = asText(body?.name) ?? "image";
    const mime = asText(body?.mime) ?? "application/octet-stream";
    if (uploads.has(id))
      return badRequest(res, 409, "upload already started");
    await fsp2.mkdir(IMAGE_DIR, { recursive: true });
    await fsp2.writeFile(imagePath(id, ".part"), "");
    uploads.set(id, { name, mime, bytes: 0 });
    json(res, 200, { ok: true, id });
    return true;
  }
  const session = uploads.get(id);
  if (!session)
    return badRequest(res, 409, "upload not started");
  if (url.pathname === "/image/abort") {
    uploads.delete(id);
    await fsp2.rm(imagePath(id, ".part"), { force: true }).catch(() => {
      return;
    });
    json(res, 200, { ok: true, id });
    return true;
  }
  if (url.pathname === "/image/chunk") {
    const data = typeof body?.data === "string" ? body.data : "";
    if (!data || data.length > MAX_IMAGE_CHUNK_CHARS || !BASE64.test(data)) {
      return badRequest(res, 400, "bad chunk");
    }
    const bytes = Buffer.from(data, "base64");
    if (session.bytes + bytes.length > MAX_IMAGE_BYTES) {
      uploads.delete(id);
      await fsp2.rm(imagePath(id, ".part"), { force: true }).catch(() => {
        return;
      });
      return badRequest(res, 413, `image is larger than ${MAX_IMAGE_BYTES} bytes`);
    }
    await fsp2.appendFile(imagePath(id, ".part"), bytes);
    session.bytes += bytes.length;
    json(res, 200, { ok: true, id, received: session.bytes });
    return true;
  }
  uploads.delete(id);
  const image = sanitizeImages([{ id, name: session.name, mime: session.mime, size: session.bytes }])[0];
  if (!image) {
    await fsp2.rm(imagePath(id, ".part"), { force: true }).catch(() => {
      return;
    });
    return badRequest(res, 400, "empty image");
  }
  const thumb = isThumb(body?.thumb) ? body.thumb : null;
  try {
    await fsp2.mkdir(IMAGE_DIR, { recursive: true });
    await fsp2.rename(imagePath(id, ".part"), imagePath(id));
    if (thumb)
      await fsp2.writeFile(imagePath(id, ".thumb"), thumb, "utf8");
  } catch (error) {
    logger.error("[queue] failed to store image", error);
    return badRequest(res, 500, "could not store the image");
  }
  json(res, 200, { ok: true, image });
  return true;
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
        draft: getDraft(state, projectId),
        seq
      };
      json(res, 200, { backend: true, projectId, ...snapshot, counts: summarize(queue) });
      return;
    }
    if (await handleImageRequest(req, res, url))
      return;
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
        sweepImages();
        if (command.op !== "set-draft") {
          const type = command.projectId ? COMMAND_EVENTS[command.op] : undefined;
          if (type && command.projectId)
            emit(command.projectId, type);
          if (command.projectId)
            evaluateProject(command.projectId);
        }
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
    logger.error("[queue] request failed", error);
    json(res, 500, { error: error instanceof Error ? error.message : "failed" });
  });
});
server.on("error", (error) => logger.error("[queue] server error", error));
server.listen(PORT, "127.0.0.1", () => {
  logger.info("[queue] service listening", {
    pid: process.pid,
    port: PORT,
    stateFile: STATE_FILE,
    imageDir: IMAGE_DIR,
    logFile: logger.file
  });
});
(async () => {
  state = await readState();
  sweepImages();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  const sweeper = setInterval(() => void sweepImages(), SWEEP_INTERVAL_MS);
  sweeper.unref?.();
  tick();
})();
process.on("unhandledRejection", (reason) => {
  logger.error("[queue] unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
  logger.error("[queue] uncaught exception", error);
  logger.flush().finally(() => process.exit(1));
});
var shutdown = (signal) => {
  logger.info(`[queue] received ${signal}, shutting down`);
  server.close(() => {
    logger.flush().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
