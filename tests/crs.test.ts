import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectCrs, getProjectionConverter, transformFeatureCollection } from '../src/crs.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Plain GeoJSON — no CRS information whatsoever */
const vanillaGeoJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Null Island' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
  ],
};

/**
 * JSON-FG feature collection with a coordRefSys URI (EPSG:27700 – British National Grid).
 * Mirrors the real OGC airports example.
 */
const jsonfgUriCollection = {
  type: 'FeatureCollection',
  conformsTo: ['http://www.opengis.net/spec/json-fg-1/0.3/conf/core'],
  coordRefSys: 'http://www.opengis.net/def/crs/EPSG/0/27700',
  features: [
    {
      type: 'Feature',
      id: 1,
      properties: { name: 'Papa Stour Airstrip' },
      place: { type: 'Point', coordinates: [417057.93, 1159772.2] },
      geometry: { type: 'Point', coordinates: [-1.6930015, 60.3216821] },
    },
  ],
};

/**
 * JSON-FG feature collection with a coordRefSys Reference object (with epoch).
 * Uses EPSG:4258 (ETRS89) — a common non-WGS84, non-trivial CRS.
 */
const jsonfgReferenceCollection = {
  type: 'FeatureCollection',
  coordRefSys: {
    type: 'Reference',
    href: 'http://www.opengis.net/def/crs/EPSG/0/4258',
    epoch: 2016.47,
  },
  features: [],
};

/**
 * JSON-FG feature collection with a compound (array) coordRefSys.
 * The first component is a Reference with epoch, the second is a plain URI.
 */
const jsonfgCompoundCollection = {
  type: 'FeatureCollection',
  coordRefSys: [
    { type: 'Reference', href: 'http://www.opengis.net/def/crs/EPSG/0/4258', epoch: 2016.47 },
    'http://www.opengis.net/def/crs/EPSG/0/7837',
  ],
  features: [],
};

/**
 * Legacy GeoJSON with the obsolete "crs" property (as produced by many GIS tools,
 * e.g. the EPSG:5514 Czech Krovak sample in demo/epsg5514-example.geojson).
 */
const legacyCrsCollection = {
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::5514' } },
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [-785371.81, -1062509.79] },
    },
  ],
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock proj4 instance.
 *
 * @param registered - when true, `defs(key)` returns a non-empty string (the
 *   projection is already known to the instance); when false it returns undefined.
 */
function makeMockProj4(registered: boolean) {
  const forward = vi.fn((coords: number[]) => coords); // identity transform
  const converter = { forward };
  const instance = vi.fn().mockReturnValue(converter) as any;
  instance.defs = vi.fn().mockReturnValue(registered ? '+proj=longlat +datum=NAD83 +no_defs' : undefined);
  return { instance, converter, forward };
}

// ─── detectCrs ───────────────────────────────────────────────────────────────

describe('detectCrs', () => {
  describe('1. vanilla GeoJSON — CRS code must not be entered', () => {
    it('returns null for a plain FeatureCollection', () => {
      expect(detectCrs(vanillaGeoJSON)).toBeNull();
    });

    it('returns null for a plain Feature', () => {
      expect(detectCrs({ type: 'Feature', geometry: null, properties: {} })).toBeNull();
    });

    it('returns null for null input', () => {
      expect(detectCrs(null)).toBeNull();
    });

    it('returns null for a non-object input', () => {
      expect(detectCrs('GeoJSON string')).toBeNull();
    });
  });

  describe('2. JSON-FG coordRefSys', () => {
    it('detects CRS from a simple URI string', () => {
      expect(detectCrs(jsonfgUriCollection)).toEqual({ epsgCode: 27700 });
    });

    it('detects CRS from a Reference object (returns epoch too)', () => {
      expect(detectCrs(jsonfgReferenceCollection)).toEqual({ epsgCode: 4258, epoch: 2016.47 });
    });

    it('detects CRS from a compound array (picks the first non-WGS84 component)', () => {
      expect(detectCrs(jsonfgCompoundCollection)).toEqual({ epsgCode: 4258, epoch: 2016.47 });
    });

    it('returns null for the WGS84 OGC:CRS84 URI', () => {
      expect(detectCrs({ coordRefSys: 'http://www.opengis.net/def/crs/OGC/0/CRS84' })).toBeNull();
    });

    it('returns null for the WGS84 OGC:CRS84h URI (3D)', () => {
      expect(detectCrs({ coordRefSys: 'http://www.opengis.net/def/crs/OGC/0/CRS84h' })).toBeNull();
    });

    it('returns null for EPSG:4326 (WGS84)', () => {
      expect(detectCrs({ coordRefSys: 'http://www.opengis.net/def/crs/EPSG/0/4326' })).toBeNull();
    });

    it('coordRefSys takes priority over a legacy crs property', () => {
      const data = {
        coordRefSys: 'http://www.opengis.net/def/crs/EPSG/0/27700',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::5514' } },
      };
      expect(detectCrs(data)).toEqual({ epsgCode: 27700 });
    });
  });

  describe('3. legacy GeoJSON crs property', () => {
    it('detects CRS from a legacy urn-format name', () => {
      expect(detectCrs(legacyCrsCollection)).toEqual({ epsgCode: 5514 });
    });

    it('detects CRS from an EPSG: short form name', () => {
      const data = { crs: { type: 'name', properties: { name: 'EPSG:3857' } } };
      expect(detectCrs(data)).toEqual({ epsgCode: 3857 });
    });

    it('returns null when the legacy crs encodes WGS84', () => {
      const data = { crs: { type: 'name', properties: { name: 'EPSG:4326' } } };
      expect(detectCrs(data)).toBeNull();
    });

    it('returns null for a legacy crs with unknown type', () => {
      const data = { crs: { type: 'link', properties: { href: 'http://example.com/crs' } } };
      expect(detectCrs(data)).toBeNull();
    });
  });
});

// ─── getProjectionConverter ───────────────────────────────────────────────────

describe('getProjectionConverter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('2. JSON-FG / legacy — OOTB projection (EPSG:4269)', () => {
    it('does NOT fetch from epsg.io when the projection is already registered in proj4', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      // proj4.defs('EPSG:4269') returns a truthy string → already known
      const { instance, converter } = makeMockProj4(true);

      const result = await getProjectionConverter({ epsgCode: 4269 }, instance);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(instance.defs).toHaveBeenCalledWith('EPSG:4269');
      expect(instance).toHaveBeenCalledWith('EPSG:4269', 'WGS84');
      expect(result).toBe(converter);
    });

    it('logs a console.warn when an epoch is supplied (not supported by proj4js)', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { instance } = makeMockProj4(true);

      await getProjectionConverter({ epsgCode: 4269, epoch: 2017.23 }, instance);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('epoch'));
      warnSpy.mockRestore();
    });
  });

  describe('2 & 3. unknown projection (EPSG:5514) — must request epsg.io', () => {
    const krovakDef =
      '+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 ' +
      '+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +units=m +no_defs';

    beforeEach(() => {
      // Stub fetch to return a valid proj4 definition string
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, text: async () => krovakDef }),
      );
    });

    it('fetches the proj4 definition from https://epsg.io/<code>.proj4', async () => {
      // proj4.defs('EPSG:5514') returns undefined → not registered
      const { instance } = makeMockProj4(false);

      await getProjectionConverter({ epsgCode: 5514 }, instance);

      expect(fetch).toHaveBeenCalledWith('https://epsg.io/5514.proj4');
    });

    it('registers the fetched definition with the proj4 instance', async () => {
      const { instance } = makeMockProj4(false);

      await getProjectionConverter({ epsgCode: 5514 }, instance);

      // Second defs() call should be defs(key, defStr) to register it
      expect(instance.defs).toHaveBeenCalledWith('EPSG:5514', krovakDef);
    });

    it('throws when epsg.io returns an HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      );
      const { instance } = makeMockProj4(false);

      await expect(getProjectionConverter({ epsgCode: 9999 }, instance)).rejects.toThrow(
        /EPSG:9999/,
      );
    });
  });
});

// ─── transformFeatureCollection (integration) ─────────────────────────────────

describe('transformFeatureCollection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transforms all features using the collection-level CRS (EPSG:27700, OOTB)', async () => {
    vi.stubGlobal('fetch', vi.fn());

    // Simulate a converter that shifts x by +1 so we can verify it was applied
    const converter = { forward: vi.fn((coords: number[]) => [coords[0] + 1, coords[1] + 1]) };
    const instance = vi.fn().mockReturnValue(converter) as any;
    instance.defs = vi.fn().mockReturnValue('+proj=tmerc'); // already registered

    const result = await transformFeatureCollection(jsonfgUriCollection, { epsgCode: 27700 }, instance);

    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(1);
    // The geometry coordinates should have been shifted by the mock converter
    expect(result.features[0].geometry.coordinates).toEqual([-1.6930015 + 1, 60.3216821 + 1]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('transforms features when CRS is unknown (EPSG:2180, fetches from epsg.io)', async () => {
    // Use a code not exercised elsewhere in this suite so the module-level
    // proj4DefCache is empty for it and the fetch is guaranteed to fire.
    const polDef = '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +units=m +no_defs';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => polDef });
    vi.stubGlobal('fetch', fetchMock);

    const converter = { forward: vi.fn((_coords: number[]) => [19.0, 52.0]) };
    const instance = vi.fn().mockReturnValue(converter) as any;
    instance.defs = vi.fn().mockReturnValue(undefined); // not registered

    const collection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [500000, -5300000] },
        },
      ],
    };

    const result = await transformFeatureCollection(collection, { epsgCode: 2180 }, instance);

    expect(fetchMock).toHaveBeenCalledWith('https://epsg.io/2180.proj4');
    expect(result.features[0].geometry.coordinates).toEqual([19.0, 52.0]);
  });
});