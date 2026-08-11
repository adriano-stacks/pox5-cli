import { clearProgress, progress } from './output.js';

const RETRY_DELAYS_MS = [250, 1000, 3000];
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_RATE_LIMIT_RETRIES = 4;

// API gateways can intermittently time out on connect or return a transient
// upstream error. Undici surfaces connect failures as TypeError('fetch failed');
// in both cases the upstream never processed the request, so retrying is safe.
export function installFetchRetry(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    let transientAttempts = 0;
    let rateLimitAttempts = 0;
    for (;;) {
      try {
        const res = await original(...args);
        if (res.status === 429 && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
          rateLimitAttempts++;
          const body = await res.text();
          const delayMs = rateLimitDelayMs(res.headers.get('retry-after'), body);
          progress(`API rate limit reached; retrying in ${Math.ceil(delayMs / 1000)} seconds…`);
          await sleep(delayMs);
          clearProgress();
          continue;
        }
        if (!RETRY_STATUSES.has(res.status) || transientAttempts >= RETRY_DELAYS_MS.length) return res;
      } catch (err) {
        if (transientAttempts >= RETRY_DELAYS_MS.length || !isTransientNetworkError(err)) throw err;
      }
      await sleep(RETRY_DELAYS_MS[transientAttempts++]!);
    }
  }) as typeof fetch;
}

function rateLimitDelayMs(retryAfter: string | null, body: string): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000 + 250);

  if (retryAfter) {
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay >= 0) return Math.min(60_000, dateDelay + 250);
  }

  const messageSeconds = body.match(/try again in\s+(\d+)\s+seconds?/i)?.[1];
  if (messageSeconds !== undefined) return Math.min(60_000, Number(messageSeconds) * 1000 + 250);
  return 60_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(err: unknown): boolean {
  return err instanceof TypeError && err.message === 'fetch failed';
}
