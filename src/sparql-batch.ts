import type * as N3 from 'n3';

// Collects URIs into one DESCRIBE query per endpoint. A batch is sent when the first of these happens:
// it is full, no earlier lookup is pending (so nothing else can join soon), or MAX_WAIT has passed.

const MAX_WAIT = 500;

export type SendQuery = (query: string) => Promise<N3.Store | null>;

interface Batch {
  uris: string[],
  result: Promise<N3.Store | null>,
  send: () => void,
}

const batches: { [endpoint: string]: Batch } = {};
let pendingLookups = 0;
let idleCheckScheduled = false;

// Deferred, so that URIs arriving in the same burst end up in the same batch
function scheduleIdleCheck() {
  if (idleCheckScheduled) {
    return;
  }
  idleCheckScheduled = true;
  setTimeout(() => {
    idleCheckScheduled = false;
    if (!pendingLookups) {
      Object.values(batches).forEach(batch => batch.send());
    }
  }, 0);
}

/** Tracks the lookup stages that run before SPARQL, and can therefore still feed a batch */
export async function trackLookup<T>(lookup: () => Promise<T>): Promise<T> {
  pendingLookups++;
  try {
    return await lookup();
  } finally {
    pendingLookups--;
    scheduleIdleCheck();
  }
}

// Characters not allowed inside <...> in SPARQL: one such URI would break the query for its whole batch
export const isQueryableIri = (uri: string) => /^[a-z][a-z0-9+.-]*:[^\u0000- <>"{}|^`\\]*$/i.test(uri);

function createBatch(endpoint: string, sendQuery: SendQuery): Batch {
  const uris: string[] = [];
  let resolve!: (store: Promise<N3.Store | null>) => void;
  const result = new Promise<N3.Store | null>(r => resolve = r);
  const batch: Batch = {
    uris,
    result,
    send() {
      clearTimeout(timer);
      delete batches[endpoint];
      resolve(sendQuery(`DESCRIBE ${uris.map(uri => `<${uri}>`).join(' ')}`));
    },
  };
  const timer = setTimeout(batch.send, MAX_WAIT);
  return batch;
}

/** Resolves with the response to the query that included this URI */
export function describeInBatch(endpoint: string, uri: string, batchSize: number,
                                sendQuery: SendQuery): Promise<N3.Store | null> {
  const batch = batches[endpoint] ??= createBatch(endpoint, sendQuery);
  batch.uris.push(uri);
  if (batch.uris.length >= batchSize) {
    batch.send();
  } else {
    scheduleIdleCheck();
  }
  return batch.result;
}
