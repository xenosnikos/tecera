import { describe, expect, it, vi } from 'vitest';
import { RPC_LIMITS } from '@tecera/contracts';
import { FrameError, FrameReader, checkChildFrame, decodeFrame, scanDepth } from './frames.js';

describe('frames', () => {
  it('scanDepth ignores brackets inside strings', () => {
    expect(scanDepth('{"a":[1,{"b":"[[[{{{"}]}')).toBe(3);
    expect(scanDepth('"\\"[["')).toBe(0);
    expect(scanDepth('[]')).toBe(1);
  });

  it('rpc.oversized_frame: a 2 MiB frame is rejected before the parser is called', () => {
    const parse = vi.fn(JSON.parse);
    const big = Buffer.from(JSON.stringify({ t: 'call', callId: 'c1', handle: 'h1.r.1.0123456789abcdef', method: 'read', args: ['x'.repeat(2 * 1024 * 1024)] }));
    expect(() => decodeFrame(big, parse)).toThrow(FrameError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('rejects frames nested deeper than the limit before parsing', () => {
    const parse = vi.fn(JSON.parse);
    let deep: unknown = 1;
    for (let i = 0; i < RPC_LIMITS.maxDepth + 2; i++) deep = [deep];
    const line = Buffer.from(JSON.stringify({ t: 'checkpoint', key: 'k', value: deep }));
    expect(() => decodeFrame(line, parse)).toThrow(/nesting/);
    expect(parse).not.toHaveBeenCalled();
  });

  it('FrameReader stops buffering at the cap, before a newline ever arrives', () => {
    const lines: Buffer[] = [];
    const errors: FrameError[] = [];
    const r = new FrameReader((l) => lines.push(l), (e) => errors.push(e));
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    for (let i = 0; i < 8; i++) r.push(chunk);
    expect(lines).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/before parse/);
  });

  it('FrameReader splits lines across chunks', () => {
    const lines: string[] = [];
    const r = new FrameReader((l) => lines.push(l.toString()), () => undefined);
    r.push(Buffer.from('{"t":"hel'));
    r.push(Buffer.from('lo"}\n{"t":"x"}\n{"a'));
    r.push(Buffer.from('":1}\n'));
    expect(lines).toEqual(['{"t":"hello"}', '{"t":"x"}', '{"a":1}']);
  });

  it('checkChildFrame accepts the closed set and rejects unknown types and fields', () => {
    expect(checkChildFrame({ t: 'hello', protocolVersion: 1 }).t).toBe('hello');
    expect(() => checkChildFrame({ t: 'hello', protocolVersion: 2 })).toThrow(FrameError);
    expect(() => checkChildFrame({ t: 'exec', code: 'x' })).toThrow(FrameError);
    expect(() => checkChildFrame({ t: 'log', level: 'log', text: 'x', extra: 1 })).toThrow(FrameError);
    expect(() => checkChildFrame({ t: 'call', callId: 'c1', handle: 'h', method: 'constructor.constructor', args: [] })).toThrow(FrameError);
    expect(checkChildFrame({ t: 'result', execNo: 1, result: { kind: 'return', value: { a: 1 }, output: '' }, printed: '' }).t).toBe('result');
    expect(() => checkChildFrame({ t: 'result', execNo: 1, result: { kind: 'done', value: 1 }, printed: '' })).toThrow(FrameError);
    expect(() => checkChildFrame({ t: 'invoke', callId: 'c1', inputs: {}, narrow: { tools: ['a'], caps: 1 } })).toThrow(FrameError);
  });
});
