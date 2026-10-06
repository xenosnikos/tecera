import { HANDLE_RE, RPC_LIMITS, RPC_PROTOCOL_VERSION } from '@tecera/contracts';

/**
 * The sandbox child program, shipped as a string and written to `<scratch>/child/entry.mjs` at spawn
 * time so `--allow-fs-read` covers exactly it. It imports only node:vm and speaks NDJSON frames on
 * stdin/stdout. User code runs in a fresh vm context with code generation disabled; every object it
 * can reach (stubs, values, invoke, checkpoint, console) is created by a bootstrap that runs inside
 * that context, so no host-realm prototype or function is ever handed to it. The child is untrusted:
 * it enforces RPC_LIMITS as a courtesy, the supervisor enforces them again.
 *
 * Dialect (contracts rpc.ts): a handle binding exposes its methods as an object; a handle whose methods
 * are exactly ['call'] is ALSO a callable function (`readFile(path)` and `readFile.call(path)` both work).
 * `{"$handle": h}` inside a value revives as a view stub (len/slice/search). `invoke(inputs, {output,
 * narrow: {tools, limits, depth}})`: any other option key is refused, never dropped. An RPC_LIMITS
 * violation (oversized or too-deep frame, too many calls or checkpoints) is FATAL: the child sends a
 * `crash` frame naming the code and exits, whatever the program does with the thrown error. A program
 * that finishes with calls still in flight raises E_OUTSTANDING.
 */

/** Additional limits the child applies on its own side. */
export const CHILD_LIMITS = {
  maxCheckpoints: 64,
  /** Chars per log frame; longer console output is split across frames. */
  logChunkChars: 100_000,
  maxBindingNameLength: 64,
  /**
   * Chars of an exception message/stack the child sends. The host keeps 8000 after redaction; the extra
   * 8192 are redaction lookahead so a secret straddling the host's cut is still seen whole.
   */
  errorChars: 16_192,
  /** Chars of a crash message the child sends (host keeps 2000 after redaction; the rest is lookahead). */
  crashChars: 10_192,
} as const;

const BOOT = String.raw`(function (sendRaw, done, fatalRaw, limitsJson, handleReSource) {
  'use strict';
  const LIMITS = JSON.parse(limitsJson);
  const HANDLE_RE = new RegExp(handleReSource);
  const P = Promise;
  const then = Promise.prototype.then;
  const apply = Reflect.apply;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const isFrozen = Object.isFrozen;
  const defineProperty = Object.defineProperty;
  const keys = Object.keys;
  const isArray = Array.isArray;
  const create = Object.create;
  const Str = String;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const RangeErrorCtor = RangeError;
  const strSlice = String.prototype.slice;
  const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
  const VIEW = ['len', 'slice', 'search'];

  const waiters = create(null);
  let seq = 0;
  let calls = 0;
  let checkpoints = 0;
  let finished = false;
  let fatalLatched = false;

  function rpcError(code, message) {
    const e = new ErrorCtor(message);
    e.name = 'RpcError';
    defineProperty(e, 'code', { value: code, enumerable: true });
    return e;
  }

  function deepFreeze(v) {
    if (v !== null && typeof v === 'object' && !isFrozen(v)) {
      const ks = keys(v);
      for (let i = 0; i < ks.length; i++) deepFreeze(v[ks[i]]);
      freeze(v);
    }
    return v;
  }

  function isRef(v) {
    if (v === null || typeof v !== 'object' || isArray(v)) return false;
    const ks = keys(v);
    return ks.length === 1 && ks[0] === '$handle' && typeof v.$handle === 'string' && HANDLE_RE.test(v.$handle);
  }

  function revive(v) {
    if (v === null || typeof v !== 'object') return v;
    if (isRef(v)) return makeStub(v.$handle, VIEW, 'large value served by the supervisor: len(), slice(start, end), search(text)');
    if (isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = revive(v[i]);
      return v;
    }
    const ks = keys(v);
    for (let i = 0; i < ks.length; i++) defineProperty(v, ks[i], { value: revive(v[ks[i]]), writable: true, enumerable: true, configurable: true });
    return v;
  }

  // Latch a limit violation: notify the supervisor first (crash frame + exit), then throw. Catching the
  // error in the program changes nothing; the exec is already over.
  function fatal(code, message) {
    if (!fatalLatched) {
      fatalLatched = true;
      finished = true;
      fatalRaw(code, message);
    }
    return rpcError(code, message);
  }

  function send(text) {
    if (fatalLatched) throw rpcError('E_INTERNAL', 'exec terminated');
    const st = sendRaw(text);
    if (st === 1) throw fatal('E_FRAME', 'frame exceeds ' + LIMITS.maxFrameBytes + ' bytes');
    if (st === 2) throw fatal('E_FRAME', 'frame nesting exceeds ' + LIMITS.maxDepth);
    if (st !== 0) throw fatal('E_FRAME', 'frame rejected');
  }

  function request(buildFrame) {
    return new P(function (resolve, reject) {
      if (finished) return reject(rpcError('E_INTERNAL', 'exec already finished'));
      if (++calls > LIMITS.maxCallsPerExec) return reject(fatal('E_LIMIT', 'more than ' + LIMITS.maxCallsPerExec + ' calls in one exec'));
      const callId = 'c' + (++seq);
      let text;
      try {
        text = buildFrame(callId);
      } catch (e) {
        return reject(e instanceof ErrorCtor ? e : new TypeErrorCtor('arguments must be JSON-serializable'));
      }
      try {
        send(text);
      } catch (e) {
        return reject(e);
      }
      waiters[callId] = { resolve: resolve, reject: reject };
    });
  }

  function argsJson(args) {
    let s;
    try {
      s = stringify(args);
    } catch (e) {
      throw new TypeErrorCtor('arguments must be JSON-serializable');
    }
    if (typeof s !== 'string') throw new TypeErrorCtor('arguments must be JSON-serializable');
    return s;
  }

  function methodFn(handle, m) {
    return function () {
      const args = [];
      for (let j = 0; j < arguments.length; j++) args.push(arguments[j]);
      return request(function (callId) {
        return '{"t":"call","callId":' + stringify(callId) + ',"handle":' + stringify(handle) + ',"method":' + stringify(m) + ',"args":' + argsJson(args) + '}';
      });
    };
  }

  function makeStub(handle, methods, description) {
    // A handle whose methods are exactly ['call'] is a callable stub: f(x) and f.call(x) are the same call.
    const callable = methods.length === 1 && methods[0] === 'call';
    const stub = callable ? methodFn(handle, 'call') : {};
    for (let i = 0; i < methods.length; i++) {
      const m = methods[i];
      if (typeof m !== 'string' || !METHOD_RE.test(m) || m === 'toJSON' || m === 'constructor' || m === 'prototype') continue;
      defineProperty(stub, m, { value: methodFn(handle, m), enumerable: true });
    }
    defineProperty(stub, 'toJSON', { value: function () { return { $handle: handle }; } });
    if (typeof description === 'string') defineProperty(stub, 'description', { value: description, enumerable: true });
    return freeze(stub);
  }

  const INVOKE_KEYS = ['output', 'narrow'];
  const NARROW_KEYS = ['tools', 'limits', 'depth'];
  function checkKeys(o, allowed, what) {
    if (o === null || typeof o !== 'object' || isArray(o)) throw rpcError('E_DENIED', what + ' must be an object');
    const ks = keys(o);
    for (let i = 0; i < ks.length; i++) {
      let ok = false;
      for (let j = 0; j < allowed.length; j++) if (allowed[j] === ks[i]) ok = true;
      if (!ok) throw rpcError('E_DENIED', 'unsupported ' + what + ' key ' + stringify(ks[i]) + '; invoke options are {output, narrow: {tools, limits, depth}}');
    }
  }

  function invoke(inputs, opts) {
    const o = opts === undefined || opts === null ? {} : opts;
    try {
      checkKeys(o, INVOKE_KEYS, 'invoke option');
      if (o.narrow !== undefined) checkKeys(o.narrow, NARROW_KEYS, 'invoke narrow');
    } catch (e) {
      return P.reject(e);
    }
    return request(function (callId) {
      const narrow = {};
      const n = o.narrow === undefined ? {} : o.narrow;
      if (n.tools !== undefined) narrow.tools = n.tools;
      if (n.limits !== undefined) narrow.limits = n.limits;
      if (n.depth !== undefined) narrow.depth = n.depth;
      const frame = { t: 'invoke', callId: callId, inputs: inputs === undefined ? {} : inputs, narrow: narrow };
      if (o.output !== undefined) frame.output = o.output;
      const s = stringify(frame);
      if (typeof s !== 'string') throw new TypeErrorCtor('invoke inputs must be JSON-serializable');
      return s;
    });
  }

  function checkpoint(key, value) {
    if (finished) throw rpcError('E_INTERNAL', 'exec already finished');
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TypeErrorCtor('checkpoint key must match ' + KEY_RE.source);
    if (++checkpoints > LIMITS.maxCheckpoints) throw fatal('E_LIMIT', 'more than ' + LIMITS.maxCheckpoints + ' checkpoints in one exec');
    let vj;
    try {
      vj = stringify(value === undefined ? null : value);
    } catch (e) {
      throw new TypeErrorCtor('checkpoint value must be JSON-serializable');
    }
    send('{"t":"checkpoint","key":' + stringify(key) + ',"value":' + vj + '}');
  }

  function fmt(a) {
    if (typeof a === 'string') return a;
    try {
      const s = stringify(a);
      if (typeof s === 'string') return s;
    } catch (e) {}
    try {
      return Str(a);
    } catch (e) {
      return '[unprintable]';
    }
  }

  function emit(level) {
    return function () {
      let text = '';
      for (let i = 0; i < arguments.length; i++) text += (i ? ' ' : '') + fmt(arguments[i]);
      text += '\n';
      for (let i = 0; i < text.length; i += LIMITS.logChunkChars) {
        send(stringify({ t: 'log', level: level, text: apply(strSlice, text, [i, i + LIMITS.logChunkChars]) }));
      }
    };
  }
  const consoleObj = freeze({ log: emit('log'), info: emit('log'), debug: emit('log'), warn: emit('warn'), error: emit('error') });
  try {
    delete globalThis.console;
  } catch (e) {}
  defineProperty(globalThis, 'console', { value: consoleObj, writable: false, configurable: false, enumerable: false });

  function serializeError(e) {
    try {
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        const out = { name: Str(e.name === undefined ? 'Error' : e.name), message: Str(e.message === undefined ? '' : e.message) };
        if (typeof e.code === 'string' && out.name === 'RpcError') out.name = e.code;
        if (typeof e.stack === 'string') out.stack = apply(strSlice, e.stack, [0, LIMITS.errorChars]);
        out.message = apply(strSlice, out.message, [0, LIMITS.errorChars]);
        return out;
      }
      return { name: 'Error', message: apply(strSlice, Str(e), [0, LIMITS.errorChars]) };
    } catch (x) {
      return { name: 'Error', message: 'unserializable exception' };
    }
  }

  function finish(execNo, result) {
    if (finished) return;
    finished = true;
    const outstanding = keys(waiters).length;
    if (outstanding > 0) {
      result = { kind: 'raise', exception: { name: 'E_OUTSTANDING', message: 'calls outstanding: ' + outstanding + ' tool call(s) or sub-invoke(s) were not awaited before the program finished; await every call' } };
    }
    let text = stringify({ t: 'result', execNo: execNo, result: result, printed: '' });
    if (sendRaw(text) !== 0) {
      sendRaw(stringify({ t: 'result', execNo: execNo, result: { kind: 'raise', exception: { name: 'E_LIMIT', message: 'result exceeds the frame limit (' + LIMITS.maxFrameBytes + ' bytes, depth ' + LIMITS.maxDepth + ')' } }, printed: '' }));
    }
    done();
  }

  function deliver(line) {
    let f;
    try {
      f = parse(line);
    } catch (e) {
      return;
    }
    const w = waiters[f.callId];
    if (!w) return;
    delete waiters[f.callId];
    if (f.t === 'reply') {
      let v;
      try {
        v = f.handle !== undefined ? makeStub(f.handle, VIEW, 'large value served by the supervisor: len(), slice(start, end), search(text)') : revive(f.value === undefined ? null : f.value);
      } catch (e) {
        return w.reject(rpcError('E_FRAME', 'bad reply'));
      }
      w.resolve(v);
    } else {
      w.reject(rpcError(typeof f.code === 'string' ? f.code : 'E_INTERNAL', typeof f.message === 'string' ? f.message : 'rpc error'));
    }
  }

  function run(fn, bindingsJson, execNo) {
    const bindings = parse(bindingsJson);
    const args = [];
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      if (b.kind === 'handle') args.push(makeStub(b.handle, isArray(b.methods) ? b.methods : [], b.description));
      else args.push(deepFreeze(revive(b.value === undefined ? null : b.value)));
    }
    const sentinel = freeze({});
    args.push(invoke, checkpoint, consoleObj, sentinel);
    let p;
    try {
      p = apply(fn, undefined, args);
    } catch (e) {
      return finish(execNo, { kind: 'raise', exception: serializeError(e) });
    }
    apply(then, p, [
      function (v) {
        if (v === sentinel) return finish(execNo, { kind: 'continue', output: '' });
        let value;
        try {
          const vj = stringify(v === undefined ? null : v);
          value = vj === undefined ? null : parse(vj);
        } catch (e) {
          return finish(execNo, { kind: 'raise', exception: { name: 'TypeError', message: 'return value is not JSON-serializable' } });
        }
        finish(execNo, { kind: 'return', value: value, output: '' });
      },
      function (e) {
        finish(execNo, { kind: 'raise', exception: serializeError(e) });
      },
    ]);
  }

  function raiseNow(execNo, name, message) {
    finish(execNo, { kind: 'raise', exception: { name: Str(name), message: Str(message) } });
  }

  return freeze({ run: run, deliver: deliver, raiseNow: raiseNow });
})`;

const MAIN = String.raw`
const BOOT_PARAMS = ['invoke', 'checkpoint', 'console'];
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const stdout = process.stdout;
const stdin = process.stdin;
let program = false;
let api = null;
let exiting = false;

function scanDepth(s) {
  let d = 0, max = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) { d++; if (d > max) max = d; }
    else if (c === 125 || c === 93) d--;
  }
  return max;
}

function sendRaw(s) {
  if (exiting) return 3;
  if (typeof s !== 'string') return 3;
  if (Buffer.byteLength(s, 'utf8') > LIMITS.maxFrameBytes) return 1;
  if (scanDepth(s) > LIMITS.maxDepth) return 2;
  stdout.write(s + '\n');
  return 0;
}

function exit(code) {
  if (exiting) return;
  exiting = true;
  stdout.write('', function () { process.exit(code); });
  setTimeout(function () { process.exit(code); }, 1000).unref();
}

function crash(name, message) {
  sendRaw(JSON.stringify({ t: 'crash', error: { name: String(name), message: String(message).slice(0, CHILD.crashChars) } }));
  exit(70);
}

process.on('uncaughtException', function (e) {
  let msg = 'uncaught exception';
  try { msg = String(e && e.message); } catch (x) {}
  crash('E_CRASH', msg);
});
process.on('unhandledRejection', function () {});

function startProgram(f) {
  if (typeof f.execNo !== 'number' || typeof f.code !== 'string' || !Array.isArray(f.bindings)) return crash('E_FRAME', 'malformed program frame');
  const names = [];
  for (const b of f.bindings) {
    if (!b || typeof b.name !== 'string' || !IDENT_RE.test(b.name) || b.name.length > CHILD.maxBindingNameLength || BOOT_PARAMS.includes(b.name) || names.includes(b.name)) return crash('E_FRAME', 'bad binding name');
    if (b.kind !== 'value' && b.kind !== 'handle') return crash('E_FRAME', 'bad binding kind');
    if (b.kind === 'handle' && (typeof b.handle !== 'string' || !HANDLE_RE.test(b.handle))) return crash('E_FRAME', 'bad binding handle');
    names.push(b.name);
  }
  const ctx = vm.createContext(Object.create(null), { name: 'tecera-sandbox', codeGeneration: { strings: false, wasm: false } });
  const boot = vm.runInContext(BOOT, ctx, { filename: 'tecera-boot.js' });
  api = boot(sendRaw, function () { exit(0); }, function (code, message) { crash(code, message); }, JSON.stringify(Object.assign({}, LIMITS, CHILD)), HANDLE_RE.source);
  const sentinelName = '__tecera_end_' + Math.random().toString(36).slice(2, 12);
  const body = 'return (async () => {\n' + f.code + '\n;return ' + sentinelName + ';\n})();';
  let fn;
  try {
    fn = vm.compileFunction(body, names.concat(BOOT_PARAMS, [sentinelName]), { parsingContext: ctx, filename: 'program-' + f.execNo + '.js' });
  } catch (e) {
    let name = 'SyntaxError', message = 'compile failed';
    try { name = String(e.name); message = String(e.message); } catch (x) {}
    return api.raiseNow(f.execNo, name, message);
  }
  api.run(fn, JSON.stringify(f.bindings), f.execNo);
}

function onLine(line) {
  if (Buffer.byteLength(line, 'utf8') > LIMITS.maxFrameBytes || scanDepth(line) > LIMITS.maxDepth) return crash('E_FRAME', 'inbound frame over limits');
  let f;
  try { f = JSON.parse(line); } catch (e) { return crash('E_FRAME', 'inbound frame is not JSON'); }
  if (!f || typeof f !== 'object') return crash('E_FRAME', 'inbound frame is not an object');
  if (f.t === 'program') {
    if (program) return crash('E_FRAME', 'second program frame');
    program = true;
    return startProgram(f);
  }
  if (f.t === 'reply' || f.t === 'error') {
    if (api) api.deliver(line);
    return;
  }
  if (f.t === 'cancel') return exit(75);
  return crash('E_FRAME', 'unknown inbound frame');
}

let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', function (chunk) {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.length) onLine(line);
  }
  if (buf.length > LIMITS.maxFrameBytes) crash('E_FRAME', 'inbound frame over limits');
});
stdin.on('end', function () { exit(0); });

sendRaw(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION }));
`;

/** The complete child program (ESM). */
export const CHILD_SOURCE: string = [
  "import vm from 'node:vm';",
  `const LIMITS = ${JSON.stringify(RPC_LIMITS)};`,
  `const CHILD = ${JSON.stringify(CHILD_LIMITS)};`,
  `const PROTOCOL_VERSION = ${RPC_PROTOCOL_VERSION};`,
  `const HANDLE_RE = new RegExp(${JSON.stringify(HANDLE_RE.source)});`,
  `const BOOT = ${JSON.stringify(BOOT)};`,
  MAIN,
].join('\n');
