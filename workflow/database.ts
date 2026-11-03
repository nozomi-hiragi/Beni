import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Resolve all SQLite connections to one filename, including symlink aliases. */
export function databasePath(path: string): string {
  // The workflow opens several SQLite connections and cannot share a private
  // in-memory database. URI filenames have different SQLite semantics.
  if (!path || path === ':memory:' || path.startsWith('file:')) throw new Error('An on-disk SQLite filename is required');
  const absolute = resolve(path);
  let exists = false;
  try { lstatSync(absolute); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) {
    const physical = realpathSync(absolute);
    const info = statSync(physical);
    // SQLite journal/WAL filenames depend on the filename used to open it;
    // hardlinks must not create multiple names for the same active database.
    if (!info.isFile() || info.nlink !== 1) throw new Error('A regular, non-hardlinked SQLite file is required');
    return physical;
  }
  return join(realpathSync(dirname(absolute)), basename(absolute));
}
