import {ContextDefinition} from 'jsonld';

type OrArray<T> = T | T[];

export type Context = OrArray<null | string | ContextDefinition>;

export type ContextObject = {
  "@context": Context;
}

const jsonFetch = async (url: string) => {
  const response = await fetch(url, {
    headers: {'Accept': 'application/json'},
  });
  return await response.json() as ContextObject;
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


const urlCache = new Map<string, Promise<ContextDefinition>>();

export interface LoadContextOptions {
  /** Base URL for resolving relative context references */
  baseUrl?: string,
}

const resolveUrl = (url: string, baseUrl?: string) => {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
};

export async function loadContext(context: Context | ContextObject, options: LoadContextOptions = {}) {
  const walk = async (definition: object, refChain?: string[], baseUrl?: string) => {
    for (const [key, value] of Object.entries(definition)) {
      if (key === '@context') {
        // @ts-ignore
        definition[key] = await load(value as Context, refChain, baseUrl);
      } else if (typeof value === 'object' && value !== null) {
        await walk(value, refChain, baseUrl);
      }
    }
  };

  const load = async (context: Context, refChain?: string[], baseUrl?: string): Promise<ContextDefinition> => {
    if (context === null || typeof context === 'undefined') {
      return {};
    }
    if (Array.isArray(context)) {
      // fetch and merge
      const contextEntries = await Promise.all(context.map(e => load(e, refChain, baseUrl)));
      return mergeContexts(contextEntries);
    } else if (typeof context === 'object') {
      await walk(context, refChain, baseUrl);
      return context;
    } else {
      const url = resolveUrl(context, baseUrl);
      if (refChain?.includes(url)) {
        throw new Error('Circular dependencies found: ' + refChain.join(' -> ') + ' -> ' + url);
      }
      const newRefChain = [...(refChain ?? []), url];
      if (!urlCache.has(url)) {
        // Relative references inside a remote context are resolved against that context's own URL
        urlCache.set(url, jsonFetch(url).then(async obj => {
          // @base is ignored in remote contexts
          const {'@base': _, ...loaded} = await load(obj['@context'], newRefChain, url) as any;
          return loaded as ContextDefinition;
        }));
      }
      return urlCache.get(url) as Promise<ContextDefinition>;
    }
  };

  if (typeof context === 'object' && context !== null && '@context' in context) {
    return load((context as ContextObject)['@context'], undefined, options.baseUrl);
  } else {
    return load(context, undefined, options.baseUrl);
  }
}