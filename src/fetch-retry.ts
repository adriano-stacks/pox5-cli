const RETRY_DELAYS_MS = [250, 1000, 3000];
const RETRY_STATUSES = new Set([502, 503, 504]);

// API gateways can intermittently time out on connect or return a transient
// upstream error. Undici surfaces connect failures as TypeError('fetch failed');
// in both cases the upstream never processed the request, so retrying is safe.
export function installFetchRetry(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    for (let attempt = 0; ; attempt++) {
      const lastAttempt = attempt >= RETRY_DELAYS_MS.length;
      try {
        const res = await original(...args);
        if (lastAttempt || !RETRY_STATUSES.has(res.status)) return res;
      } catch (err) {
        if (lastAttempt || !isTransientNetworkError(err)) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }) as typeof fetch;
}

function isTransientNetworkError(err: unknown): boolean {
  return err instanceof TypeError && err.message === 'fetch failed';
}
