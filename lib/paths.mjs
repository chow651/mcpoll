// Where runtime data lives.
//
// Repo checkout: everything sits next to the code (as before).
// Packaged desktop app: the bundle is read-only (app.asar), so the Electron main
// process sets MCPOLL_HOME to the per-user app data dir and seeds it from the
// bundle on first launch.

import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bundle / repo root — read-only once packaged. */
export const APP_ROOT = resolve(HERE, "..");

/** Writable data root. */
export const HOME = process.env.MCPOLL_HOME ? resolve(process.env.MCPOLL_HOME) : APP_ROOT;

export const dataPath = (...parts) => join(HOME, ...parts);

/** Create the parent dir of a file path. */
export function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/**
 * First run of a packaged app: copy a file out of the bundle into HOME so the
 * app has a starting registry / calibration instead of failing on a missing file.
 */
export function seed(file, bundleName = basename(file)) {
  const src = join(APP_ROOT, bundleName);
  if (!existsSync(file) && existsSync(src)) {
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(src, file);
  }
  return file;
}
