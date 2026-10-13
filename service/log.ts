/**
 * Rotating file logger for the queue service.
 *
 * The service runs as a child process of the OpenChamber host, so whatever it
 * prints is easy to lose. Every line therefore also lands in
 * `~/.config/openchamber-queue/logs/service.log`, which is the first thing to
 * open when a dispatch or a session did not behave as expected. The active file
 * rolls over once it reaches `maxBytes`, leaving a timestamped backup beside it,
 * and only the newest `keep` backups stay, so the directory cannot grow without
 * limit.
 *
 * Writes are serialized through one promise chain: a rotation never interleaves
 * with an append, and the tracked size always matches the file on disk. A
 * failure to write is swallowed after the first one — a broken log directory
 * must never take the queue down with it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export type Logger = {
  info: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
  error: (message: string, detail?: unknown) => void;
  /** Resolves once every queued line has been written (or dropped). */
  flush: () => Promise<void>;
  /** Absolute path of the active log file. */
  readonly file: string;
};

export type LoggerOptions = {
  /** Roll the active file over once it would grow past this many bytes. */
  maxBytes?: number;
  /** How many rolled-over files to keep; older ones are removed. */
  keep?: number;
  /** Also write each line to stdout/stderr. Defaults to true. */
  mirror?: boolean;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 5;
const ACTIVE_NAME = 'service.log';

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** Local-time stamp, matching what a user expects when opening the file. */
const stamp = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

const describe = (detail: unknown): string => {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` ${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  if (typeof detail === 'string') return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
};

const exists = (file: string): Promise<boolean> =>
  fsp.stat(file).then(() => true).catch(() => false);

export const createLogger = (dir: string, options: LoggerOptions = {}): Logger => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = Math.max(0, options.keep ?? DEFAULT_KEEP);
  const mirror = options.mirror ?? true;
  const active = path.join(dir, ACTIVE_NAME);
  const backupRe = /^service-(\d+)(?:-\d+)?\.log$/;

  let started: Promise<void> | null = null;
  let size = 0;
  let broken = false;
  let chain: Promise<void> = Promise.resolve();

  /** Create the directory and pick up the current file's size, once. */
  const start = (): Promise<void> => {
    if (!started) {
      started = (async () => {
        await fsp.mkdir(dir, { recursive: true });
        const info = await fsp.stat(active).catch(() => null);
        size = info?.size ?? 0;
      })().catch(() => { broken = true; });
    }
    return started;
  };

  /** Drop the oldest backups so only `keep` remain. */
  const prune = async (): Promise<void> => {
    if (keep <= 0) return;
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    const backups = names
      .map((name) => {
        const match = backupRe.exec(name);
        return match ? { name, at: Number(match[1]) } : null;
      })
      .filter((entry): entry is { name: string; at: number } => entry !== null)
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    await Promise.all(backups.slice(keep).map((entry) =>
      fsp.rm(path.join(dir, entry.name), { force: true }).catch(() => {})));
  };

  /** Move the active file aside and start a fresh one. */
  const rotate = async (): Promise<void> => {
    const at = Date.now();
    let target = path.join(dir, `service-${at}.log`);
    for (let n = 1; await exists(target); n += 1) target = path.join(dir, `service-${at}-${n}.log`);
    try {
      await fsp.rename(active, target);
    } catch {
      // Rename failed (for example the directory vanished): truncating still
      // keeps the file bounded, which is the point of rolling in the first place.
      await fsp.writeFile(active, '');
    }
    size = 0;
    await prune();
  };

  const write = (level: LogLevel, message: string, detail: unknown): void => {
    const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}${describe(detail)}\n`;
    if (mirror) {
      if (level === 'info') process.stdout.write(line);
      else process.stderr.write(line);
    }
    if (broken) return;
    const bytes = Buffer.byteLength(line);
    chain = chain.then(async () => {
      await start();
      if (broken) return;
      try {
        if (size > 0 && size + bytes > maxBytes) await rotate();
        await fsp.appendFile(active, line, 'utf8');
        size += bytes;
      } catch {
        broken = true;
      }
    });
  };

  return {
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
    flush: () => chain.catch(() => {}),
    file: active,
  };
};
