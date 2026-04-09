import { describe, it, expect } from 'vitest';
import * as N3 from 'n3';
import { findInStore } from '../src/resource.js';

const SUBJECT = 'http://example.org/thing';
const PRED = 'http://www.w3.org/2000/01/rdf-schema#label';
const PREDICATES = [PRED];

function makeStore(entries: { value: string; lang?: string }[]): N3.Store {
  const store = new N3.Store();
  for (const { value, lang } of entries) {
    store.addQuad(
      N3.DataFactory.namedNode(SUBJECT),
      N3.DataFactory.namedNode(PRED),
      lang
        ? N3.DataFactory.literal(value, lang)
        : N3.DataFactory.literal(value),
    );
  }
  return store;
}

// Base store: English and Czech only (no language-neutral literal)
const store = makeStore([
  { value: 'English label', lang: 'en' },
  { value: 'Czech label', lang: 'cz' },
]);

// Extended store: adds a no-language literal
const storeWithNoLang = makeStore([
  { value: 'English label', lang: 'en' },
  { value: 'Czech label', lang: 'cz' },
  { value: 'No-language label' },
]);


describe('findInStore language preference: user lang → no lang → en → any', () => {
  describe('base store (en + cz)', () => {
    it('no user languages → falls back to en', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, [])).toBe('English label');
    });

    it('en → matches English', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['en'])).toBe('English label');
    });

    it('es, en → no Spanish, falls through to English', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['es', 'en'])).toBe('English label');
    });

    it('cz, en → prefers Czech', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['cz', 'en'])).toBe('Czech label');
    });

    it('fr, es → no match, falls back to en', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['fr', 'es'])).toBe('English label');
    });
  });

  describe('store with no-language literal (en + cz + no-lang)', () => {
    it('no user languages → prefers no-language over en', () => {
      expect(findInStore(storeWithNoLang, SUBJECT, PREDICATES, [])).toBe('No-language label');
    });

    it('fr, es → no match, prefers no-language over en', () => {
      expect(findInStore(storeWithNoLang, SUBJECT, PREDICATES, ['fr', 'es'])).toBe('No-language label');
    });

    it('cz → matches Czech, ignores no-language', () => {
      expect(findInStore(storeWithNoLang, SUBJECT, PREDICATES, ['cz'])).toBe('Czech label');
    });
  });

  describe('full locale inputs against base store (en + cz)', () => {
    it('en-US → base "en" matches en', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['en-US'])).toBe('English label');
    });

    it('cz-CZ → base "cz" matches cz', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['cz-CZ'])).toBe('Czech label');
    });

    it('es-MX, cz-CZ → no Spanish, base "cz" matches cz', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['es-MX', 'cz-CZ'])).toBe('Czech label');
    });

    it('es-ES, en-GB → no Spanish, base "en" matches en', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['es-ES', 'en-GB'])).toBe('English label');
    });

    it('fr-FR → no match, falls back to en', () => {
      expect(findInStore(store, SUBJECT, PREDICATES, ['fr-FR'])).toBe('English label');
    });
  });
});
