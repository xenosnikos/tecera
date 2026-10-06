import type { FixtureSpec } from '../fixtureFetch.js';

/**
 * OpenRouter chat/completions responses served by FixtureFetch (`'openrouter/<case>'`). `ok`, `schema`,
 * `length` and `400-model` are taken from live responses (2026-10-05; `length` trimmed of its reasoning
 * signature, user ids replaced); the rest are hand-written variants of that shape. `{{AUTH}}` is replaced by the
 * request's auth header value (a provider echoing the credential).
 */

const usage = (prompt: number, completion: number, cost?: number) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  ...(cost !== undefined ? { cost } : {}),
  is_byok: false,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
});

const completion = (over: { model?: string; content?: string | null; finish?: string | null; message?: Record<string, unknown>; usage?: unknown; choices?: unknown[] } = {}) => ({
  id: 'gen-fixture',
  object: 'chat.completion',
  created: 1791195101,
  model: over.model ?? 'anthropic/claude-sonnet-4.5',
  provider: 'Anthropic',
  system_fingerprint: null,
  choices: over.choices ?? [
    {
      index: 0,
      logprobs: null,
      finish_reason: over.finish === undefined ? 'stop' : over.finish,
      native_finish_reason: 'end_turn',
      message: { role: 'assistant', content: over.content === undefined ? 'Hello from OpenRouter.' : over.content, refusal: null, reasoning: null, ...(over.message ?? {}) },
    },
  ],
  usage: over.usage ?? usage(1000, 500),
});

export const OPENROUTER_FIXTURES: Readonly<Record<string, FixtureSpec>> = {
  ok: {
    status: 200,
    body: {
      id: 'gen-1791195101-GzgsLQkHvvJG5s1mjWPe',
      object: 'chat.completion',
      created: 1791195101,
      model: 'anthropic/claude-haiku-4.5',
      provider: 'Amazon Bedrock',
      system_fingerprint: null,
      service_tier: 'default',
      choices: [{ index: 0, logprobs: null, finish_reason: 'stop', native_finish_reason: 'end_turn', message: { role: 'assistant', content: 'ok', refusal: null, reasoning: null } }],
      usage: {
        prompt_tokens: 18,
        completion_tokens: 4,
        total_tokens: 22,
        cost: 0.000038,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
        cost_details: { upstream_inference_cost: 0.000038, upstream_inference_prompt_cost: 0.000018, upstream_inference_completions_cost: 0.00002 },
        completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
      },
    },
  },
  schema: {
    status: 200,
    body: {
      id: 'gen-1791195103-MUBeNj88MuOeo8s5F8wP',
      object: 'chat.completion',
      created: 1791195103,
      model: 'anthropic/claude-sonnet-4.5',
      provider: 'Amazon Bedrock',
      system_fingerprint: null,
      service_tier: null,
      choices: [{ index: 0, logprobs: null, finish_reason: 'stop', native_finish_reason: 'end_turn', message: { role: 'assistant', content: '{"ok": true}', refusal: null, reasoning: null } }],
      usage: {
        prompt_tokens: 158,
        completion_tokens: 8,
        total_tokens: 166,
        cost: 0.000594,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
        cost_details: { upstream_inference_cost: 0.000594, upstream_inference_prompt_cost: 0.000474, upstream_inference_completions_cost: 0.00012 },
        completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
      },
    },
  },
  length: {
    status: 200,
    body: {
      id: 'gen-1791195116-YTQnIe0tLmBjdwnsKa26',
      object: 'chat.completion',
      created: 1791195116,
      model: 'google/gemini-3.1-pro-preview',
      provider: 'Google',
      system_fingerprint: null,
      service_tier: 'default',
      choices: [{ index: 0, logprobs: null, finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', message: { role: 'assistant', content: null, refusal: null, reasoning: null } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 61,
        total_tokens: 71,
        cost: 0.000752,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 61, image_tokens: 0, audio_tokens: 0 },
      },
    },
  },
  '400-model': { status: 400, body: { error: { message: 'nonexistent/model-x is not a valid model ID', code: 400 }, user_id: 'user_fixture' } },
  '429': { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'Rate limit exceeded', code: 429 } } },
  '500': { status: 500, body: { error: { message: 'Internal Server Error', code: 500 } } },
  malformed: { status: 200, bodyText: '{"id": "gen-x", "object": "chat.completion", "choices": [' },
  'wrong-shape': { status: 200, body: { id: 'gen-x', object: 'chat.completion', model: 'anthropic/claude-sonnet-4.5', usage: usage(10, 5) } },
  'echo-auth': { status: 401, body: { error: { message: 'Invalid credentials: {{AUTH}}', code: 401 } } },
  refusal: { status: 200, body: completion({ content: null, message: { refusal: 'I cannot help with that.' } }) },
  'tool-calls': { status: 200, body: completion({ content: null, finish: 'tool_calls', message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] } }) },
  'content-filter': { status: 200, body: completion({ content: '', finish: 'content_filter' }) },
  'finish-null': { status: 200, body: completion({ finish: null }) },
  empty: { status: 200, body: completion({ content: '' }) },
  'two-choices': {
    status: 200,
    body: completion({
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'a' } },
        { index: 1, finish_reason: 'stop', message: { role: 'assistant', content: 'b' } },
      ],
    }),
  },
  'user-role': { status: 200, body: completion({ message: { role: 'user' } }) },
  'error-200': { status: 200, body: { error: { message: 'Upstream provider returned an error', code: 502 }, user_id: 'user_fixture' } },
  'choice-error': { status: 200, body: completion({ choices: [{ index: 0, finish_reason: 'error', error: { message: 'upstream died', code: 502 }, message: { role: 'assistant', content: 'partial' } }] }) },
  'echo-content': { status: 200, body: completion({ content: 'your key is {{AUTH}}' }) },
  'echo-model': { status: 200, body: completion({ model: 'anthropic/{{AUTH}}' }) },
  'not-json-schema': { status: 200, body: completion({ content: 'Sure! {"ok": true' }) },
  unpriced: { status: 200, body: completion({ model: 'anthropic/claude-mystery-9', usage: usage(1000, 500) }) },
  'cost-above-table': { status: 200, body: completion({ usage: usage(1000, 500, 1.25) }) },
  cached: {
    status: 200,
    body: completion({
      usage: { ...usage(10_000, 100), prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1000 } },
    }),
  },
};
