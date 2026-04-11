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

export async function loadContext(context: Context | ContextObject) {
  const walk = async (definition: object, refChain?: string[]) => {
    for (const [key, value] of Object.entries(definition)) {
      if (key === '@context') {
        // @ts-ignore
        definition[key] = await load(value as Context, refChain);
      } else if (typeof value === 'object' && value !== null) {
        await walk(value, refChain);
      }
    }
  };

  const load = async (context: Context, refChain?: string[]): Promise<ContextDefinition> => {
    if (context === null || typeof context === 'undefined') {
      return {};
    }
    if (Array.isArray(context)) {
      // fetch and merge
      const contextEntries = await Promise.all(context.map(e => load(e, refChain)));
      return mergeContexts(contextEntries);
    } else if (typeof context === 'object') {
      await walk(context, refChain);
      return context;
    } else {
      if (refChain?.includes(context)) {
        throw new Error('Circular dependencies found: ' + refChain.join(' -> ') + ' -> ' + context);
      }
      const newRefChain = Array.isArray(refChain) ? refChain?.slice() : [];
      newRefChain.push(context);
      if (!urlCache.has(context)) {
        urlCache.set(context, jsonFetch(context).then(obj => load(obj['@context'], newRefChain)));
      }
      return urlCache.get(context) as Promise<ContextDefinition>;
    }
  };

  if (typeof context === 'object' && context !== null && '@context' in context) {
    return load((context as ContextObject)['@context']);
  } else {
    return load(context);
  }
}