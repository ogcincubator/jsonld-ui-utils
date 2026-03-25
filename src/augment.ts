import {
  CreatePropertiesTableOptions,
  defaultFetchResourceOptions,
  fetchResource,
  FetchResourceOptions,
} from "./resource";
import {ContextDefinition, ExpandedTermDefinition} from "jsonld";

export interface AugmentOptions extends FetchResourceOptions {
  replaceElements: boolean,
}

const defaultAugmentOptions: AugmentOptions = {
  replaceElements: true,
  ...defaultFetchResourceOptions,
};

export function createPropertiesTable(feature: { [index: string]: any }, container: HTMLElement,
                                      options: CreatePropertiesTableOptions = {
                                        propertiesField: 'properties',
                                      }) {
  const createLevel = (parent: HTMLElement, value: any, addHeaders = false) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const newElem = createLevel(parent, entry);
        newElem.classList.add('array-entry');
      }
      return parent;
    } else if (value === null || typeof value === 'undefined' || typeof value !== 'object') {
      const span = document.createElement('span');
      span.classList.add('literal-value');
      span.textContent = '' + value;
      parent.appendChild(span);
      return span;
    } else {
      const table = document.createElement('table');
      table.classList.add('object-table');
      if (addHeaders) {
        table.innerHTML = '<thead><tr><th>Property</th><th>Value</th></tr></thead>';
      }
      const tbody = document.createElement('tbody');
      Object.entries(value).forEach(([k, v]) => {
        const row = document.createElement('tr');
        const keyCell = document.createElement('td');
        keyCell.classList.add('object-property');
        keyCell.setAttribute('data-property', k);
        keyCell.textContent = k;
        row.appendChild(keyCell);
        const valueCell = document.createElement('td');
        valueCell.classList.add('object-value');
        createLevel(valueCell, v);
        row.appendChild(valueCell);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      parent.appendChild(table);
      return table;
    }
  };
  const wrapper = document.createElement('div');
  wrapper.classList.add('object-properties');
  container.appendChild(wrapper);
  if (options.propertiesField) {
    createLevel(wrapper, feature[options.propertiesField], true);
  } else {
    createLevel(wrapper, feature, true);
  }
}

export async function augment(rootElem: HTMLElement, context: ContextDefinition, options: Partial<AugmentOptions> = {}) {

  const mergedOptions = {...defaultAugmentOptions, ...options};

  const resolveTerm = (term: string, contextStack: ContextDefinition[],
                       useVocab = true, useBase = false): ExpandedTermDefinition | null => {
    if (term.indexOf('://') !== -1) {
      return {'@id': term};
    }
    let closestVocab: string | null = null;
    let closestBase: string | null = null;
    for (let i = contextStack.length - 1; i >= 0; i--) {
      if (term in contextStack[i]) {
        let resolvedTerm = contextStack[i][term];
        let resolvedId: string;
        if (resolvedTerm === null || typeof resolvedTerm === 'undefined' || typeof resolvedTerm === 'boolean'
          || Array.isArray(resolvedTerm)) {
          continue;
        }
        if (typeof resolvedTerm === 'string') {
          if (resolvedTerm === '@type') {
            return {'@id': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'};
          }
          resolvedId = resolvedTerm;
          resolvedTerm = {'@id': resolvedTerm};
        } else if (typeof resolvedTerm === 'object' && '@id' in resolvedTerm && typeof resolvedTerm['@id'] === 'string') {
          resolvedId = resolvedTerm['@id'];
        } else {
          continue;
        }
        const idx = resolvedId.indexOf(':');
        if (idx > -1) {
          const prefix = resolvedId.substring(0, idx);
          const localPart = resolvedId.substring(idx + 1);
          if (localPart.startsWith('//')) {
            // Full URI -> return
            return resolvedTerm;
          }
          const resolvedPrefix = resolveTerm(prefix, contextStack);
          if (resolvedPrefix !== null && '@id' in resolvedPrefix && typeof resolvedPrefix['@id'] === 'string') {
            // Prefix found and resolved
            resolvedTerm['@id'] = `${resolvedPrefix['@id']}${localPart}`;
          }
          return resolvedTerm;
        }
      }
      if (closestVocab === null && contextStack[i]['@vocab']) {
        closestVocab = contextStack[i]['@vocab']!;
      }
      if (closestBase === null && contextStack[i]['@base']) {
        closestBase = contextStack[i]['@base']!;
      }
    }
    if (term.indexOf(':') === -1) {
      if (useVocab && closestVocab) {
        return {'@id': `${closestVocab}${term}`};
      }
      if (useBase && closestBase) {
        return {'@id': `${closestBase}${term}`};
      }
    }
    return null;
  };

  const findPropertyChildren = (elem: HTMLElement) => {
    const walker = document.createTreeWalker(elem, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node: Node): number {
        const nodeElem = node as HTMLElement;
        if (node !== elem && nodeElem.classList.contains('object-value')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (nodeElem.classList.contains('object-property')) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    const result: HTMLElement[] = [];
    let cur;
    while ((cur = walker.nextNode())) {
      result.push(cur as HTMLElement);
    }
    return result;
  };

  const findLiteralChildren = (elem: HTMLElement) => {
    const result: HTMLElement[] = [];
    const walker = document.createTreeWalker(elem, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node: Node): number {
        const nodeElem = node as HTMLElement;
        if (nodeElem.classList.contains('object-property') || nodeElem.classList.contains('object-value')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (nodeElem.classList.contains('literal-value')) {
          result.push(nodeElem);
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) {
    }
    return result;
  };

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

  const augmentInner = (elem: HTMLElement, contextStack: ContextDefinition[]) => {
    const propElems = findPropertyChildren(elem);
    for (const propElem of propElems) {
      let propertyName: string | null = null;
      propertyName = propElem.getAttribute('data-property');
      if (!propertyName) {
        propertyName = propElem.textContent.trim();
      }
      const resolvedProperty = resolveTerm(propertyName, contextStack);
      let newContextStack = contextStack;
      const valueElem = propElem.parentElement?.querySelector('.object-value') as HTMLElement;
      if (resolvedProperty && '@id' in resolvedProperty && typeof resolvedProperty['@id'] === 'string') {
        const propertyUri = resolvedProperty['@id'];
        updateElement(propElem, propertyUri, mergedOptions.replaceElements);
        if ('@context' in resolvedProperty) {
          newContextStack = [...contextStack, resolvedProperty['@context']!];
        }
        if (resolvedProperty['@type'] === '@id' && valueElem) {
          const literalElems = findLiteralChildren(valueElem);
          literalElems.forEach(literalElem => {
            const resolvedLiteral = resolveTerm(literalElem.textContent.trim(),
              newContextStack, false, true);
            if (resolvedLiteral && '@id' in resolvedLiteral && typeof resolvedLiteral['@id'] === 'string') {
              const resourceUri = resolvedLiteral['@id'];
              updateElement(literalElem, resourceUri, mergedOptions.replaceElements);
            }
          });
        }
      }
      if (valueElem) {
        augmentInner(valueElem as HTMLElement, newContextStack);
      }
    }
  };
  augmentInner(rootElem, [context]);
}
