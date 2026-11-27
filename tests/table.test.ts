// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {createPropertiesTable} from '../src/augment';

function render(data: any, options: Record<string, any> = {}) {
  const container = document.createElement('div');
  createPropertiesTable(data, container, {propertiesField: null, ...options});
  return container;
}

const keys = (el: Element) => Array.from(el.querySelectorAll('.object-property'), e => e.textContent);
const texts = (el: Element, selector: string) => Array.from(el.querySelectorAll(selector), e => e.textContent);

describe('keywords', () => {
  it('hides @context at every level', () => {
    const el = render({'@context': {a: 'x:a'}, a: {'@context': {b: 'x:b'}, b: 1}});
    expect(keys(el)).toEqual(['a', 'b']);
  });

  it('renders value objects as a single literal', () => {
    const el = render({a: {'@value': 'hola', '@language': 'es'}, b: {'@value': '1', '@type': 'xsd:int'}});
    expect(keys(el)).toEqual(['a', 'b']);
    expect(texts(el, '.literal-value')).toEqual(['hola', '1']);
    expect(texts(el, '.literal-language')).toEqual(['es']);
    expect(texts(el, '.literal-datatype')).toEqual(['xsd:int']);
  });

  it('unwraps @list and @set', () => {
    const el = render({a: {'@list': [1, 2]}, b: {'@set': [3]}});
    expect(keys(el)).toEqual(['a', 'b']);
    expect(texts(el, '.array-entry')).toEqual(['1', '2', '3']);
  });
});

describe('arrays', () => {
  it('renders one cell per entry', () => {
    const el = render({a: ['x', 'y']});
    expect(texts(el, '.array-table > tbody > tr > .array-entry')).toEqual(['x', 'y']);
    expect(el.querySelectorAll('.object-value')).toHaveLength(1);
  });
});

describe('limits', () => {
  const nest = (levels: number): any => levels === 0 ? 'leaf' : {n: nest(levels - 1)};

  it('stops at 15 levels by default', () => {
    expect(render(nest(15)).querySelector('.truncated-value')).toBeNull();
    const el = render(nest(16));
    expect(el.querySelectorAll('.object-table')).toHaveLength(15);
    expect(texts(el, '.truncated-value')).toEqual(['1 property']);
  });

  it('counts arrays as levels', () => {
    const el = render({a: [[[1, 2]]]}, {maxDepth: 3});
    expect(texts(el, '.truncated-value')).toEqual(['2 items']);
  });

  it('caps array entries at 100 by default', () => {
    const el = render({a: Array.from({length: 130}, (_, i) => i)});
    expect(el.querySelectorAll('.array-entry')).toHaveLength(100);
    expect(texts(el, '.truncated-value')).toEqual(['30 more items']);
  });

  it('caps object properties, always keeping identifiers and types', () => {
    const el = render({a: 1, b: 2, c: 3, '@type': 'T', id: 'x'}, {maxElements: 3});
    expect(keys(el)).toEqual(['a', '@type', 'id']);
    expect(texts(el, '.truncated-value')).toEqual(['2 more properties']);
    expect(el.querySelector('.truncated-cell')!.getAttribute('colspan')).toBe('2');
  });

  it('accepts custom limits and keeps the default propertiesField', () => {
    const container = document.createElement('div');
    createPropertiesTable({properties: {a: [1, 2, 3]}, other: 1}, container, {maxElements: 2});
    expect(keys(container)).toEqual(['a']);
    expect(texts(container, '.truncated-value')).toEqual(['1 more item']);
  });
});
