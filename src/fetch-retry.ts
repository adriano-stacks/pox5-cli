const RETRY_DELAYS_MS = [250, 1000, 3000];
const RETRY_STATUSES = new Set([502, 503, 504]);

// The private testnet API sits behind Cloudflare and intermittently times out
// on TCP connect (~1 in 5 fresh connections) or 503s before the upstream
// responds. Undici surfaces connect failures as TypeError('fetch failed');
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
