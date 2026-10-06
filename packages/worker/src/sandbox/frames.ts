import { RPC_LIMITS, RPC_PROTOCOL_VERSION, type ChildToSupervisor, type Json } from '@tecera/contracts';

/**
 * Wire framing for child → supervisor traffic: newline-delimited JSON on the child's stdout. The
 * supervisor never hands bytes to a JSON parser before the frame has passed the byte cap (enforced
 * while buffering, so an endless line cannot grow the buffer past the cap) and a raw nesting-depth
 * scan. Only then is the line parsed and its shape checked against the closed set of frame types.
 */

export type FrameErrorCode = 'E_FRAME' | 'E_LIMIT' | 'E_HANDLE';

export class FrameError extends Error {
  constructor(public readonly code: FrameErrorCode, message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Maximum `[`/`{` nesting of a raw JSON text, ignoring brackets inside strings. Linear, never parses. */
export function scanDepth(raw: string): number {
  let depth = 0;
  let max = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 125 || c === 93) depth--;
  }
  return max;
}

/** Validate a raw line (bytes) and parse it. Throws FrameError; the parser is reached only for in-bounds input. */
export function decodeFrame(line: Buffer, parse: (s: string) => unknown = JSON.parse): ChildToSupervisor {
  if (line.length > RPC_LIMITS.maxFrameBytes) throw new FrameError('E_FRAME', `frame of ${line.length} bytes exceeds ${RPC_LIMITS.maxFrameBytes}`);
  const raw = line.toString('utf8');
  const depth = scanDepth(raw);
  if (depth > RPC_LIMITS.maxDepth) throw new FrameError('E_FRAME', `frame nesting ${depth} exceeds ${RPC_LIMITS.maxDepth}`);
  let value: unknown;
  try {
    value = parse(raw);
  } catch {
    throw new FrameError('E_FRAME', 'frame is not valid JSON');
  }
  return checkChildFrame(value);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isJsonObject = (v: unknown): v is Record<string, Json> => isObj(v);
const CALL_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function exactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  for (const k of required) if (!(k in o)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

function bad(what: string): never {
  throw new FrameError('E_FRAME', `malformed ${what} frame`);
}

/** Shape check for a parsed child frame. Unknown frame types and unknown fields are rejected. */
export function checkChildFrame(v: unknown): ChildToSupervisor {
  if (!isObj(v) || typeof v.t !== 'string') bad('child');
  switch (v.t) {
    case 'hello':
      if (!exactKeys(v, ['t', 'protocolVersion']) || v.protocolVersion !== RPC_PROTOCOL_VERSION) bad('hello');
      return v as unknown as ChildToSupervisor;
    case 'call':
      if (!exactKeys(v, ['t', 'callId', 'handle', 'method', 'args'])) bad('call');
      if (typeof v.callId !== 'string' || !CALL_ID_RE.test(v.callId)) bad('call');
      if (!isStr(v.handle, 200) || typeof v.method !== 'string' || !METHOD_RE.test(v.method) || !Array.isArray(v.args)) bad('call');
      return v as unknown as ChildToSupervisor;
    case 'invoke': {
      if (!exactKeys(v, ['t', 'callId', 'inputs'], ['output', 'narrow'])) bad('invoke');
      if (typeof v.callId !== 'string' || !CALL_ID_RE.test(v.callId) || !isJsonObject(v.inputs)) bad('invoke');
      if (v.narrow !== undefined) {
        const n = v.narrow;
        if (!isObj(n) || !exactKeys(n, [], ['tools', 'limits', 'depth'])) bad('invoke');
        if (n.tools !== undefined && (!Array.isArray(n.tools) || !n.tools.every((t) => isStr(t, 128)))) bad('invoke');
        if (n.limits !== undefined && (!isObj(n.limits) || !Object.values(n.limits).every((x) => typeof x === 'number' && Number.isFinite(x)))) bad('invoke');
        if (n.depth !== undefined && (typeof n.depth !== 'number' || !Number.isInteger(n.depth) || n.depth < 0)) bad('invoke');
      }
      return v as unknown as ChildToSupervisor;
    }
    case 'checkpoint':
      if (!exactKeys(v, ['t', 'key', 'value']) || typeof v.key !== 'string' || !KEY_RE.test(v.key)) bad('checkpoint');
      return v as unknown as ChildToSupervisor;
    case 'log':
      if (!exactKeys(v, ['t', 'level', 'text']) || !['log', 'warn', 'error'].includes(v.level as string) || typeof v.text !== 'string') bad('log');
      return v as unknown as ChildToSupervisor;
    case 'result': {
      if (!exactKeys(v, ['t', 'execNo', 'result', 'printed']) || typeof v.execNo !== 'number' || typeof v.printed !== 'string' || !isObj(v.result)) bad('result');
      const r = v.result;
      if (r.kind === 'return') {
        if (!exactKeys(r, ['kind', 'value', 'output']) || typeof r.output !== 'string') bad('result');
      } else if (r.kind === 'continue') {
        if (!exactKeys(r, ['kind', 'output'], ['exception']) || typeof r.output !== 'string') bad('result');
        if (r.exception !== undefined && !isSerializedError(r.exception)) bad('result');
      } else if (r.kind === 'raise') {
        if (!exactKeys(r, ['kind', 'exception']) || !isSerializedError(r.exception)) bad('result');
      } else bad('result');
      return v as unknown as ChildToSupervisor;
    }
    case 'crash':
      if (!exactKeys(v, ['t', 'error']) || !isSerializedError(v.error)) bad('crash');
      return v as unknown as ChildToSupervisor;
    default:
      bad('unknown');
  }
}

function isSerializedError(v: unknown): boolean {
  return isObj(v) && exactKeys(v, ['name', 'message'], ['stack']) && typeof v.name === 'string' && typeof v.message === 'string' && (v.stack === undefined || typeof v.stack === 'string');
}

/**
 * Splits a byte stream into newline-terminated frames. Buffered bytes never exceed `maxBytes`: a line
 * that would cross it is reported as an error before any of it is decoded, and the reader stops.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private dead = false;

  constructor(
    private readonly onLine: (line: Buffer) => void,
    private readonly onError: (e: FrameError) => void,
    private readonly maxBytes: number = RPC_LIMITS.maxFrameBytes,
  ) {}

  push(chunk: Buffer): void {
    if (this.dead) return;
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (this.buffered + piece.length > this.maxBytes) {
        this.dead = true;
        this.chunks = [];
        this.onError(new FrameError('E_FRAME', `frame exceeds ${this.maxBytes} bytes (rejected before parse)`));
        return;
      }
      if (piece.length) {
        this.chunks.push(Buffer.from(piece));
        this.buffered += piece.length;
      }
      if (nl === -1) return;
      const line = Buffer.concat(this.chunks, this.buffered);
      this.chunks = [];
      this.buffered = 0;
      start = nl + 1;
      if (line.length) this.onLine(line);
      if (this.dead) return;
    }
  }

  stop(): void {
    this.dead = true;
    this.chunks = [];
  }
}
