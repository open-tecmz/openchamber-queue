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
 *
 * A task is its prompt text plus the images attached to it. The bytes never
 * enter this state: an image is a reference into the service's own store (see
 * `TaskImage`), which is what keeps `state.json` small and writable in one go.
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

export type QueueTask = {
  id: string;
  /** The prompt text. */
  text: string;
  /** Images sent with the prompt, oldest first. Byte-free: see `TaskImage`. */
  images: TaskImage[];
  status: TaskStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
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
 * How long a project must stay free before the queue starts the next task.
 *
 * The queue lets the project settle first: nothing is dispatched until it has
 * been free for this whole window. Anything that wakes up inside the window —
 * another session, a permission retry, a follow-up on the session that just
 * finished — makes the count start over, so the next task only runs once the
 * project really is quiet.
 */
export const DISPATCH_DELAY_MS = 10000;

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

export const makeTask = (text: string, images: TaskImage[] = [], now = Date.now()): QueueTask => ({
  id: nextId(),
  text: text.trim(),
  images: sanitizeImages(images),
  status: 'pending',
  createdAt: now,
  finishedAt: null,
  error: null,
});

export const enqueue = (
  state: QueueState,
  projectId: string,
  text: string,
  images: TaskImage[] = [],
  now = Date.now(),
): QueueTask | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const task = makeTask(trimmed, images, now);
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
 * A session is occupied when it is really executing, which a question is not and
 * a backgrounded task is (the session is idle only because it handed the work to
 * the background; it is not done).
 */
export const isOccupied = (activity: SessionActivity): boolean =>
  activity === 'running' ||
  activity === 'retrying' ||
  activity === 'waiting-permission' ||
  activity === 'background';

/**
 * Status of the session this queue itself dispatched: `running` while it really
 * executes, `free` as soon as it is idle, gone, or only waiting on a question.
 */
export type ActiveStatus = 'running' | 'free';

export type TickObservation = {
  /** True when any non-archived session in the project is occupied. */
  projectBusy: boolean;
  activeStatus: ActiveStatus;
  /**
   * How long the project has been continuously free — no queue run in flight
   * and no occupied session — in milliseconds. The queue waits out
   * `DISPATCH_DELAY_MS` of this before it starts the next task, so a session
   * that wakes up inside the window resets the count.
   */
  idleMs: number;
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
  // Let the project settle before the next task: only a project that has been
  // free for the whole window counts, so anything that wakes up inside it pushes
  // the next dispatch out to a fresh window.
  if (observation.idleMs < DISPATCH_DELAY_MS) return { kind: 'wait' };
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
    .map((task) => ({ ...task, images: sanitizeImages(task?.images) }));
  queue.completed = typeof queue.completed === 'number' && Number.isFinite(queue.completed) ? queue.completed : 0;
  if (queue.active && typeof queue.active.sessionId !== 'string') queue.active = null;
  return queue;
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
  /** The composer saved for this project. */
  draft: QueueDraft;
  seq: number;
};
