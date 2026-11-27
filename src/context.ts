import {ContextDefinition} from "jsonld";

// Minimal JSON-LD term and IRI resolution over a stack of already-loaded contexts (innermost last).
// A null entry in a context resets everything before it, as in JSON-LD.

export type ContextStack = ContextDefinition[];

export interface TermDefinition {
  '@id'?: string | null,
  '@reverse'?: string,
  '@type'?: string,
  '@context'?: any,
}

export interface ExpandOptions {
  /** Resolve as a vocabulary term (property names, types): term definitions and @vocab apply */
  vocab?: boolean,
  /** Resolve as a document-relative reference (@id values): @base / baseUrl apply */
  base?: boolean,
  baseUrl?: string,
}

const has = (obj: any, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export function pushContext(stack: ContextStack, context: any): ContextStack {
  if (Array.isArray(context)) {
    return context.reduce(pushContext, stack);
  }
  if (context === null) {
    return [];
  }
  return typeof context === 'object' ? [...stack, context] : stack;
}

// Innermost value of a context entry; undefined if no context in the stack declares it
function findEntry(stack: ContextStack, key: string): any {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (has(stack[i], key)) {
      return (stack[i] as any)[key];
    }
  }
  return undefined;
}

/** Term definition in object form; null if the term is explicitly unmapped, undefined if unknown */
export function findTerm(term: string, stack: ContextStack): TermDefinition | null | undefined {
  const entry = findEntry(stack, term);
  if (typeof entry === 'string') {
    return {'@id': entry};
  }
  if (entry && typeof entry === 'object') {
    return entry['@id'] === null ? null : entry;
  }
  return entry === null ? null : undefined;
}

/** The keyword (`@id`, `@type`...) that a key stands for, either directly or through an alias */
export function asKeyword(key: string, stack: ContextStack): string | null {
  if (key.startsWith('@')) {
    return key;
  }
  const id = findTerm(key, stack)?.['@id'];
  return id?.startsWith('@') ? id : null;
}

export function expandIri(value: string, stack: ContextStack, options: ExpandOptions,
                          seen: Set<string> = new Set()): string | null {
  if (value.startsWith('@')) {
    return value;
  }
  const expandTerm = (term: string) => expandIri(term, stack, {vocab: true}, seen);

  if (options.vocab && !seen.has(value)) {
    const definition = findTerm(value, stack);
    if (definition === null) {
      return null;
    }
    const id = definition?.['@reverse'] ?? definition?.['@id'];
    if (id && id !== value) {
      seen.add(value);
      return expandTerm(id);
    }
  }

  const colon = value.indexOf(':');
  if (colon > -1) {
    const prefix = value.substring(0, colon);
    const localPart = value.substring(colon + 1);
    if (prefix === '_') {
      return null;
    }
    if (!localPart.startsWith('//') && !seen.has(prefix) && findTerm(prefix, stack)) {
      const expandedPrefix = expandIri(prefix, stack, {vocab: true}, new Set(seen));
      if (expandedPrefix) {
        return `${expandedPrefix}${localPart}`;
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      return value;
    }
  }

  if (options.vocab) {
    const vocab = findEntry(stack, '@vocab');
    if (vocab) {
      const expandedVocab = vocab.includes(':') ? vocab : (findTerm(vocab, stack)?.['@id'] ?? vocab);
      return `${expandedVocab}${value}`;
    }
  }

  if (options.base) {
    const contextBase = findEntry(stack, '@base');
    if (contextBase === null) {
      return null;
    }
    try {
      const base = contextBase === undefined ? options.baseUrl : new URL(contextBase, options.baseUrl).toString();
      return base ? new URL(value, base).toString() : null;
    } catch {
      return null;
    }
  }

  return null;
}
