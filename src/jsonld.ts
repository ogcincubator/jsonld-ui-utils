import {ContextDefinition} from 'jsonld';

type OrArray<T> = T | T[];

export type Context = OrArray<null | string | ContextDefinition>;

export type ContextObject = {
  "@context": Context;
}

const jsonFetch = async (url: string, timeout: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: {'Accept': 'application/json'},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status} loading context ${url}`);
    }
    return await response.json() as ContextObject;
  } finally {
    clearTimeout(timer);
  }
};

const mergeContexts = (definitions: ContextDefinition[]) => {
  const mergePair = (a: ContextDefinition | null | undefined,
                     b: ContextDefinition): ContextDefinition => {
    if (!a || !Object.keys(a).length) {
      return b;
    }
    const result = {...a};
    for (const [k, v] of Object.entries(b)) {
      result[k] = v;
    }
    return result;
  };

  if (!definitions.length) {
    return {};
  }
  if (definitions.length === 1) {
    return definitions[0];
  }
  let currentContext = definitions[0];
  for (let i = 1; i < definitions.length; i++) {
    currentContext = mergePair(currentContext, definitions[i]);
  }
  return currentContext;
};


/** Loaded context definitions in order of application; null resets the ones before it */
export type ContextEntries = (ContextDefinition | null)[];

const urlCache = new Map<string, Promise<ContextEntries>>();

export interface LoadContextOptions {
  /** Base URL for resolving relative context references */
  baseUrl?: string,
  /** Timeout in milliseconds for each remote context. Default: 10000 */
  requestTimeout?: number,
}

const resolveUrl = (url: string, baseUrl?: string) => {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
};

/**
 * Loads a context without merging its entries. Remote references are replaced by their contents,
 * including the scoped contexts of term definitions, which are modified in place.
 */
export async function loadContextEntries(context: Context | undefined,
                                         options: LoadContextOptions = {}): Promise<ContextEntries> {
  const {requestTimeout = 10000} = options;

  const walk = async (definition: object, refChain?: string[], baseUrl?: string) => {
    for (const [key, value] of Object.entries(definition)) {
      if (key === '@context') {
        const entries = await load(value as Context, refChain, baseUrl);
        // @ts-ignore
        definition[key] = entries.length === 1 ? entries[0] : entries;
      } else if (typeof value === 'object' && value !== null) {
        await walk(value, refChain, baseUrl);
      }
    }
  };

  const load = async (context: Context | undefined, refChain?: string[], baseUrl?: string): Promise<ContextEntries> => {
    if (context === undefined) {
      return [];
    }
    if (context === null) {
      return [null];
    }
    if (Array.isArray(context)) {
      return (await Promise.all(context.map(e => load(e, refChain, baseUrl)))).flat();
    }
    if (typeof context === 'object') {
      await walk(context, refChain, baseUrl);
      return [context];
    }
    const url = resolveUrl(context, baseUrl);
    if (refChain?.includes(url)) {
      throw new Error('Circular dependencies found: ' + refChain.join(' -> ') + ' -> ' + url);
    }
    const newRefChain = [...(refChain ?? []), url];
    if (!urlCache.has(url)) {
      // Relative references inside a remote context are resolved against that context's own URL
      const request = jsonFetch(url, requestTimeout).then(async obj => {
        const entries = await load(obj['@context'], newRefChain, url);
        // @base is ignored in remote contexts
        return entries.map(entry => {
          if (!entry) {
            return entry;
          }
          const {'@base': _, ...loaded} = entry as any;
          return loaded as ContextDefinition;
        });
      });
      // Failures are not cached, so that they can be retried
      request.catch(() => urlCache.delete(url));
      urlCache.set(url, request);
    }
    return urlCache.get(url)!;
  };

  return load(context, undefined, options.baseUrl);
}

export async function loadContext(context: Context | ContextObject, options: LoadContextOptions = {}) {
  const unwrapped = typeof context === 'object' && context !== null && '@context' in context
    ? (context as ContextObject)['@context']
    : context as Context;
  const entries = await loadContextEntries(unwrapped, options);
  return mergeContexts(entries.map(entry => entry ?? {}));
}
