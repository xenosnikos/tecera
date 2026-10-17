import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@tecera/contracts';
import { LIST_IGNORES } from './listFiles.js';

/**
 * A content fingerprint of a worktree: every regular file under it (node_modules, .git and .tecera skipped,
 * symlinks recorded by their target, never followed) with the sha256 of its bytes, and one digest over
 * all of them. What a runVerify pass is bound to (runVerify.ts, the broker's verify state): the check ran
 * on exactly this tree, and the pass holds only while the tree still is this one.
 */

export interface TreeDigest {
  /** One digest over every (path, digest) pair, in path order. */
  digest: string;
  /** Worktree-relative path → the file's content digest (`link:` + target for a symlink, `unreadable` for a file that could not be read). */
  files: Map<string, string>;
}

export async function digestTree(root: string): Promise<TreeDigest> {
  const files = new Map<string, string>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        files.set(r, `link:${await readlink(join(abs, e.name)).catch(() => '?')}`);
      } else if (e.isDirectory()) {
        if (!LIST_IGNORES.has(e.name)) await walk(join(abs, e.name), r);
      } else if (e.isFile()) {
        try {
          files.set(r, sha256((await readFile(join(abs, e.name))).toString('latin1')));
        } catch {
          files.set(r, 'unreadable');
        }
      }
    }
  };
  await walk(root, '');
  return { digest: sha256([...files].map(([p, d]) => `${p}\0${d}`).join('\n')), files };
}

/** The paths whose digest differs between two fingerprints (added, removed or changed), at most `max`, sorted. */
export function treeDifference(a: TreeDigest, b: TreeDigest, max = 5): string[] {
  const out: string[] = [];
  for (const p of new Set([...a.files.keys(), ...b.files.keys()])) if (a.files.get(p) !== b.files.get(p)) out.push(p);
  return out.sort().slice(0, max);
}
