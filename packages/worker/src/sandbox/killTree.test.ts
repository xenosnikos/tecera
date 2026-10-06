import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupAlive, killTree } from './killTree.js';

describe('killTree', () => {
  it('kills the whole group including a backgrounded grandchild and confirms it is gone', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    await new Promise((r) => setTimeout(r, 150));
    expect(groupAlive(pgid)).toBe(true);
    const res = await killTree(pgid, { child });
    expect(res).toEqual({ gone: true, signalled: true });
    expect(groupAlive(pgid)).toBe(false);
  });

  it('is a no-op on a group that already exited and refuses bad pgids', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    expect((await killTree(child.pid!, { child })).gone).toBe(true);
    await expect(killTree(1)).rejects.toThrow();
    await expect(killTree(0)).rejects.toThrow();
  });
});
