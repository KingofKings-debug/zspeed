import { createClient } from 'redis';

export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  isReady: boolean;
}
let client: ReturnType<typeof createClient> | null = null;
let testAdapter: CacheAdapter | null = null;
let hits = 0, misses = 0, failures = 0;
let retryAfter = 0;
export function cacheStatus() {
  return { configured: !!process.env.REDIS_URL, available: !!(testAdapter || client)?.isReady && Date.now()>=retryAfter, hits, misses, failures, ttlSeconds: 5 };
}
export function setCacheAdapterForTests(adapter: CacheAdapter | null): void { testAdapter = adapter; retryAfter = 0; }
function adapter(): CacheAdapter | null {
  if (testAdapter) return testAdapter;
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true,commandsQueueMaxLength:128,
      socket: { connectTimeout: 500, reconnectStrategy: retries => Math.min(5000,250*(retries+1)) } });
    client.on('error', () => { failures++; });
    void client.connect().catch(() => { failures++; });
  }
  return client;
}
export async function bounded<T>(operation: Promise<T>, timeoutMs=80): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_,reject) => { timer=setTimeout(() => reject(new Error('Cache timed out')),timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
export async function cachedRead(key: string, load: () => any): Promise<any> {
  const cache = adapter();
  if (cache?.isReady && Date.now()>=retryAfter) {
    try {
      const value = await bounded(cache.get(key));
      if (value) { const parsed=JSON.parse(value);hits++; return {...parsed, freshness:{...parsed.freshness,source:'redis'}}; }
    } catch { failures++; retryAfter=Date.now()+5000; }
  }
  misses++;
  const value = load();
  if (value && cache?.isReady && Date.now()>=retryAfter) {
    // Cache writes never hold up a response. Old entries expire after five seconds.
    void bounded(cache.set(key,JSON.stringify(value),{EX:5})).catch(() => { failures++; retryAfter=Date.now()+5000; });
  }
  return value;
}
export function closeReadCache(): void { if (client) { client.destroy(); client=null; } }
