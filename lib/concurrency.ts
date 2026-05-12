/**
 * 동시 실행 개수 제한.
 * @example
 *   await mapLimit(items, 3, async (item) => doWork(item))
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  if (limit <= 0) limit = 1;

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (firstError === null) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (firstError === null) firstError = e;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);

  if (firstError !== null) throw firstError;
  return results;
}
