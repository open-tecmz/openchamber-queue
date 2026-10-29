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
  type SessionSnapshot,
} from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountCheckbox,
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
  MAX_DELAY_MS,
  MAX_FAILURES_LIMIT,
  MAX_IMAGES_PER_TASK,
  countTasks,
  deriveTitle,
  emptyQueue,
  type IdlePolicy,
  type ProjectInfo,
  type ProjectQueue,
  type QueueDraft,
  type QueueEvent,
  type QueueSettingsPatch,
  type QueueSnapshot,
  type QueueTask,
  type TaskImage,
  settingsOf,
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
/**
 * The sequence `queue` was read or pushed at. A read answers with a snapshot of
 * one moment, and the event stream may have moved past it while it was in
 * flight, so an answer older than what is on screen is dropped instead of
 * painted over the newer state.
 */
let queueSeq = 0;
/** The last queue seen for each project, so switching back paints before the read answers. */
const knownQueues = new Map<string, ProjectQueue>();
/**
 * Which project the panel is showing, as a number that moves with every switch.
 * A read that started under another value answers for a project the user has
 * already left, and must not write anything: that is how a switch used to end up
 * showing the previous project, or the previous project's tasks under the new
 * name, whenever two switches overlapped.
 */
let projectToken = 0;
let renderKey = '';
let panelMounted = false;
let backgroundMounted = false;
let directoryRef: string | null = null;
/** The session open in the panel, tracked so an "append" task can target it. */
let currentSession: SessionSnapshot | null = null;
let editingId: string | null = null;
let draftText = '';
/** The images of the task being edited, as the editor shows them. */
let editingImages: ComposerImage[] = [];
/**
 * An image the panel holds while the composer does: the reference the service
 * stores, plus a preview and whether its bytes have arrived yet.
 */
type ComposerImage = TaskImage & {
  /** Small data-URL preview, or null while it is being made. */
  thumb: string | null;
  /** True until the bytes are in the service's image store. */
  uploading: boolean;
};

/** The composer images for the open project, kept across renders and mirrored to the service. */
let composerImages: ComposerImage[] = [];
/** The composer text for the open project, kept across renders and mirrored to the service. */
let composerDraft = '';
/**
 * Whether a task added from the composer starts enabled. It is the checkbox at
 * the end of the composer's caption line and only a panel preference, so it is
 * not persisted: the task carries it at enqueue and the queue stores it, per task.
 */
let newTaskEnabled = true;
/** The project `composerDraft` belongs to, so a refresh only adopts the service draft. */
let composerProject: string | null = null;
/** True when the composer has changed since it was last saved. */
let draftDirty = false;
/** The composer field has focus: hold queue-driven re-renders so typing is never disturbed. */
let composerFocused = false;
/**
 * The strip nodes, kept so a change made while the composer is frozen (a pasted
 * image) still reaches the screen: the strip redraws itself in place instead of
 * waiting for the next full render.
 */
let composerStrip: HTMLElement | null = null;
let editorStrip: HTMLElement | null = null;
/**
 * A frozen composer can hide a queue change. Setting this asks for one repaint
 * after the next click has finished bubbling — see the listener below.
 */
let catchUpAfterBlur = false;
/** True until the panel has read the queue for the first time. */
let loading = true;
/** The dispatch-settings section is open; kept across renders so events do not close it. */
let settingsOpen = false;
/** A settings field has focus: hold background re-renders so typing is not disturbed. */
let settingsFocused = false;

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

/** Tell the user why a control did nothing: no control has an inline error slot. */
const reportError = (error: unknown): void => {
  void host.toast({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
};

/** Runs `task` with the button spun up until it settles. */
const withLoading = (handle: ButtonHandle, task: () => Promise<void>): void => {
  handle.update({ loading: true });
  void task()
    .catch(reportError)
    .finally(() => handle.update({ loading: false }));
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
    const draft = data.draft && typeof data.draft === 'object' ? data.draft : { text: '', images: [] };
    return {
      project: data.project ?? null,
      queue: data.queue,
      draft: {
        text: typeof draft.text === 'string' ? draft.text : '',
        images: Array.isArray(draft.images) ? draft.images : [],
      },
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
  /**
   * Image uploads. One image travels in chunks because the host caps a single
   * request body at 64 kB; the service assembles them into its own store.
   */
  async imageBegin(id: string, name: string, mime: string): Promise<void> {
    await this.request('POST', '/image/begin', undefined, JSON.stringify({ id, name, mime }));
  },
  async imageChunk(id: string, data: string): Promise<void> {
    await this.request('POST', '/image/chunk', undefined, JSON.stringify({ id, data }));
  },
  async imageEnd(id: string, thumb: string | null): Promise<TaskImage> {
    const data = await this.request<{ image?: TaskImage }>(
      'POST',
      '/image/end',
      undefined,
      JSON.stringify({ id, thumb }),
    );
    if (!data.image) throw new Error('the service did not return the stored image');
    return data.image;
  },
  async imageAbort(id: string): Promise<void> {
    await this.request('POST', '/image/abort', undefined, JSON.stringify({ id }));
  },
  /** The preview the service kept for an image (a draft restored after a reload). */
  async thumb(id: string): Promise<string | null> {
    const data = await this.request<{ thumb?: string | null }>('GET', `/image/${id}/thumb`);
    return typeof data.thumb === 'string' ? data.thumb : null;
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

/** The stored form of an image the panel holds. */
const toTaskImage = (image: ComposerImage): TaskImage => ({
  id: image.id,
  name: image.name,
  mime: image.mime,
  size: image.size,
});

/** The images a draft should carry: only the ones whose bytes have arrived. */
const storedComposerImages = (): TaskImage[] =>
  composerImages.filter((image) => !image.uploading).map(toTaskImage);

/** What the composer holds, as one comparable string. */
const draftSignature = (): string =>
  `${composerDraft}\u0000${storedComposerImages().map((image) => image.id).join(',')}`;

/**
 * Write the draft for `projectId` to the service, which owns it on disk. Best
 * effort: a failure is retried by the next keystroke, and nothing depends on it.
 */
const persistDraft = async (
  projectId: string,
  draft: QueueDraft,
  signature: string,
): Promise<void> => {
  if (mode !== 'backend') return;
  try {
    await backend.command(projectId, { op: 'set-draft', text: draft.text, images: draft.images });
    if (composerProject === projectId && draftSignature() === signature) draftDirty = false;
  } catch {
    // Leave `draftDirty` set so a later keystroke or flush tries again.
  }
};

/** Arm (or re-arm) the debounced write of the current draft. */
const scheduleDraftSave = (): void => {
  if (!project || mode !== 'backend' || !draftDirty) return;
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  const projectId = project.id;
  const draft: QueueDraft = { text: composerDraft, images: storedComposerImages() };
  const signature = draftSignature();
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = null;
    void persistDraft(projectId, draft, signature);
  }, DRAFT_SAVE_MS);
};

/** Write the current draft now — at a switch, hide or exit — instead of waiting. */
const flushDraftSave = (): void => {
  if (draftSaveTimer !== null) {
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  if (composerProject && draftDirty) {
    void persistDraft(
      composerProject,
      { text: composerDraft, images: storedComposerImages() },
      draftSignature(),
    );
  }
};

/** Forget the current draft (a project switch, or the panel going away). */
const resetDraft = (): void => {
  if (draftSaveTimer !== null) {
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  composerDraft = '';
  composerImages = [];
  composerProject = null;
  draftDirty = false;
  composerFocused = false;
  catchUpAfterBlur = false;
  refreshComposerStrip();
};

// ---------------------------------------------------------------------------
// Composer images
// ---------------------------------------------------------------------------

/**
 * Images are the one part of a task the panel cannot hand over as plain text.
 * They are uploaded to the service's own store first (in chunks, because the
 * host caps one request body at 64 kB) and the task then names them; the queue
 * state only ever carries the reference.
 *
 * Limits mirror the service's, so a file the panel accepts is one it will take.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_CHUNK_CHARS = 48000;
/** Longest edge of the preview the strip draws; the session gets the original. */
const THUMB_MAX_EDGE = 160;
/**
 * A preview travels back with the upload in the same request body the host caps
 * at 64 kB, so a picture that would not fit is drawn smaller or dropped.
 */
const THUMB_MAX_CHARS = 40000;

/** `btoa` on a whole image would blow the argument limit: encode in slabs. */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const slab = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += slab) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + slab));
  }
  return btoa(binary);
};

/** Draw the bitmap at `edge` px and encode it; null when the canvas refuses. */
const drawThumb = (bitmap: ImageBitmap, edge: number, quality: number): string | null => {
  try {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    // Screenshots are often transparent PNGs; the strip shows them on white.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
};

/**
 * A small preview for the strip. Best effort: an image the browser cannot draw
 * still uploads, and its chip shows the file name instead.
 */
const makeThumbnail = async (file: File): Promise<string | null> => {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  let thumb = drawThumb(bitmap, THUMB_MAX_EDGE, 0.72);
  if (thumb && thumb.length > THUMB_MAX_CHARS) thumb = drawThumb(bitmap, 96, 0.6);
  bitmap.close?.();
  return thumb && thumb.length <= THUMB_MAX_CHARS ? thumb : null;
};

const formatMegabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/** One attached image: its preview, its name and a way to drop it. */
const imageChip = (image: ComposerImage, onRemove: (() => void) | null): HTMLElement => {
  const chip = el('div', `qx-image${image.uploading ? ' qx-image-uploading' : ''}`);
  if (image.thumb) {
    const thumb = document.createElement('img');
    thumb.className = 'qx-image-thumb';
    thumb.src = image.thumb;
    thumb.alt = '';
    chip.appendChild(thumb);
  } else {
    chip.appendChild(el('span', 'qx-image-thumb qx-image-thumb-empty'));
  }
  const name = el('span', 'qx-image-name', image.uploading ? t('composer.image.uploading') : image.name);
  name.title = image.name;
  chip.appendChild(name);
  if (onRemove && !image.uploading) {
    const remove = el('button', 'qx-image-remove', '\u00d7') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = t('composer.image.remove');
    remove.setAttribute('aria-label', t('composer.image.remove'));
    remove.addEventListener('click', (event) => {
      // The row behind the strip may open the editor; dropping an image does not.
      event.stopPropagation();
      onRemove();
    });
    chip.appendChild(remove);
  }
  return chip;
};

/**
 * Draw a strip in place. A strip is never rebuilt by a render while the field
 * it belongs to has focus — the render is held back so typing is not disturbed
 * — so it redraws itself whenever what it shows changes.
 */
const drawImageStrip = (
  host: HTMLElement,
  images: readonly ComposerImage[],
  onRemove: ((id: string) => void) | null,
): void => {
  host.textContent = '';
  host.hidden = images.length === 0;
  for (const image of images) {
    host.appendChild(imageChip(image, onRemove ? () => onRemove(image.id) : null));
  }
};

const refreshComposerStrip = (): void => {
  if (composerStrip) drawImageStrip(composerStrip, composerImages, removeComposerImage);
};

const refreshEditorStrip = (): void => {
  if (editorStrip) drawImageStrip(editorStrip, editingImages, removeEditorImage);
};

/** The composer changed: keep it as the draft and write it soon. */
const touchComposer = (): void => {
  composerProject = project?.id ?? null;
  draftDirty = true;
  scheduleDraftSave();
};

const removeComposerImage = (id: string): void => {
  composerImages = composerImages.filter((image) => image.id !== id);
  refreshComposerStrip();
  touchComposer();
};

const removeEditorImage = (id: string): void => {
  editingImages = editingImages.filter((image) => image.id !== id);
  refreshEditorStrip();
};

/** The preview the service kept, for an image restored from a draft. */
const loadThumb = async (image: ComposerImage, owner: string): Promise<void> => {
  if (image.thumb) return;
  try {
    const thumb = await backend.thumb(image.id);
    // The composer may have moved on (another project, another draft) since.
    if (!thumb || composerProject !== owner || !composerImages.includes(image)) return;
    image.thumb = thumb;
    refreshComposerStrip();
  } catch {
    // No preview: the chip shows the name.
  }
};

/**
 * Upload one image to the service's store. The chip appears at once and shows
 * that it is still arriving; a failure takes it away again and says so.
 */
const uploadImage = async (file: File): Promise<void> => {
  const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const image: ComposerImage = {
    id,
    name: file.name || t('composer.image.untitled'),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    thumb: null,
    uploading: true,
  };
  composerImages = [...composerImages, image];
  refreshComposerStrip();
  beginPending();
  let started = false;
  try {
    image.thumb = await makeThumbnail(file);
    refreshComposerStrip();
    const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    await backend.imageBegin(id, image.name, image.mime);
    started = true;
    for (let offset = 0; offset < base64.length; offset += IMAGE_CHUNK_CHARS) {
      await backend.imageChunk(id, base64.slice(offset, offset + IMAGE_CHUNK_CHARS));
    }
    const stored = await backend.imageEnd(id, image.thumb);
    image.name = stored.name;
    image.mime = stored.mime;
    image.size = stored.size;
    image.uploading = false;
    // The draft has to name the image for the sweep to keep it.
    touchComposer();
  } catch {
    composerImages = composerImages.filter((entry) => entry.id !== id);
    if (started) await backend.imageAbort(id).catch(() => undefined);
    await host.toast({ kind: 'error', message: t('composer.image.failed') });
  } finally {
    endPending();
    refreshComposerStrip();
  }
};

/** Attach files the user picked, pasted or dropped. */
const addImageFiles = async (files: readonly File[]): Promise<void> => {
  if (!project || mode === 'unknown' || files.length === 0) return;
  const images = files.filter((file) => file.type.startsWith('image/') && file.size > 0);
  if (images.length === 0) return;
  const room = MAX_IMAGES_PER_TASK - composerImages.length;
  if (images.length > room) {
    await host.toast({ kind: 'info', message: t('composer.image.tooMany', { n: MAX_IMAGES_PER_TASK }) });
  }
  for (const file of images.slice(0, Math.max(0, room))) {
    if (file.size > MAX_IMAGE_BYTES) {
      await host.toast({
        kind: 'error',
        message: t('composer.image.tooLarge', { max: formatMegabytes(MAX_IMAGE_BYTES) }),
      });
      continue;
    }
    await uploadImage(file);
  }
};

/** A paste that carries an image attaches it instead of being dropped. */
const handleComposerPaste = (event: ClipboardEvent): void => {
  const data = event.clipboardData;
  if (!data) return;
  const files = [...data.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length === 0) return;
  // Text in the same paste still lands in the field; the image joins the task.
  if (!data.getData('text/plain')) event.preventDefault();
  void addImageFiles(files);
};

/** The hidden picker behind the "Add image" button. */
const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.accept = 'image/*';
filePicker.multiple = true;
filePicker.hidden = true;
filePicker.addEventListener('change', () => {
  const files = [...(filePicker.files ?? [])];
  filePicker.value = '';
  void addImageFiles(files);
});
document.body.appendChild(filePicker);

// Dropping an image anywhere on the panel attaches it to the composer.
document.addEventListener('dragover', (event) => {
  if (!panelMounted || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (event) => {
  if (!panelMounted) return;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  void addImageFiles(files);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const pushCommand = async (command: Record<string, unknown>): Promise<void> => {
  const current = project;
  if (!current) return;
  if (mode === 'unknown') {
    // Every control in the panel goes through here, so a queue reported as
    // unreachable would otherwise swallow the click in silence and read as a
    // dead button. Say why nothing happened instead.
    await host.toast({ kind: 'error', message: t('toast.connecting') });
    return;
  }
  beginPending();
  try {
    // A command answers as soon as it applied its change, before the dispatch it
    // may have enabled: an event may already be ahead of that answer, so what it
    // carries is only taken when it is the newest thing for this project.
    const result = await backend.command(current.id, command);
    if (project === current && result.queue && result.seq >= queueSeq) {
      queue = result.queue;
      queueSeq = result.seq;
      seq = Math.max(seq, result.seq);
      rememberQueue();
    }
    publish();
  } finally {
    endPending();
  }
};

/** A command from a control with nowhere to show a failure: report it instead of dropping it. */
const runCommand = (command: Record<string, unknown>): void => {
  void pushCommand(command).catch(reportError);
};

/**
 * "Run now": create a session with the composer immediately instead of
 * queueing it. The service owns dispatch, so the command is all this sends.
 */
const runNow = async (text: string, images: TaskImage[]): Promise<boolean> => {
  const trimmed = text.trim();
  if (!trimmed || !project) return false;
  if (mode === 'unknown') {
    await host.toast({ kind: 'error', message: t('toast.connecting') });
    return false;
  }
  beginPending();
  try {
    await backend.command(project.id, { op: 'run-now', text: trimmed, images });
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

// ---------------------------------------------------------------------------
// Project list: the host pushes it, so a switch costs a lookup, not a request
// ---------------------------------------------------------------------------

/**
 * The host's projects as it last pushed them, keyed by directory.
 *
 * Switching projects used to ask the host for this list every time, which put a
 * second round trip in front of the read of the new project's queue — and, when
 * the host answered late or not at all, resolved the directory to a made-up id
 * (`dir:<path>`) whose queue was empty, so the panel looked as if it had not
 * switched at all. The host already pushes the list on subscribe and whenever it
 * changes, so the answer is here before the user switches.
 */
let projectsByDirectory = new Map<string, ProjectInfo>();

/** Replace the cached list; one snapshot is the whole truth about it. */
const rememberProjects = (projects: readonly { id: string; name: string; directory: string }[]): void => {
  const next = new Map<string, ProjectInfo>();
  for (const entry of projects) {
    next.set(entry.directory, { id: entry.id, directory: entry.directory, name: entry.name });
  }
  projectsByDirectory = next;
};

/** The cached project for a directory, if the host has named it. */
const cachedProject = (dir: string): ProjectInfo | null => projectsByDirectory.get(dir) ?? null;

/** Read the host's project list once, for a directory the push has not named. */
const readProjects = async (): Promise<void> => {
  try {
    const snapshot = await host.listProjects();
    if (snapshot.state === 'ready') rememberProjects(snapshot.projects);
  } catch {
    // Keep the last list; the caller falls back to the directory itself.
  }
};

/** Follow the host's project list so a switch is answered from memory. */
const followProjects = async (): Promise<void> => {
  try {
    await host.onProjects((snapshot) => {
      if (snapshot.state === 'ready') rememberProjects(snapshot.projects);
    });
  } catch {
    // An older host, or a refused subscription: `resolveTarget` reads the list.
  }
};

/** The last path segment, shown while a directory is still being resolved. */
const folderName = (dir: string): string => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;

// ---------------------------------------------------------------------------
// Painting state
// ---------------------------------------------------------------------------

/** The count last sent to the host, so an unchanged badge costs nothing. */
let badgeValue: number | null = null;

/**
 * Show whatever the model currently holds: the panel first, then the rail badge.
 * The badge is a host round trip, and waiting for it before painting made every
 * update — a project switch included — arrive a message late for no reason.
 */
const publish = (): void => {
  render();
  const next = countTasks(queue).pending;
  if (next === badgeValue) return;
  badgeValue = next;
  void host.setBadge(next).catch(() => {
    // Leave the value unstored so the next publish tries again.
    badgeValue = null;
  });
};

/** Keep the queue the screen shows, so a switch back has something to paint. */
const rememberQueue = (): void => {
  if (project) knownQueues.set(project.id, queue);
};

const refresh = async (): Promise<void> => {
  const token = projectToken;
  const current = project;
  if (!current) {
    loading = false;
    render();
    return;
  }
  try {
    const loaded = await backend.load(current.id);
    // The user may have switched while this read was in flight: its answer is
    // about a project that is no longer on screen.
    if (token !== projectToken || project !== current) return;
    loading = false;
    // A read is a snapshot of one moment; the event stream may have moved past
    // it meanwhile, and what it delivered is the newer state.
    if (loaded.seq >= queueSeq) {
      queue = loaded.queue;
      queueSeq = loaded.seq;
      seq = Math.max(seq, loaded.seq);
      rememberQueue();
    }
    if (composerProject === project.id) {
      // This project's draft is already loaded. Keep what the user has typed
      // even if it is still unsaved (the service may only just have come up),
      // and push it so the two agree.
      if (draftDirty) scheduleDraftSave();
    } else {
      // First read for this project: take the draft the service has on disk,
      // which is what survives a reload, an OpenChamber restart or a hard exit.
      composerDraft = loaded.draft.text;
      composerImages = loaded.draft.images.map((image) => ({ ...image, thumb: null, uploading: false }));
      composerProject = project.id;
      draftDirty = false;
      // The previews came back as names only; ask the service for its copies.
      const owner = project.id;
      for (const image of composerImages) void loadThumb(image, owner);
    }
  } catch (error) {
    if (token !== projectToken) return;
    loading = false;
    // The service may have gone away; switch to the connecting state and let
    // the slow retry bring it back. Keep the last known queue on screen.
    if (isNoService(error)) await applyMode();
  }
  publish();
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
    // The cursor points into a log this service no longer has: start over, so
    // the read that follows is the newest thing known about the open project.
    seq = 0;
    queueSeq = 0;
    await refresh();
    return;
  }
  let changed = false;
  for (const event of batch.events) {
    if (project && event.projectId === project.id && event.seq >= queueSeq) {
      queue = event.queue;
      queueSeq = event.seq;
      changed = true;
    }
  }
  seq = Math.max(seq, batch.seq);
  if (changed) {
    rememberQueue();
    publish();
  }
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
  // A service that just answered health can still refuse this; the project is
  // registered again the next time the mode upgrades or the user switches.
  if (mode === 'backend' && project) await registerProject(project).catch(() => undefined);
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

// A click that blurred the frozen composer is done by the time it bubbles here,
// so its button or row has already handled it. Only now is it safe to repaint
// and show whatever the queue became while the box held focus.
document.addEventListener('click', () => {
  if (!catchUpAfterBlur) return;
  catchUpAfterBlur = false;
  if (!composerFocused) render();
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
  options: {
    field?: string;
    /** Accessible name, for a field whose caption is drawn by the caller. */
    ariaLabel?: string;
    onFocus?: () => void;
    onBlur?: () => void;
    onPaste?: (event: ClipboardEvent) => void;
  } = {},
): TextFieldHandle => {
  const field = mountTextField(root, initial);
  const input = root.lastElementChild?.querySelector('textarea.oc-sdk-input') ?? null;
  if (!(input instanceof HTMLTextAreaElement)) return field;

  if (options.field) input.dataset.qxField = options.field;
  if (options.ariaLabel) input.setAttribute('aria-label', options.ariaLabel);
  if (options.onFocus) input.addEventListener('focus', options.onFocus);
  if (options.onBlur) input.addEventListener('blur', options.onBlur);
  if (options.onPaste) input.addEventListener('paste', options.onPaste as EventListener);

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
  editingImages = task.images.map((image) => ({ ...image, thumb: null, uploading: false }));
  renderKey = '';
  render();
  // The previews are the service's copies; fill them in behind the editor.
  const owner = task.id;
  for (const image of editingImages) {
    void backend.thumb(image.id).then((thumb) => {
      if (!thumb || editingId !== owner || !editingImages.includes(image)) return;
      image.thumb = thumb;
      refreshEditorStrip();
    }).catch(() => undefined);
  }
};

const endEdit = (): void => {
  editingId = null;
  draftText = '';
  editingImages = [];
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
    queue: editingId !== null ? 'editing' : composerFocused || settingsFocused ? 'composing' : queue,
  });

/** A settle window in the compact form the panel shows: seconds or whole minutes. */
const formatDelay = (ms: number): string =>
  ms >= 60000 && ms % 60000 === 0
    ? t('settings.minutes', { n: ms / 60000 })
    : t('settings.seconds', { n: Math.round(ms / 1000) });

/** Send one partial settings change; the service merges it into the queue's own. */
const commitSettings = (patch: QueueSettingsPatch): void => {
  if (!project || mode === 'unknown') {
    void host.toast({ kind: 'error', message: t('toast.connecting') });
    return;
  }
  // No explicit save button: the change is written to the service as soon as it
  // is committed, and the toast is the confirmation the panel otherwise lacks.
  void (async () => {
    try {
      await pushCommand({ op: 'set-settings', settings: patch });
      await host.toast({ kind: 'success', message: t('settings.saved') });
    } catch (error) {
      await host.toast({
        kind: 'error',
        message: t('settings.saveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  })();
};

/** How one numeric settings field maps its stored value to and from the box. */
type NumberFieldOptions = {
  min: number;
  max: number;
  helper: string;
  invalid: string;
  toField: (value: number) => number;
  fromField: (value: number) => number;
  onCommit: (value: number) => void;
};

/**
 * A numeric settings field. The value is committed on blur or Enter, never per
 * keystroke: every commit is a state write and an event, and a half-typed
 * number is not a setting. A value outside the accepted range is refused with a
 * message and the stored value stays in force.
 */
const mountNumberField = (
  host: HTMLElement,
  field: string,
  label: string,
  initial: number,
  options: NumberFieldOptions,
): void => {
  const shown = (): string => String(Math.round(options.toField(initial)));
  let current = shown();
  const text = mountTextField(host, {
    label,
    value: current,
    helper: options.helper,
    onChange: (value) => {
      current = value;
    },
  });
  disposables.push(text);
  const input = host.lastElementChild?.querySelector('input.oc-sdk-input') ?? null;
  if (!(input instanceof HTMLInputElement)) return;
  input.dataset.qxField = field;
  input.inputMode = 'numeric';
  input.autocomplete = 'off';

  input.addEventListener('focus', () => {
    settingsFocused = true;
    // Seal the render key: a background event must not rebuild this field while
    // it is being edited.
    renderKey = computeRenderKey();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      current = input.value = shown();
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    settingsFocused = false;
    const value = Number(current.trim());
    if (!/^\d+$/.test(current.trim()) || value < options.min || value > options.max) {
      text.update({ value: current, error: options.invalid });
      return;
    }
    text.update({ value: current, error: undefined });
    const stored = options.fromField(value);
    if (stored !== initial) options.onCommit(stored);
  });
};

/** A seconds field for one settle window. */
const mountSecondsField = (
  host: HTMLElement,
  field: string,
  label: string,
  initialMs: number,
  onCommit: (ms: number) => void,
): void => {
  mountNumberField(host, field, label, initialMs, {
    min: 1,
    max: 86400,
    helper: t('settings.range'),
    invalid: t('settings.invalid'),
    toField: (ms) => ms / 1000,
    fromField: (seconds) => Math.round(seconds) * 1000,
    onCommit,
  });
};

/**
 * The background wait in minutes, where 0 keeps waiting for as long as the
 * command runs. Minutes rather than seconds: the useful values here are whole
 * minutes, and the stored setting is the same milliseconds either way.
 */
const mountBackgroundTimeoutField = (
  host: HTMLElement,
  field: string,
  label: string,
  initialMs: number,
  onCommit: (ms: number) => void,
): void => {
  const maxMinutes = MAX_DELAY_MS / 60000;
  mountNumberField(host, field, label, initialMs, {
    min: 0,
    max: maxMinutes,
    helper: t('settings.backgroundHelper', { max: maxMinutes }),
    invalid: t('settings.backgroundInvalid', { max: maxMinutes }),
    toField: (ms) => ms / 60000,
    fromField: (minutes) => Math.round(minutes) * 60000,
    onCommit,
  });
};

/** A whole-number field for the failure limit, where 0 turns the breaker off. */
const mountFailureLimitField = (
  host: HTMLElement,
  field: string,
  label: string,
  initial: number,
  onCommit: (value: number) => void,
): void => {
  mountNumberField(host, field, label, initial, {
    min: 0,
    max: MAX_FAILURES_LIMIT,
    helper: t('settings.countHelper', { max: MAX_FAILURES_LIMIT }),
    invalid: t('settings.countInvalid', { max: MAX_FAILURES_LIMIT }),
    toField: (value) => value,
    fromField: (value) => Math.round(value),
    onCommit,
  });
};

/**
 * The per-queue dispatch settings: two settle windows and what counts as a busy
 * project. Collapsed by default so the rail stays quiet; the summary always
 * shows the values in force.
 */
const renderSettings = (host: HTMLElement): void => {
  const settings = settingsOf(queue);
  const details = document.createElement('details') as HTMLDetailsElement;
  details.className = 'qx-settings';
  details.open = settingsOpen;
  details.addEventListener('toggle', () => {
    settingsOpen = details.open;
  });
  host.appendChild(details);

  const summary = details.appendChild(el('summary', 'qx-settings-summary'));
  summary.appendChild(el('span', 'qx-settings-title', t('settings.title')));
  summary.appendChild(el('span', 'qx-settings-values', t('settings.summary', {
    dispatch: formatDelay(settings.dispatchDelayMs),
    question: formatDelay(settings.questionDelayMs),
  })));

  const body = details.appendChild(el('div', 'qx-settings-body'));
  const delays = body.appendChild(el('div', 'qx-settings-delays'));
  const dispatchHost = delays.appendChild(el('div'));
  mountSecondsField(dispatchHost, 'settings-dispatch', t('settings.dispatch'), settings.dispatchDelayMs, (ms) =>
    commitSettings({ dispatchDelayMs: ms }));
  const questionHost = delays.appendChild(el('div'));
  mountSecondsField(questionHost, 'settings-question', t('settings.question'), settings.questionDelayMs, (ms) =>
    commitSettings({ questionDelayMs: ms }));

  body.appendChild(el('div', 'qx-settings-idle', t('settings.guard')));
  body.appendChild(el('div', 'qx-settings-idle qx-settings-hint', t('settings.guardHint')));
  const guardFields = body.appendChild(el('div', 'qx-settings-delays'));
  const failuresHost = guardFields.appendChild(el('div'));
  mountFailureLimitField(failuresHost, 'settings-max-failures', t('settings.maxFailures'), settings.maxFailures, (value) =>
    commitSettings({ maxFailures: value }));
  // A background command is the other way a run can hold a project open without
  // progress: the limit is what stops a command that never exits from doing so.
  const backgroundHost = guardFields.appendChild(el('div'));
  mountBackgroundTimeoutField(
    backgroundHost,
    'settings-background-timeout',
    t('settings.backgroundTimeout'),
    settings.backgroundTimeoutMs,
    (ms) => commitSettings({ backgroundTimeoutMs: ms }),
  );

  body.appendChild(el('div', 'qx-settings-idle', t('settings.idle')));
  const boxes = body.appendChild(el('div', 'qx-settings-boxes'));
  const options: Array<{ key: keyof IdlePolicy; label: string }> = [
    { key: 'questionBlocks', label: t('settings.idleQuestion') },
    { key: 'permissionBlocks', label: t('settings.idlePermission') },
    { key: 'backgroundBlocks', label: t('settings.idleBackground') },
    { key: 'otherSessionsBlock', label: t('settings.idleOther') },
  ];
  for (const option of options) {
    const box = mountCheckbox(boxes, {
      label: option.label,
      checked: settings.idle[option.key],
      onChange: (next) => {
        const idle: Partial<IdlePolicy> = {};
        idle[option.key] = next;
        commitSettings({ idle });
      },
    });
    disposables.push(box);
  }
};

const render = (): void => {
  if (!panelMounted) return;
  const key = computeRenderKey();
  if (key === renderKey) return;
  renderKey = key;
  // A full repaint is the catch-up the blur asked for, whenever it happens.
  catchUpAfterBlur = false;

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
  // Both strips live inside the DOM that was just thrown away; the render below
  // re-creates the one it needs.
  composerStrip = null;
  editorStrip = null;

  // The first read can take a moment: show that something is happening instead
  // of an empty rail. A switch paints the project it is opening at once, so the
  // name on screen is already the new one while its queue is on the way.
  if (loading) {
    if (project) {
      const head = root.appendChild(el('div', 'qx-controls'));
      const row = head.appendChild(el('div', 'qx-title-row'));
      row.appendChild(el('span', 'qx-title', t('title')));
      row.appendChild(el('span', 'qx-project', project.name || project.directory));
    }
    const loadingHost = root.appendChild(el('div', 'qx-loading'));
    disposables.push(mountSpinner(loadingHost, { label: t('loading') }));
    return;
  }

  const counts = countTasks(queue);
  const settings = settingsOf(queue);
  const guard = queue.guard;

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
    // The failure streak is a state, not a count: it used to sit here as an
    // "n/max errors" badge that looked like a control but offered nothing to
    // click. The banner below reports it once the queue actually pauses, next to
    // the one action that matters, so the title row keeps only real task counts.
    disposables.push(mountBadge(countsRow, { label: t('count.pending', { n: counts.pending }), tone: 'neutral' }));
    if (counts.failed > 0) {
      disposables.push(mountBadge(countsRow, { label: t('count.failed', { n: counts.failed }), tone: 'error' }));
    }
    disposables.push(mountBadge(countsRow, { label: t('count.completed', { n: counts.completed }), tone: 'success' }));
  }

  if (mode === 'unknown') {
    disposables.push(mountBanner(controls, { tone: 'warning', title: t('banner.error.title'), body: t('banner.error.body') }));
  }

  if (!project) {
    disposables.push(mountEmpty(root, { title: t('empty.noProject.title'), body: t('empty.noProject.body') }));
    return;
  }

  const pause = guard?.pause;
  if (pause) {
    const count = guard?.failures || settings.maxFailures;
    const body = pause.cause === 'dispatch'
      ? t('banner.pause.dispatchBody', { n: count, detail: pause.detail })
      : t('banner.pause.runBody', { n: count, detail: pause.detail });
    disposables.push(mountBanner(controls, {
      tone: 'warning',
      title: t('banner.pause.title'),
      body,
      action: {
        label: t('banner.pause.resume'),
        onClick: () => runCommand({ op: 'resume' }),
      },
    }));
  }

  const switchHost = controls.appendChild(el('div', 'qx-switch'));
  disposables.push(mountSwitch(switchHost, {
    label: t('switch.label'),
    description: queue.enabled
      ? t('switch.on', { delay: formatDelay(settings.dispatchDelayMs), question: formatDelay(settings.questionDelayMs) })
      : t('switch.off'),
    checked: queue.enabled,
    onChange: (next) => runCommand({ op: 'set-enabled', enabled: next }),
  }));

  renderSettings(controls);

  const composer = controls.appendChild(el('div', 'qx-composer'));
  // The strip sits above the field, the way the app's own composer shows what
  // is attached. It is drawn in place, not by a render, so an image attached
  // while the field has focus appears at once.
  composerStrip = composer.appendChild(el('div', 'qx-images'));
  // The field's caption is drawn here rather than by the SDK, so the "new tasks
  // are enabled" switch can sit at the end of that same line: the SDK wraps its
  // label in the field's own <label>, where another control would take over the
  // click meant for the input.
  const composerHead = composer.appendChild(el('div', 'qx-composer-head'));
  composerHead.appendChild(el('span', 'qx-composer-label', t('composer.label')));
  const newTaskBox = mountCheckbox(composerHead, {
    label: t('composer.enabled'),
    checked: newTaskEnabled,
    onChange: (next) => {
      newTaskEnabled = next;
      newTaskBox.update({ checked: next });
    },
  });
  disposables.push(newTaskBox);
  const field = mountGrowingField(
    composer,
    {
      value: composerDraft,
      placeholder: t('composer.placeholder'),
      multiline: true,
      rows: 3,
      onChange: (value) => {
        composerDraft = value;
        field.update({ value });
        touchComposer();
      },
    },
    {
      field: 'composer',
      ariaLabel: t('composer.label'),
      onPaste: handleComposerPaste,
      onFocus: () => {
        composerFocused = true;
        // Seal the render key so the next background queue event is a no-op for
        // this field: rebuilding it would drop the caret and break an
        // in-progress IME composition.
        renderKey = computeRenderKey();
      },
      onBlur: () => {
        composerFocused = false;
        // Repainting here would replace the button or row the user is clicking,
        // before its `click` handler runs — the click would then do nothing.
        // Mark a catch-up instead; the document listener below repaints once the
        // click has finished bubbling.
        catchUpAfterBlur = true;
      },
    },
  );
  disposables.push(field);
  refreshComposerStrip();
  const composerActions = composer.appendChild(el('div', 'qx-composer-actions'));

  /** True while an image is still on its way to the service. */
  const uploading = (): boolean => composerImages.some((image) => image.uploading);

  // Empty the composer and persist it before a command repaints the panel, so
  // the repaint never resurrects the task it just consumed.
  const clearComposer = (): void => {
    composerDraft = '';
    composerImages = [];
    composerProject = project?.id ?? null;
    draftDirty = true;
    field.update({ value: '' });
    refreshComposerStrip();
    flushDraftSave();
  };
  const restoreComposer = (text: string, images: ComposerImage[]): void => {
    composerDraft = text;
    composerImages = images;
    composerProject = project?.id ?? null;
    draftDirty = true;
    field.update({ value: text });
    refreshComposerStrip();
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
        if (uploading()) {
          await host.toast({ kind: 'info', message: t('composer.image.wait') });
          return;
        }
        const images = composerImages.slice();
        clearComposer();
        if (!(await runNow(text, images.map(toTaskImage)))) restoreComposer(text, images);
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
        if (uploading()) {
          await host.toast({ kind: 'info', message: t('composer.image.wait') });
          return;
        }
        const images = composerImages.slice();
        clearComposer();
        try {
          await pushCommand({ op: 'enqueue', text, images: images.map(toTaskImage), enabled: newTaskEnabled });
        } catch (error) {
          restoreComposer(text, images);
          throw error;
        }
      }),
  });
  disposables.push(addButton);
  // Append: queue the task to the session open in the panel instead of a new
  // one. The session id is recorded now, at click time, and the queue sends the
  // prompt to it once the project is idle.
  const appendButton = mountButton(composerActions, {
    label: t('composer.append'),
    variant: 'outline',
    size: 'sm',
    onClick: () =>
      withLoading(appendButton, async () => {
        const text = composerDraft.trim();
        if (!text) return;
        const session = currentSession;
        if (!session) {
          await host.toast({ kind: 'info', message: t('toast.noSession') });
          return;
        }
        if (uploading()) {
          await host.toast({ kind: 'info', message: t('composer.image.wait') });
          return;
        }
        const images = composerImages.slice();
        clearComposer();
        try {
          await pushCommand({
            op: 'enqueue',
            text,
            images: images.map(toTaskImage),
            enabled: newTaskEnabled,
            targetSessionId: session.id,
            targetSessionTitle: session.title,
          });
        } catch (error) {
          restoreComposer(text, images);
          throw error;
        }
      }),
  });
  disposables.push(appendButton);
  // Attaching is the last action, and the only one that does not send: it is
  // here so a task can carry a screenshot without leaving the composer.
  const imageButton = mountButton(composerActions, {
    label: t('composer.image.add'),
    variant: 'ghost',
    size: 'sm',
    onClick: () => filePicker.click(),
  });
  disposables.push(imageButton);

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
  const row = el('div', `qx-row qx-row-${task.status}${task.enabled ? '' : ' qx-row-disabled'}${queue.enabled ? '' : ' qx-row-editable'}`);
  row.appendChild(el('span', `qx-dot qx-dot-${task.status}`));
  row.appendChild(el('span', 'qx-pos', String(position)));

  const body = row.appendChild(el('div', 'qx-row-body'));
  // The whole content, not just its first line: the row clamps it to three
  // lines, so a task can be read without opening the editor.
  body.appendChild(el('div', 'qx-row-text', task.text.trim() || t('task.untitled')));
  const subtitle = [
    task.enabled ? statusLabel(task.status) : t('status.disabled'),
    task.target ? t('row.appendTo', { name: task.target.title ?? task.target.sessionId }) : '',
    task.images.length > 0 ? t('composer.image.count', { n: task.images.length }) : '',
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
  // The task's own switch, last in the bar: it is a setting rather than an
  // action, so switching it off leaves the task in place and only keeps the
  // scheduler from starting it. It works whether the queue is running or not.
  const enabledBox = mountCheckbox(actions, {
    label: t('row.enabled'),
    checked: task.enabled,
    onChange: (next) => runCommand({ op: 'set-task-enabled', taskId: task.id, enabled: next }),
  });
  disposables.push(enabledBox);

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
  editorStrip = card.appendChild(el('div', 'qx-images'));
  refreshEditorStrip();
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
      const images = editingImages.map(toTaskImage);
      endEdit();
      runCommand({ op: 'edit', taskId: id, text, images });
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

/**
 * The project the open directory belongs to.
 *
 * The host's pushed list answers this from memory, so a switch costs a lookup
 * instead of a request — and the id it gives is the same one on every switch, so
 * a directory never ends up with two queues. A directory the host has not named
 * (a worktree, a folder outside any project) is read once more, and the directory
 * itself stands in when even that has no match.
 */
const resolveTarget = async (dir: string | null): Promise<Target | null> => {
  if (!dir) return null;
  const known = cachedProject(dir);
  if (known) return { projectId: known.id, directory: known.directory, name: known.name };
  await readProjects();
  const found = cachedProject(dir);
  if (found) return { projectId: found.id, directory: found.directory, name: found.name };
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
// Boot and project switching
// ---------------------------------------------------------------------------

/**
 * Show `next` as the open project without waiting for anything: its name, and
 * the queue it had when the panel last saw it. Painting before the read is what
 * keeps a switch from looking as if it did not happen — otherwise the previous
 * project's tasks and name stay on screen for however long the read takes.
 */
const adoptDirectory = (next: string | null): void => {
  if (!next) {
    project = null;
    queue = emptyQueue();
    queueSeq = 0;
    loading = false;
    renderKey = '';
    render();
    return;
  }
  const known = cachedProject(next);
  // A directory the host has not named yet keeps its folder name until the
  // resolve answers; nothing can be clicked while it says it is loading.
  project = known
    ? { id: known.id, directory: known.directory, name: known.name }
    : { id: '', directory: next, name: folderName(next) };
  const cached = project.id ? knownQueues.get(project.id) ?? null : null;
  queue = cached ?? emptyQueue();
  queueSeq = 0;
  loading = cached === null;
  renderKey = '';
  render();
};

/**
 * Open the project at `dir` under the given switch token. A later switch moves
 * the token, and every answer that arrives afterwards is dropped rather than
 * painted: two overlapping switches used to leave whichever read finished last
 * on screen, which was sometimes the project the user had already left.
 */
const switchProject = async (dir: string | null, token: number): Promise<void> => {
  const previous = project;
  const target = await resolveTarget(dir);
  if (token !== projectToken) return;
  project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
  const cached = project ? knownQueues.get(project.id) ?? null : null;
  if (!project) {
    queue = emptyQueue();
    queueSeq = 0;
    loading = false;
  } else if (cached) {
    // Shown at once, then corrected by the read below.
    queue = cached;
    queueSeq = 0;
    loading = false;
  } else if (project.id !== previous?.id) {
    // The id changed under a queue painted for the old one: that queue is not
    // this project's, so go back to showing that its state is on the way.
    queue = emptyQueue();
    queueSeq = 0;
    loading = true;
  }
  // The name may have been the folder name a moment ago; paint it now even when
  // the id is unchanged.
  renderKey = '';
  publish();
  if (project) {
    // Registering and reading are independent: one round trip, not two.
    await Promise.allSettled([registerProject(project), refresh()]);
  }
  if (token !== projectToken) return;
  await syncDrivers();
};

const preparePanel = async (): Promise<void> => {
  const token = projectToken;
  let target: Target | null = null;
  try {
    if (directory) target = await resolveTarget(directory);
    if (token !== projectToken) return;
    project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
    await detectMode();
    // A failed registration is not worth stopping for: the read below still
    // shows what this project has, and the next upgrade to `backend` retries it.
    if (project) await registerProject(project).catch(() => undefined);
    await syncDrivers();
  } catch {
    // Nothing here can be reported better than the read below does.
  }
  if (token !== projectToken) return;
  // The read ends the loading state, whether it answers or fails.
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
  currentSession = ctx.session;
  // The open session changes as the user moves around the app; an append task
  // must target whatever is open when it is queued, so follow it.
  host.onSession((session) => {
    currentSession = session;
  });
  mountBusyBar();
  directory = ctx.directory;
  // The host pushes its project list, so a switch is answered from memory.
  void followProjects();
  // Paint the loading state before the first read answers.
  render();
  void preparePanel().catch(() => undefined);
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
  editingId = null;
  draftText = '';
  editingImages = [];
  // Everything still in flight belongs to the project being left.
  projectToken += 1;
  const token = projectToken;
  adoptDirectory(next);
  // The stream belongs to the service and carries every project, so switching
  // projects keeps the reader and the cursor: only the new project's state is
  // read.
  void switchProject(next, token).catch(() => undefined);
});
