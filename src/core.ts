/**
 * Shared queue model and pure state transitions.
 *
 * The same module is bundled into the rail panel (browser IIFE) and into the
 * local service (Node ESM), so the queue behaves identically whether the panel
 * or the background worker is driving it.
 *
 * Statuses are only pending / failed: a task leaves the queue the moment its
 * session is created and is counted in `completed`. The dispatched session is
 * remembered as the active run only so nothing else starts while it works.
 */

export type TaskStatus = 'pending' | 'failed';

export type QueueTask = {
  id: string;
  /** The prompt. The only user-authored field. */
  text: string;
  status: TaskStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
};

/** The session the queue itself started, remembered until the project is free. */
export type ActiveRun = {
  sessionId: string;
  startedAt: number;
};

export type ProjectQueue = {
  enabled: boolean;
  /** Handed-off tasks so far. Tasks are removed at dispatch, so this is the running total. */
  completed: number;
  tasks: QueueTask[];
  active: ActiveRun | null;
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
};

export const STATE_VERSION = 1;

/** A dispatched session is "gone" only after the list has had time to catch up. */
export const ACTIVE_GRACE_MS = 15000;

export const emptyState = (): QueueState => ({
  version: STATE_VERSION,
  projects: {},
  queues: {},
});

export const emptyQueue = (): ProjectQueue => ({
  enabled: false,
  completed: 0,
  tasks: [],
  active: null,
});

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

export const makeTask = (text: string, now = Date.now()): QueueTask => ({
  id: nextId(),
  text: text.trim(),
  status: 'pending',
  createdAt: now,
  finishedAt: null,
  error: null,
});

export const enqueue = (state: QueueState, projectId: string, text: string, now = Date.now()): QueueTask | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const task = makeTask(trimmed, now);
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

export const editTask = (state: QueueState, projectId: string, taskId: string, text: string): boolean => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  const trimmed = text.trim();
  if (!queue || !task || !trimmed) return false;
  task.text = trimmed;
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

export const clearTasks = (state: QueueState, projectId: string): boolean => {
  const queue = state.queues[projectId];
  if (!queue) return false;
  queue.tasks = [];
  normalizeQueue(queue);
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

export const firstPending = (queue: ProjectQueue): QueueTask | null =>
  queue.tasks.find((task) => task.status === 'pending') ?? null;

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
  now = Date.now(),
): void => {
  const queue = state.queues[projectId];
  const task = queue?.tasks.find((entry) => entry.id === taskId);
  if (!queue || !task) return;
  queue.tasks = queue.tasks.filter((entry) => entry.id !== taskId);
  queue.completed += 1;
  queue.active = { sessionId, startedAt: now };
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
export type SessionActivity = 'unknown' | 'idle' | 'running' | 'retrying' | 'waiting-permission' | 'waiting-question';

/** A session is occupied when it is really executing, which a question is not. */
export const isOccupied = (activity: SessionActivity): boolean =>
  activity === 'running' || activity === 'retrying' || activity === 'waiting-permission';

/**
 * Status of the session this queue itself dispatched: `running` while it really
 * executes, `free` as soon as it is idle, gone, or only waiting on a question.
 */
export type ActiveStatus = 'running' | 'free';

export type TickObservation = {
  /** True when any non-archived session in the project is occupied. */
  projectBusy: boolean;
  activeStatus: ActiveStatus;
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
  if (observation.projectBusy) return { kind: 'wait' };
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
 * `running` status are dropped (their session is still tracked by `active`).
 */
export const repairQueue = (queue: ProjectQueue): ProjectQueue => {
  queue.tasks = (queue.tasks ?? []).filter((task) => task?.status === 'pending' || task?.status === 'failed');
  queue.completed = typeof queue.completed === 'number' && Number.isFinite(queue.completed) ? queue.completed : 0;
  if (queue.active && typeof queue.active.sessionId !== 'string') queue.active = null;
  return queue;
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
  | 'run.started'
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
  seq: number;
};

/** Short string used for storage keys, where a raw project id can be too long. */
export const hashKey = (value: string): string => {  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
