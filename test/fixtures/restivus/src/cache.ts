/**
 * Three arguments, a string first, a record second, something callable third — and not a
 * route. `get` on a settings bag or a cache is the shape the leading-slash rule exists to
 * refuse, and it is refused here on the options instead.
 */
declare const cache: {
  get(key: string, options: { ttl: number; stale: boolean }, fallback: () => unknown): unknown;
};
declare const config: { get(key: string): string };

cache.get('sessions', { ttl: 60, stale: true }, () => config.get('url'));
