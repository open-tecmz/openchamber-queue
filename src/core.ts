/**
 * Shared queue model and pure state transitions.
 *
 * The same module is bundled into the rail panel (browser IIFE) and into the
 * local service (Node ESM), so the queue behaves identically whether the panel
 * or the background worker is driving it.
 *
 * Statuses are only pending / failed: a task leaves the queue the moment its
 * session is created and is counted in `completed`. The dispatched session is
 * remembered as the active run only so nothing else starts while it works. A
 * failed turn does not put the task back; the guard below counts consecutive
 * failed turns and pauses the queue, so a broken model cannot consume the whole
 * list.
 *
 * A task is its prompt text plus the images attached to it, and a switch the
 * user can turn off so the scheduler passes over it. The bytes never
 * enter this state: an image is a reference into the service's own store (see
 * `TaskImage`), which is what keeps `state.json` small and writable in one go.
 * A task may also name an existing session (`TaskTarget`) to append to instead
 * of a new one being created at dispatch.
 */

export type TaskStatus = 'pending' | 'failed';

/**
 * An image attached to a task or to the composer draft.
 *
 * Only this metadata is kept in the state file; the bytes live in the image
 * store beside it (`<data dir>/images/<id>`), owned by the service. That keeps
 * `state.json` small and lets a task reference an image that was uploaded once.
 */
export type TaskImage = {
  /** Store key: `img_…`. Never a path — the service joins it under its own dir. */
  id: string;
  name: string;
  mime: string;
  size: number;
};

/** How many images one task (and one draft) may carry. */
export const MAX_IMAGES_PER_TASK = 4;

/** Store key shape. Anything else is refused, so an id can never escape the store. */
export const IMAGE_ID = /^img_[A-Za-z0-9_-]{1,64}$/;

/** A value that can be stored as an image reference, or null. */
const sanitizeImage = (value: unknown): TaskImage | null => {
  if (!value || typeof value !== 'object') return null;
  const image = value as Partial<TaskImage>;
  if (typeof image.id !== 'string' || !IMAGE_ID.test(image.id)) return null;
  if (typeof image.name !== 'string') return null;
  if (typeof image.mime !== 'string') return null;
  if (typeof image.size !== 'number' || !Number.isFinite(image.size) || image.size <= 0) return null;
  return {
    id: image.id,
    name: image.name.slice(0, 200),
    mime: image.mime.slice(0, 100),
    size: image.size,
  };
};

/** The image references a list carries, in order, capped and de-duplicated. */
export const sanitizeImages = (value: unknown): TaskImage[] => {
  if (!Array.isArray(value)) return [];
  const images: TaskImage[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const image = sanitizeImage(entry);
    if (!image || seen.has(image.id)) continue;
    seen.add(image.id);
    images.push(image);
    if (images.length >= MAX_IMAGES_PER_TASK) break;
  }
  return images;
};

/**
 * Where an "append" task goes: a session that already exists, recorded by the
 * panel when the task was queued — the queue sends the prompt to it at dispatch
 * instead of creating a new session. The title is kept only so the queue can
 * show which session a task is bound to; the id is what dispatch uses.
 */
export type TaskTarget = {
  /** OpenChamber/OpenCode session id to append to. */
  sessionId: string;
  /** The session's title when the task was queued, for display only. */
  title?: string;
};

/** A target a task may carry, or undefined. A session id is the only requirement. */
const sanitizeTarget = (value: unknown): TaskTarget | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const target = value as Partial<TaskTarget>;
  if (typeof target.sessionId !== 'string' || !target.sessionId.trim()) return undefined;
  const sessionId = target.sessionId.trim().slice(0, 256);
  const title = typeof target.title === 'string' && target.title.trim() ? target.title.trim().slice(0, 200) : undefined;
  return title ? { sessionId, title } : { sessionId };
};

export type QueueTask = {
  id: string;
  /** The prompt text. */
  text: string;
  /** Images sent with the prompt, oldest first. Byte-free: see `TaskImage`. */
  images: TaskImage[];
  status: TaskStatus;
  /**
   * Whether the scheduler may dispatch this task on its own. A task switched
   * off stays in the queue, in its place, but is skipped when the next task is
   * picked — so it neither starts a session nor blocks the ones behind it. It
   * can still be started by hand with Run. Older tasks without the field are
   * treated as enabled, which is what the queue always did.
   */
  enabled: boolean;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  /**
   * Set on a task the user queued to append to an existing session. The panel
   * records the session that was open when the task was queued; the service
   * sends the prompt to it at dispatch instead of creating a new session.
   */
  target?: TaskTarget;
};

/**
 * What the user typed for a project but did not queue yet. A draft is a whole
 * composer, text and images alike, so a reload does not drop the half-typed
 * task — and so the images it names stay referenced (and are not swept).
 */
export type QueueDraft = {
  text: string;
  images: TaskImage[];
};

/** The session the queue itself started, remembered until the project is free. */
export type ActiveRun = {
  sessionId: string;
  startedAt: number;
  /**
   * Id of the task that was dispatched into this session. The task itself is
   * removed from the queue at dispatch, so this is the only record left of which
   * task is running — for external tools and panels that need to tell.
   */
  taskId?: string;
  /**
   * Creation time of the newest message the session held just before an append
   * task's prompt went out. The breaker reads the turn's `idle` record after the
   * session frees, and this baseline keeps an earlier turn's record from being
   * mistaken for this one when the settle window is very short.
   */
  baselineAt?: number;
};

/**
 * A pending self-pause. While one is present the queue dispatches nothing and
 * waits for the user to resume it.
 */
export type QueuePause = {
  at: number;
  /** What counted as a failure, so the panel can explain a run and a dispatch differently. */
  cause: 'run' | 'dispatch';
  /** The last error, in the form the panel shows and the log keeps. */
  detail: string;
};

/**
 * Runaway protection for one queue.
 *
 * Handing a task to a session is not the same as the turn succeeding. A model
 * whose provider is down, out of quota or misconfigured ends the turn with a
 * failed session status, and without a breaker the ordinary settle window would
 * then walk the whole queue, consuming a task for every failed attempt. The
 * guard counts consecutive failed turns — and dispatches that never reached a
 * session — and pauses the queue before more tasks are spent.
 *
 * A healthy turn clears the count. An interrupted turn (a manual stop or an
 * OpenCode restart) is neither a success nor a failure and leaves it alone.
 */
export type QueueGuard = {
  /** Consecutive failed turns or failed dispatches; a successful end resets it. */
  failures: number;
  /** Present while the queue stopped itself. */
  pause?: QueuePause;
};

export type ProjectQueue = {
  enabled: boolean;
  /** Handed-off tasks so far. Tasks are removed at dispatch, so this is the running total. */
  completed: number;
  tasks: QueueTask[];
  active: ActiveRun | null;
  /**
   * Per-queue dispatch settings. Absent means the queue has never been
   * customised and the service's own defaults apply — which keeps a state file
   * written before settings existed behaving exactly as it did.
   */
  settings?: QueueSettings;
  /** Runaway protection state. Absent for a queue that has never needed it. */
  guard?: QueueGuard;
};

export type ProjectInfo = {
  /** OpenChamber project id. */
  id: string;
  directory: string;
  name: string;
};

export type QueueState = {
  version: 1;
  projects: Record<string, ProjectInfo>;
  queues: Record<string, ProjectQueue>;
  /**
   * The composer for a project that has not been queued yet, kept beside its
   * queue so it survives a panel reload, an OpenChamber restart or a hard exit.
   * Natural key is the project id; an empty entry means "no draft".
   */
  drafts: Record<string, QueueDraft>;
};

export const STATE_VERSION = 1;

/** A dispatched session is "gone" only after the list has had time to catch up. */
export const ACTIVE_GRACE_MS = 15000;

/**
 * The default idle wait before the queue starts the next task.
 *
 * The queue lets the project settle first: nothing is dispatched until it has
 * been free for this whole window. Anything that wakes up inside the window —
 * another session, a permission retry, a follow-up on the session that just
 * finished — makes the count start over, so the next task only runs once the
 * project really is quiet. A queue with its own settings uses that wait instead.
 */
export const DISPATCH_DELAY_MS = 30000;

/**
 * The default longer settle window used after a run ends on a question.
 *
 * A run whose session stopped to ask the user something is not really done: it
 * waits for an answer the user has not given yet. Rather than start the next
 * task straight away — which would run over the question the previous task is
 * still waiting on — the queue gives the user a few minutes to reply first.
 */
export const QUESTION_DISPATCH_DELAY_MS = 300000;

/**
 * The default longest a running background command may hold a queue.
 *
 * A session that sent a command to the background reports idle, but OpenCode
 * wakes it again only when that command exits. A command that never exits — a
 * development server, a watcher — would therefore hold the queue forever, so
 * the pause stops counting as busy after this window. The same record is all
 * OpenCode keeps, so a long test run and a forgotten server look alike: the
 * window is generous enough for an hour-long test, and a queue that wants to
 * wait forever sets 0. A queue with its own settings uses its own value.
 */
export const BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** The shortest settle window a queue may be set to (one second). */
export const MIN_DELAY_MS = 1000;
/** The longest settle window a queue may be set to (one day). */
export const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the queue treats as "busy" for one project.
 *
 * `running` and `retrying` always hold the queue: a turn that is executing is
 * work, whatever the policy. The other statuses are choices, because a user may
 * consider a session idle while it only waits for them:
 *
 * - a question is not occupied by default, so the agent asking does not stall
 *   the whole project — the user gets the longer question window instead;
 * - a permission prompt and a backgrounded command are occupied by default,
 *   because the turn is not finished even though the agent looks idle;
 * - other sessions hold the project by default, so the queue never starts a
 *   task while someone is working in the same project by hand.
 */
export type IdlePolicy = {
  /** A session waiting on a question holds the queue until it is answered. */
  questionBlocks: boolean;
  /** A session waiting for a permission answer holds the queue. */
  permissionBlocks: boolean;
  /** A session whose backgrounded command is still running holds the queue. */
  backgroundBlocks: boolean;
  /** Sessions the queue did not start also hold the project. */
  otherSessionsBlock: boolean;
};

export const DEFAULT_IDLE_POLICY: IdlePolicy = {
  questionBlocks: false,
  permissionBlocks: true,
  backgroundBlocks: true,
  otherSessionsBlock: true,
};

/** Consecutive failed turns (or failed dispatches) that pause the queue. 0 disables the breaker. */
export const MAX_CONSECUTIVE_FAILURES = 2;

/** The largest value the failure limit may take. */
export const MAX_FAILURES_LIMIT = 1000;

/**
 * Per-queue dispatch settings. A queue without settings uses the service's own
 * defaults, which are the values below — so an older state file keeps behaving
 * exactly as it did before settings existed.
 */
export type QueueSettings = {
  /** How long the project must stay free before the next task starts. */
  dispatchDelayMs: number;
  /** The longer window used after a run ended on a question. */
  questionDelayMs: number;
  /** How long a running background command may hold the queue. 0 waits forever. */
  backgroundTimeoutMs: number;
  /** Consecutive failed turns or failed dispatches before the queue pauses. 0 turns it off. */
  maxFailures: number;
  /** What counts as busy while the project is watched. */
  idle: IdlePolicy;
};

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  dispatchDelayMs: DISPATCH_DELAY_MS,
  questionDelayMs: QUESTION_DISPATCH_DELAY_MS,
  backgroundTimeoutMs: BACKGROUND_TIMEOUT_MS,
  maxFailures: MAX_CONSECUTIVE_FAILURES,
  idle: DEFAULT_IDLE_POLICY,
};

/** A partial update to one queue's settings, as the panel sends it. */
export type QueueSettingsPatch = {
  dispatchDelayMs?: number;
  questionDelayMs?: number;
  backgroundTimeoutMs?: number;
  maxFailures?: number;
  idle?: Partial<IdlePolicy>;
};

const sanitizeDelay = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(value)));
};

/** A failure limit that may be zero (off), clamped to its upper bound. */
const sanitizeFailureLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_FAILURES_LIMIT, Math.max(0, Math.round(value)));
};

/** A background wait that may be zero (wait forever), clamped to its upper bound. */
const sanitizeBackgroundTimeout = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(value)));
};

const sanitizeFlag = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/** A settings object read from disk or a command, with every field valid. */
export const sanitizeSettings = (
  value: unknown,
  fallback: QueueSettings = DEFAULT_QUEUE_SETTINGS,
): QueueSettings => {
  const raw = value && typeof value === 'object' ? value as Partial<QueueSettings> : {};
  const idle = raw.idle && typeof raw.idle === 'object' ? raw.idle as Partial<IdlePolicy> : {};
  return {
    dispatchDelayMs: sanitizeDelay(raw.dispatchDelayMs, fallback.dispatchDelayMs),
    questionDelayMs: sanitizeDelay(raw.questionDelayMs, fallback.questionDelayMs),
    backgroundTimeoutMs: sanitizeBackgroundTimeout(raw.backgroundTimeoutMs, fallback.backgroundTimeoutMs),
    maxFailures: sanitizeFailureLimit(raw.maxFailures, fallback.maxFailures),
    idle: {
      questionBlocks: sanitizeFlag(idle.questionBlocks, fallback.idle.questionBlocks),
      permissionBlocks: sanitizeFlag(idle.permissionBlocks, fallback.idle.permissionBlocks),
      backgroundBlocks: sanitizeFlag(idle.backgroundBlocks, fallback.idle.backgroundBlocks),
      otherSessionsBlock: sanitizeFlag(idle.otherSessionsBlock, fallback.idle.otherSessionsBlock),
    },
  };
};

const sameSettings = (left: QueueSettings, right: QueueSettings): boolean =>
  left.dispatchDelayMs === right.dispatchDelayMs &&
  left.questionDelayMs === right.questionDelayMs &&
  left.backgroundTimeoutMs === right.backgroundTimeoutMs &&
  left.maxFailures === right.maxFailures &&
  left.idle.questionBlocks === right.idle.questionBlocks &&
  left.idle.permissionBlocks === right.idle.permissionBlocks &&
  left.idle.backgroundBlocks === right.idle.backgroundBlocks &&
  left.idle.otherSessionsBlock === right.idle.otherSessionsBlock;

/** The settings a queue runs with: its own, or the caller's defaults. */
export const settingsOf = (
  queue: ProjectQueue,
  fallback: QueueSettings = DEFAULT_QUEUE_SETTINGS,
): QueueSettings => queue.settings ?? fallback;

/**
 * Apply a partial settings change. Returns false when nothing changed, so a
 * caller can skip a state write and an event. The first change stores a full
 * settings object, which is what later reads and the panel see.
 */
export const updateSettings = (
  state: QueueState,
  projectId: string,
  patch: QueueSettingsPatch,
  defaults: QueueSettings = DEFAULT_QUEUE_SETTINGS,
): boolean => {
  const queue = ensureQueue(state, projectId);
  const base = settingsOf(queue, defaults);
  const next = sanitizeSettings({
    dispatchDelayMs: patch.dispatchDelayMs ?? base.dispatchDelayMs,
    questionDelayMs: patch.questionDelayMs ?? base.questionDelayMs,
    backgroundTimeoutMs: patch.backgroundTimeoutMs ?? base.backgroundTimeoutMs,
    maxFailures: patch.maxFailures ?? base.maxFailures,
    idle: { ...base.idle, ...(patch.idle ?? {}) },
  }, defaults);
  if (queue.settings ? sameSettings(next, queue.settings) : sameSettings(next, defaults)) return false;
  queue.settings = next;
  return true;
};

export const emptyState = (): QueueState => ({
  version: STATE_VERSION,
  projects: {},
  queues: {},
  drafts: {},
});

export const emptyQueue = (): ProjectQueue => ({
  enabled: false,
  completed: 0,
  tasks: [],
  active: null,
});

/** A composer with nothing in it. */
export const emptyDraft = (): QueueDraft => ({ text: '', images: [] });

// ---------------------------------------------------------------------------
// Runaway protection
// ---------------------------------------------------------------------------

/**
 * Count one failed turn or failed dispatch. At the configured limit the queue
 * pauses and this returns the new pause; before that, or when a pause is
 * already in place, it returns null so no duplicate event is emitted.
 */
export const noteFailure = (
  state: QueueState,
  projectId: string,
  cause: 'run' | 'dispatch',
  detail: string,
  settings: QueueSettings,
  now = Date.now(),
): QueuePause | null => {
  const queue = ensureQueue(state, projectId);
  const guard = queue.guard ?? (queue.guard = { failures: 0 });
  // A manual run while paused may fail too; the pause already says why, and
  // counting those would inflate the number the panel explains.
  if (guard.pause) return null;
  // The breaker is off: do not keep a count nobody acts on.
  if (settings.maxFailures <= 0) return null;
  guard.failures += 1;
  if (guard.failures < settings.maxFailures) return null;
  const pause: QueuePause = { at: now, cause, detail };
  guard.pause = pause;
  return pause;
};

/**
 * A turn that succeeded clears the consecutive-failure count. It does not lift
 * a pause: a pause waits for the user, who alone knows whether the model has
 * been fixed.
 */
export const noteHealthyRun = (state: QueueState, projectId: string): void => {
  const guard = state.queues[projectId]?.guard;
  if (!guard || guard.pause) return;
  guard.failures = 0;
};

/**
 * Lift a pause. Resuming by hand also resets the failure count, so the user
 * gets a full set of attempts after fixing the model.
 */
export const clearPause = (state: QueueState, projectId: string, resetFailures = true): boolean => {
  const guard = state.queues[projectId]?.guard;
  if (!guard?.pause) return false;
  delete guard.pause;
  if (resetFailures) guard.failures = 0;
  return true;
};

export const deriveTitle = (text: string, fallback = 'Queue task'): string => {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
  if (!firstLine) return fallback;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
};

const nextId = (): string => {
  const random = Math.random().toString(36).slice(2, 8);
  return `t_${Date.now().toString(36)}_${random}`;
};

/** An empty queue turns itself off: there is nothing left to dispatch. */
export const normalizeQueue = (queue: ProjectQueue): void => {
  if (queue.tasks.length === 0) {
    queue.enabled = false;
    queue.active = null;
  }
};

export const ensureQueue = (state: QueueState, projectId: string): ProjectQueue => {
  if (!state.queues[projectId]) state.queues[projectId] = emptyQueue();
  return state.queues[projectId];
};

export const getQueue = (state: QueueState, projectId: string): ProjectQueue =>
  state.queues[projectId] ?? emptyQueue();

/** The composer draft saved for a project, or an empty one. */
export const getDraft = (state: QueueState, projectId: string, fallback: QueueDraft = emptyDraft()): QueueDraft => {
  if (!projectId) return { text: fallback.text, images: [...fallback.images] };
  const draft = state.drafts[projectId];
  if (!draft) return { text: fallback.text, images: [...fallback.images] };
  return { text: draft.text, images: [...draft.images] };
};

/**
 * Save a project's composer draft. Returns false when it did not change, so a
 * caller can skip a state write — a panel that re-sends the same draft costs
 * nothing. An empty draft is kept as an entry: it is how "the composer was
 * cleared" is told apart from "no draft was ever saved".
 */
export const setDraft = (state: QueueState, projectId: string, draft: QueueDraft): boolean => {
  if (!projectId) return false;
  const next: QueueDraft = { text: draft.text, images: sanitizeImages(draft.images) };
  const current = state.drafts[projectId];
  if (current && current.text === next.text && sameImages(current.images, next.images)) return false;
  state.drafts[projectId] = next;
  return true;
};

const sameImages = (left: readonly TaskImage[], right: readonly TaskImage[]): boolean =>
  left.length === right.length &&
  left.every((image, index) =>
    image.id === right[index].id &&
    image.name === right[index].name &&
    image.mime === right[index].mime &&
    image.size === right[index].size);

/** What a task carries besides its text. */
export type TaskOptions = {
  images?: TaskImage[];
  /** An existing session to append to instead of creating one. */
  target?: TaskTarget;
  /** Whether the scheduler may start the new task on its own; defaults to true. */
  enabled?: boolean;
  now?: number;
};

export const makeTask = (text: string, options: TaskOptions = {}): QueueTask => {
  const task: QueueTask = {
    id: nextId(),
    text: text.trim(),
    images: sanitizeImages(options.images),
    status: 'pending',
    enabled: options.enabled !== false,
    createdAt: options.now ?? Date.now(),
    finishedAt: null,
    error: null,
  };
  const target = sanitizeTarget(options.target);
  if (target) task.target = target;
  return task;
};

export const enqueue = (
  state: QueueState,
  projectId: string,
  text: string,
  options: TaskOptions = {},
): QueueTask | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const task = makeTask(trimmed, options);
  ensureQueue(state, projectId).tasks.push(task);
  return task;
};

export const removeTask = (state: QueueState, projectId: string, taskId: string): boolean => {
  const queue = state.queues[projectId];
  if (!queue) return false;
  const before = queue.tasks.length;
  queue.tasks = queue.tasks.filter((task) => task.id !== taskId);
  normalizeQueue(queue);
  return queue.tasks.length !== before;
};

export const editTask = (
  state: QueueState,
  projectId: string,
  taskId: string,
  text: string,
  images?: TaskImage[],
): boolean => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  const trimmed = text.trim();
  if (!queue || !task || !trimmed) return false;
  task.text = trimmed;
  // The editor may change the attachments; a text-only edit leaves them alone.
  if (images !== undefined) task.images = sanitizeImages(images);
  return true;
};

/** Move a task to the head, or swap it with its neighbour. */
export const moveTask = (
  state: QueueState,
  projectId: string,
  taskId: string,
  direction: 'top' | 'up' | 'down',
): boolean => {
  const queue = state.queues[projectId];
  if (!queue) return false;
  const index = queue.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return false;
  if (direction === 'top' && index > 0) {
    const [task] = queue.tasks.splice(index, 1);
    queue.tasks.unshift(task);
    return true;
  }
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= queue.tasks.length) return false;
  const [task] = queue.tasks.splice(index, 1);
  queue.tasks.splice(target, 0, task);
  return true;
};

/** A failed task goes back to the end of the pending line. */
export const retryTask = (state: QueueState, projectId: string, taskId: string, now = Date.now()): boolean => {
  const task = state.queues[projectId]?.tasks.find((entry) => entry.id === taskId);
  if (!task) return false;
  task.status = 'pending';
  task.finishedAt = null;
  task.error = null;
  task.createdAt = now;
  return true;
};

/**
 * Switch one task on or off for the scheduler. Returns false when nothing
 * changed, so a caller can skip the state write and the event. Switching a task
 * off never touches the queue's own switch: the two are independent, and a
 * stopped queue with tasks switched off simply has nothing to start.
 */
export const setTaskEnabled = (
  state: QueueState,
  projectId: string,
  taskId: string,
  enabled: boolean,
): boolean => {
  const task = state.queues[projectId]?.tasks.find((entry) => entry.id === taskId);
  if (!task || task.enabled === enabled) return false;
  task.enabled = enabled;
  return true;
};

export const clearTasks = (state: QueueState, projectId: string): boolean => {
  const queue = state.queues[projectId];
  if (!queue) return false;
  queue.tasks = [];
  normalizeQueue(queue);
  // Emptying the queue is a fresh start: a failure pause no longer has anything
  // to protect.
  const guard = queue.guard;
  if (guard) {
    delete guard.pause;
    guard.failures = 0;
  }
  return true;
};

export const setEnabled = (state: QueueState, projectId: string, enabled: boolean): boolean => {
  ensureQueue(state, projectId).enabled = enabled;
  return true;
};

/**
 * Remember a project and its queue. Returns false when this project was already
 * known under the same name and directory and its queue exists, so a caller can
 * skip a state write and a tick that would change nothing — the panel
 * re-registers on every mount, and that must not cost anything.
 */
export const registerProject = (state: QueueState, project: ProjectInfo): boolean => {
  const known = state.projects[project.id];
  if (known?.directory === project.directory && known?.name === project.name && state.queues[project.id]) {
    return false;
  }
  state.projects[project.id] = { ...project };
  ensureQueue(state, project.id);
  return true;
};

/**
 * The next task the scheduler may start: the first pending task that is still
 * switched on. A task the user switched off is skipped, not moved — it keeps
 * its place and its turn behind the ones that are on.
 */
export const firstPending = (queue: ProjectQueue): QueueTask | null =>
  queue.tasks.find((task) => task.status === 'pending' && task.enabled) ?? null;

/**
 * Hand a task over to a session: it leaves the queue at once (counted as done),
 * and the session is remembered as the active run so nothing else starts while
 * it is really executing.
 */
export const startTask = (
  state: QueueState,
  projectId: string,
  taskId: string,
  sessionId: string,
  options: { now?: number; baselineAt?: number } = {},
): void => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  if (!queue || !task) return;
  queue.tasks = queue.tasks.filter((entry) => entry.id !== taskId);
  queue.completed += 1;
  queue.active = {
    sessionId,
    startedAt: options.now ?? Date.now(),
    taskId,
    ...(options.baselineAt !== undefined ? { baselineAt: options.baselineAt } : {}),
  };
  // Deliberately not normalized here: an empty queue stays enabled while the
  // dispatched session runs, and turns itself off in finishRun.
};

/** The active session is no longer executing: the project is free again. */
export const finishRun = (state: QueueState, projectId: string): void => {
  const queue = state.queues[projectId];
  if (!queue?.active) return;
  queue.active = null;
  normalizeQueue(queue);
};

export const markFailed = (state: QueueState, projectId: string, taskId: string, error: string, now = Date.now()): void => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  if (!queue || !task) return;
  task.status = 'failed';
  task.finishedAt = now;
  task.error = error;
};

/** Activity of one session, as the host computes it. */
export type SessionActivity =
  | 'unknown'
  | 'idle'
  | 'running'
  | 'retrying'
  | 'waiting-permission'
  | 'waiting-question'
  /**
   * The turn paused, but work it left behind still runs — a backgrounded shell
   * command (or a subagent). OpenCode reports such a session as idle because the
   * agent is free to answer, yet the task is not finished: the result will wake
   * the session again. The queue must not treat that pause as the end.
   */
  | 'background';

/**
 * Whether one activity counts as occupied under a queue's idle policy. The
 * default policy is the queue's historical behaviour: a question is idle, a
 * permission prompt and a backgrounded command are not, and other sessions
 * hold the project.
 */
export const isOccupied = (
  activity: SessionActivity,
  policy: IdlePolicy = DEFAULT_IDLE_POLICY,
): boolean => {
  switch (activity) {
    case 'running':
    case 'retrying':
      return true;
    case 'waiting-permission':
      return policy.permissionBlocks;
    case 'waiting-question':
      return policy.questionBlocks;
    case 'background':
      return policy.backgroundBlocks;
    default:
      return false;
  }
};

/**
 * Status of the session this queue itself dispatched: `running` while it really
 * executes, `question` when it only stopped to ask the user something, and
 * `free` as soon as it is idle or gone. By default a question neither occupies
 * the project nor finishes the task, so the caller treats it as a finish — but
 * one that arms the longer settle window. Under an idle policy that makes a
 * question busy, it stays `running` instead.
 */
export type ActiveStatus = 'running' | 'free' | 'question';

export type TickObservation = {
  /** True when any non-archived session in the project is occupied. */
  projectBusy: boolean;
  activeStatus: ActiveStatus;
  /**
   * How long the project has been continuously free — no queue run in flight
   * and no occupied session — in milliseconds. The queue waits out the settle
   * window of this before it starts the next task, so a session that wakes up
   * inside the window resets the count.
   */
  idleMs: number;
  /**
   * The settle window to wait out before the next dispatch. Defaults to
   * `DISPATCH_DELAY_MS`; a caller arms `QUESTION_DISPATCH_DELAY_MS` after a run
   * that ended on a question.
   */
  settleMs?: number;
};

export type TickDecision =
  | { kind: 'wait' }
  | { kind: 'idle' }
  | { kind: 'finish' }
  | { kind: 'dispatch'; taskId: string };

/**
 * What the worker should do next for one project. Pure: callers own the clock
 * and the session list, so both drivers share one rule set.
 *
 * A `finish` decision is applied by the caller, which then asks again — that is
 * how the freed project reaches the next dispatch in the same tick.
 */
export const planTick = (queue: ProjectQueue, observation: TickObservation): TickDecision => {
  if (queue.active) {
    return observation.activeStatus === 'running' ? { kind: 'wait' } : { kind: 'finish' };
  }
  // A self-pause outranks an idle project: nothing is dispatched until the user
  // resumes the queue.
  if (queue.guard?.pause) return { kind: 'wait' };
  if (observation.projectBusy) return { kind: 'wait' };
  // Let the project settle before the next task: only a project that has been
  // free for the whole window counts, so anything that wakes up inside it pushes
  // the next dispatch out to a fresh window. The window is longer when the run
  // that just ended was waiting on a question.
  if (observation.idleMs < (observation.settleMs ?? DISPATCH_DELAY_MS)) return { kind: 'wait' };
  const next = firstPending(queue);
  return next ? { kind: 'dispatch', taskId: next.id } : { kind: 'idle' };
};

export type QueueCounts = {
  pending: number;
  failed: number;
  completed: number;
};

export const countTasks = (queue: ProjectQueue): QueueCounts => {
  const counts: QueueCounts = { pending: 0, failed: 0, completed: queue.completed };
  for (const task of queue.tasks) {
    if (task.status === 'pending') counts.pending += 1;
    else if (task.status === 'failed') counts.failed += 1;
  }
  return counts;
};

/**
 * Bring a queue loaded from disk up to the current schema: tasks from an older
 * `running` status are dropped (their session is still tracked by `active`),
 * and an image reference that no longer makes sense is dropped with them.
 */
export const repairQueue = (queue: ProjectQueue): ProjectQueue => {
  queue.tasks = (queue.tasks ?? [])
    .filter((task) => task?.status === 'pending' || task?.status === 'failed')
    .map((task) => {
      // A task written before tasks could be switched off has no `enabled` and
      // stays on, which is what every such task was until now.
      const next: QueueTask = {
        ...task,
        images: sanitizeImages(task?.images),
        enabled: task?.enabled !== false,
      };
      // An append target that no longer makes sense (a session id of the wrong
      // shape) is dropped, which turns the task back into an ordinary one.
      const target = sanitizeTarget(task?.target);
      if (target) next.target = target;
      else delete next.target;
      return next;
    });
  queue.completed = typeof queue.completed === 'number' && Number.isFinite(queue.completed) ? queue.completed : 0;
  if (queue.active && typeof queue.active.sessionId !== 'string') queue.active = null;
  // A run written before the task id was recorded keeps working without it; a
  // task id of the wrong shape is dropped on its own, leaving the run in place.
  if (queue.active && queue.active.taskId !== undefined && typeof queue.active.taskId !== 'string') {
    delete queue.active.taskId;
  }
  if (queue.active && queue.active.baselineAt !== undefined
    && (typeof queue.active.baselineAt !== 'number' || !Number.isFinite(queue.active.baselineAt))) {
    delete queue.active.baselineAt;
  }
  // A run written by the earlier prototype carried a task snapshot; the queue
  // no longer keeps one.
  if (queue.active && 'task' in queue.active) {
    delete (queue.active as { task?: unknown }).task;
  }
  // A queue customised before a setting existed gains the default for it; a
  // queue that never had settings stays on the service's own defaults.
  if (queue.settings !== undefined) queue.settings = sanitizeSettings(queue.settings);
  // Guard counters and a pause survive a restart.
  if (queue.guard !== undefined) queue.guard = repairGuard(queue.guard);
  return queue;
};

/** A guard read from disk, with every field valid. */
const repairGuard = (value: unknown): QueueGuard => {
  const raw = value && typeof value === 'object' ? value as {
    failures?: unknown;
    /** The previous shape may still carry `reason` and a `short-run` cause. */
    pause?: { at?: unknown; detail?: unknown; cause?: unknown; reason?: unknown };
  } : {};
  const guard: QueueGuard = {
    failures: typeof raw.failures === 'number' && Number.isFinite(raw.failures) ? Math.max(0, Math.round(raw.failures)) : 0,
  };
  const pause = raw.pause;
  if (pause && typeof pause.at === 'number' && Number.isFinite(pause.at)
    && typeof pause.detail === 'string') {
    // An older pause may still carry `reason`/`cause: 'short-run'`; it is a run
    // failure under the current shape.
    guard.pause = {
      at: pause.at,
      cause: pause.cause === 'dispatch' ? 'dispatch' : 'run',
      detail: pause.detail,
    };
  }
  return guard;
};

/**
 * Bring a whole state file up to the current schema. The first version stored
 * the composer as a plain string, so an older file is read as a draft without
 * images instead of being thrown away.
 */
export const repairState = (state: QueueState): QueueState => {
  state.projects ??= {};
  state.queues ??= {};
  state.drafts ??= {};
  for (const queue of Object.values(state.queues)) {
    if (queue && typeof queue === 'object') repairQueue(queue);
  }
  const drafts: Record<string, QueueDraft> = {};
  for (const [projectId, stored] of Object.entries(state.drafts as Record<string, unknown>)) {
    if (typeof stored === 'string') {
      drafts[projectId] = { text: stored, images: [] };
      continue;
    }
    if (stored && typeof stored === 'object') {
      const draft = stored as Partial<QueueDraft>;
      drafts[projectId] = {
        text: typeof draft.text === 'string' ? draft.text : '',
        images: sanitizeImages(draft.images),
      };
    }
  }
  state.drafts = drafts;
  return state;
};

/**
 * Every image id the state still refers to: the tasks in every queue plus the
 * queued-up composers. Anything else in the image store is garbage the service
 * may sweep — the ids are the only reference an image file has.
 */
export const referencedImageIds = (state: QueueState): Set<string> => {
  const ids = new Set<string>();
  for (const queue of Object.values(state.queues ?? {})) {
    for (const task of queue?.tasks ?? []) {
      for (const image of task?.images ?? []) ids.add(image.id);
    }
  }
  for (const draft of Object.values(state.drafts ?? {})) {
    for (const image of draft?.images ?? []) ids.add(image.id);
  }
  return ids;
};

/**
 * What a queue did. The service reports every change as one of these, in order,
 * so a client follows events instead of asking for state on a timer.
 */
export type QueueEventType =
  | 'project.registered'
  | 'queue.enabled'
  | 'queue.cleared'
  | 'task.enqueued'
  | 'task.edited'
  | 'task.removed'
  | 'task.moved'
  | 'task.retried'
  /** One task switched on or off for the scheduler — not the queue's own switch. */
  | 'task.enabled'
  | 'queue.settings'
  /** The queue stopped itself after repeated failed turns or failed dispatches. */
  | 'queue.paused'
  /** The user resumed a paused queue. */
  | 'queue.resumed'
  | 'run.started'
  /** The session ended with outcome `failed`; the task is not put back. */
  | 'run.failed'
  | 'run.finished'
  | 'task.failed';

/**
 * One entry in the service's event log. The log is one stream for the whole
 * service, not one per project: a client follows a single cursor, so opening a
 * different project never costs another reader. Each entry names its project and
 * carries that project's whole queue as it stands after the change, so a client
 * that missed earlier entries is still correct: the sequence number orders
 * events, it does not make them a delta.
 */
export type QueueEvent = {
  seq: number;
  at: number;
  projectId: string;
  type: QueueEventType;
  queue: ProjectQueue;
};

/** What a client needs to start following: one project's state plus the cursor. */
export type QueueSnapshot = {
  project: ProjectInfo | null;
  queue: ProjectQueue;
  /** The composer saved for this project. */
  draft: QueueDraft;
  seq: number;
};
