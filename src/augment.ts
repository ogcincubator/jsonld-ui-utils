import {
  CreatePropertiesTableOptions,
  defaultFetchResourceOptions,
  fetchResource,
  FetchResourceOptions,
} from "./resource";
import {asKeyword, ContextStack, expandIri, findTerm, pushContext} from "./context";
import {ContextDefinition} from "jsonld";
import {Context, loadContextEntries} from "./jsonld";

export interface AugmentOptions extends FetchResourceOptions {
  replaceElements: boolean,
  /** Base URL for resolving relative identifiers (overridden by @base in the context) */
  baseUrl?: string,
}

const defaultAugmentOptions: AugmentOptions = {
  replaceElements: true,
  ...defaultFetchResourceOptions,
};

const defaultTableOptions = {
  propertiesField: 'properties' as string | null,
  maxDepth: 15,
  maxElements: 100,
};

// Never cut by maxElements, since augment() needs them (e.g. for type-scoped contexts). Contexts are
// not known when rendering, so only the usual aliases of @id and @type can be recognized.
const ALWAYS_SHOWN = new Set(['@id', '@type', 'id', 'type']);

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const isObject = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// {"@list": [...]} and {"@set": [...]} are displayed as plain arrays
const unwrapContainer = (value: any): any => {
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && (keys[0] === '@list' || keys[0] === '@set')) {
      return value[keys[0]];
    }
  }
  return value;
};

// An object holding nothing but @graph (and possibly @context) just wraps its contents, typically to
// have a top-level array next to @context. With anything else, as in a named graph, @graph has meaning.
const isGraphWrapper = (value: any): value is Record<string, any> =>
  isObject(value) && '@graph' in value && Object.keys(value).every(k => k === '@graph' || k === '@context');

const appendSpan = (parent: HTMLElement, className: string, text: string) => {
  const span = document.createElement('span');
  span.classList.add(className);
  span.textContent = text;
  parent.appendChild(span);
  return span;
};

// @context entries found in the data, kept out of the DOM for augment() to apply. Each table has the
// ones to apply to it in order: its own, preceded by those of any @graph wrappers it replaced.
const embeddedContexts = new WeakMap<Element, Context[]>();

export function createPropertiesTable(feature: { [index: string]: any }, container: HTMLElement,
                                      options: CreatePropertiesTableOptions = {}) {
  const {propertiesField, maxDepth, maxElements} = {...defaultTableOptions, ...options};

  const createLevel = (parent: HTMLElement, rawValue: any, depth: number, addHeaders = false,
                       wrapperContexts: Context[] = []) => {
    const value = unwrapContainer(rawValue);

    if (isGraphWrapper(value)) {
      const contexts = '@context' in value ? [...wrapperContexts, value['@context']] : wrapperContexts;
      createLevel(parent, value['@graph'], depth, addHeaders, contexts);
      return;
    }

    if (isObject(value) && '@value' in value) {
      // Value object: a single literal, plus its language or datatype
      createLevel(parent, value['@value'], depth);
      for (const [keyword, className] of [['@language', 'literal-language'], ['@type', 'literal-datatype']]) {
        if (keyword in value) {
          appendSpan(parent, className, String(value[keyword]));
        }
      }
      return;
    }

    if (value === null || typeof value !== 'object') {
      appendSpan(parent, 'literal-value', '' + value);
      return;
    }

    const isArray = Array.isArray(value);
    const entries: [string, any][] = isArray
      ? value.map((v: any, i: number) => [String(i), v])
      : Object.entries(value).filter(([k]) => k !== '@context');
    if (isArray && !entries.length) {
      return;
    }
    if (depth > maxDepth && entries.length) {
      appendSpan(parent, 'truncated-value',
        isArray ? plural(entries.length, 'item') : plural(entries.length, 'property', 'properties'));
      return;
    }

    const table = document.createElement('table');
    table.classList.add(isArray ? 'array-table' : 'object-table');
    const contexts = !isArray && '@context' in value ? [...wrapperContexts, value['@context']] : wrapperContexts;
    if (contexts.length) {
      embeddedContexts.set(table, contexts);
    }
    if (addHeaders && !isArray) {
      table.innerHTML = '<thead><tr><th>Property</th><th>Value</th></tr></thead>';
    }
    const tbody = document.createElement('tbody');
    const addCell = (row: HTMLElement, ...classNames: string[]) => {
      const cell = document.createElement('td');
      cell.classList.add(...classNames);
      row.appendChild(cell);
      return cell;
    };

    let remaining = maxElements - (isArray ? 0 : entries.filter(([k]) => ALWAYS_SHOWN.has(k)).length);
    const shown = entries.filter(([k]) => (!isArray && ALWAYS_SHOWN.has(k)) || remaining-- > 0);

    for (const [k, v] of shown) {
      const row = document.createElement('tr');
      if (isArray) {
        createLevel(addCell(row, 'array-value', 'array-entry'), v, depth + 1);
      } else {
        const keyCell = addCell(row, 'object-property');
        keyCell.setAttribute('data-property', k);
        keyCell.textContent = k;
        createLevel(addCell(row, 'object-value'), v, depth + 1);
      }
      tbody.appendChild(row);
    }

    const hidden = entries.length - shown.length;
    if (hidden) {
      const row = document.createElement('tr');
      const cell = addCell(row, isArray ? 'array-value' : 'truncated-cell') as HTMLTableCellElement;
      if (!isArray) {
        cell.colSpan = 2;
      }
      appendSpan(cell, 'truncated-value', isArray
        ? plural(hidden, 'more item')
        : plural(hidden, 'more property', 'more properties'));
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    parent.appendChild(table);
  };

  const wrapper = document.createElement('div');
  wrapper.classList.add('object-properties');
  container.appendChild(wrapper);
  createLevel(wrapper, propertiesField ? feature[propertiesField] : feature, 1, true);
}

export async function augment(rootElem: HTMLElement, context: ContextDefinition, options: Partial<AugmentOptions> = {}) {

  const mergedOptions = {...defaultAugmentOptions, ...options};
  const {baseUrl} = mergedOptions;

  // Object tables, and array tables that have contexts of their own
  const isNode = (elem: Element) => elem.classList.contains('object-table') || embeddedContexts.has(elem);

  // Outermost such tables below an element (looking through other arrays and wrappers)
  const findTables = (elem: Element): HTMLTableElement[] =>
    Array.from(elem.children).flatMap(child =>
      isNode(child) ? [child as HTMLTableElement] : findTables(child));

  // Literal values of a cell, not including those that belong to nested objects
  const findLiterals = (elem: Element): HTMLElement[] =>
    Array.from(elem.children).flatMap(child => {
      if (child.classList.contains('literal-value')) {
        return [child as HTMLElement];
      }
      return child.classList.contains('object-table') ? [] : findLiterals(child);
    });

  const updateElement = (elem: HTMLElement, resourceUri: string,
                         replaceElements = true) => {
    elem.setAttribute('data-uri', resourceUri);
    elem.classList.add('resource-loading');
    fetchResource(resourceUri, mergedOptions)
      .then(resourceData => {
        let elemToUpdate = elem.querySelector('.resource-link') as HTMLElement || elem;
        if (resourceData.label) {
          elem.setAttribute('data-label', resourceData.label);
          if (mergedOptions.replaceElements) {
            elemToUpdate.textContent = resourceData.label;
          }
        }
        if (resourceData.description) {
          elem.setAttribute('data-description', resourceData.description);
          if (mergedOptions.replaceElements) {
            elemToUpdate.title = resourceData.description;
          }
        }
        elem.classList.add('resource-resolved');
      })
      .catch(e => {
        console.error(`Error resolving URI ${resourceUri}: ${e}`, {cause: e});
        elem.classList.add('resource-error');
      })
      .finally(() => {
        elem.classList.remove('resource-loading');
      });
    if (replaceElements) {
      const link = document.createElement("a");
      link.href = resourceUri;
      link.target = '_blank';
      link.classList.add('resource-link');
      while (elem.firstChild) {
        link.appendChild(elem.firstChild);
      }
      elem.appendChild(link);
    }
  };

  const linkLiterals = (valueElem: Element, stack: ContextStack, expandOptions: { vocab?: boolean, base?: boolean }) => {
    for (const literalElem of findLiterals(valueElem)) {
      const iri = expandIri(literalElem.textContent!.trim(), stack, {...expandOptions, baseUrl});
      if (iri && !iri.startsWith('@')) {
        updateElement(literalElem, iri, mergedOptions.replaceElements);
      }
    }
  };

  // The stack with an embedded context on top, if it can be loaded
  const pushEmbedded = async (stack: ContextStack, context: Context) => {
    try {
      // Loading modifies the context, which belongs to the caller's data
      const copy = JSON.parse(JSON.stringify(context));
      const entries = await loadContextEntries(copy, {baseUrl, requestTimeout: mergedOptions.requestTimeout});
      return entries.reduce(pushContext, stack);
    } catch (e) {
      console.warn(`Error loading embedded context: ${e}`, {cause: e});
      return stack;
    }
  };

  const augmentNode = async (table: HTMLTableElement, inheritedStack: ContextStack): Promise<void> => {
    let stack = inheritedStack;
    // Only waits when there is something to load
    for (const context of embeddedContexts.get(table) ?? []) {
      stack = await pushEmbedded(stack, context);
    }
    if (table.classList.contains('array-table')) {
      await Promise.all(findTables(table).map(child => augmentNode(child, stack)));
      return;
    }
    const children: Promise<void>[] = [];
    const rows = Array.from(table.querySelectorAll(':scope > tbody > tr')).flatMap(row => {
      const propElem = row.querySelector(':scope > .object-property') as HTMLElement | null;
      if (!propElem) {
        return [];
      }
      return [{
        propElem,
        valueElem: row.querySelector(':scope > .object-value'),
        name: propElem.getAttribute('data-property') || propElem.textContent!.trim(),
      }];
    });

    // Type-scoped contexts apply to this node only, in lexicographical order of the types
    const types = rows
      .filter(({name}) => asKeyword(name, stack) === '@type')
      .flatMap(({valueElem}) => valueElem ? findLiterals(valueElem) : [])
      .map(elem => elem.textContent!.trim())
      .sort();
    const nodeStack = types.reduce((result, type) => {
      const scoped = findTerm(type, stack)?.['@context'];
      return scoped === undefined ? result : pushContext(result, scoped);
    }, stack);

    for (const {propElem, valueElem, name} of rows) {
      const keyword = asKeyword(name, nodeStack);
      let childStack = stack;
      if (keyword === '@type') {
        // Types are resolved before applying their scoped contexts
        if (valueElem) {
          linkLiterals(valueElem, stack, {vocab: true, base: true});
        }
        updateElement(propElem, RDF_TYPE, mergedOptions.replaceElements);
      } else if (keyword === '@id') {
        if (valueElem) {
          linkLiterals(valueElem, nodeStack, {base: true});
        }
      } else if (keyword) {
        // Other keywords (@graph, @reverse, @nest...) keep the current context
        childStack = nodeStack;
      } else {
        const definition = findTerm(name, nodeStack);
        const propertyUri = expandIri(name, nodeStack, {vocab: true});
        if (propertyUri) {
          updateElement(propElem, propertyUri, mergedOptions.replaceElements);
        }
        if (definition?.['@context'] !== undefined) {
          childStack = pushContext(stack, definition['@context']);
        }
        const coercion = definition?.['@type'];
        if (valueElem && (coercion === '@id' || coercion === '@vocab')) {
          const valueStack = definition?.['@context'] === undefined
            ? nodeStack : pushContext(nodeStack, definition['@context']);
          linkLiterals(valueElem, valueStack, {vocab: coercion === '@vocab', base: true});
        }
      }
      if (valueElem) {
        children.push(...findTables(valueElem).map(child => augmentNode(child, childStack)));
      }
    }
    await Promise.all(children);
  };

  const rootStack = pushContext([], context ?? {});
  const rootTables = isNode(rootElem)
    ? [rootElem as HTMLTableElement] : findTables(rootElem);
  await Promise.all(rootTables.map(table => augmentNode(table, rootStack)));
}
