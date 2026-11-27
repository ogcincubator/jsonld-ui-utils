// Limits how many HTTP requests run at once, across all lookups

let active = 0;
const waiting: { limit: number, priority: boolean, start: () => void }[] = [];

function startWaiting() {
  while (waiting.length && active < waiting[0].limit) {
    active++;
    waiting.shift()!.start();
  }
}

export interface RequestOptions {
  limit: number,
  timeout: number,
  /** Go ahead of the non-priority requests already waiting */
  priority?: boolean,
}

/**
 * Runs a task holding one request slot. The task must pass the signal to fetch() and include reading
 * the response body, so that the slot is held (and the timeout applies) until the request is done.
 */
export async function withRequestSlot<T>(task: (signal: AbortSignal) => Promise<T>,
                                         {limit, timeout, priority = false}: RequestOptions): Promise<T> {
  await new Promise<void>(start => {
    // Priority requests queue up behind earlier priority ones, ahead of everything else
    const firstNormal = priority ? waiting.findIndex(entry => !entry.priority) : -1;
    waiting.splice(firstNormal < 0 ? waiting.length : firstNormal, 0, {limit: Math.max(1, limit), priority, start});
    startWaiting();
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
    active--;
    startWaiting();
  }
}
