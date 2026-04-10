import {createPropertiesTable, augment, AugmentOptions} from './augment';
import {loadContext, type Context, type ContextObject} from './jsonld';
import {detectCrs, transformFeatureCollection} from './crs';
import proj4Lib from 'proj4';

export interface JsonLDGeoJSONOptions {
  ldContext?: Context | ContextObject;
  popupOptions?: Record<string, any>;
  augmentOptions?: Partial<AugmentOptions>;
  onEachFeature?: (feature: any, layer: any) => void;
  /** Override the auto-detected CRS with an explicit URI (e.g. "EPSG:5514"). */
  coordRefSys?: string;
  /** Inject a proj4 instance. Useful in environments where window.proj4 is not available. */
  proj4?: any;
  [key: string]: any;
}

export async function createJsonLDGeoJSONLayer(L: any, data: any, options: JsonLDGeoJSONOptions = {}): Promise<any> {
  const {
    ldContext,
    popupOptions = {maxWidth: 400},
    augmentOptions = {},
    onEachFeature: userOnEachFeature,
    coordRefSys: coordRefSysOverride,
    proj4: proj4Override,
    ...geoJSONOptions
  } = options;

  let geoData = data;
  const crsInfo = coordRefSysOverride
    ? detectCrs({coordRefSys: coordRefSysOverride})
    : detectCrs(data);

  if (crsInfo !== null) {
    const proj4Instance = proj4Override ?? proj4Lib;
    if (!proj4Instance) {
      throw new Error(
        'proj4js is required for CRS transformation — include it via <script src="..."> or install it as a dependency'
      );
    }
    geoData = await transformFeatureCollection(data, crsInfo, proj4Instance);
  }

  return L.geoJSON(geoData, {
    ...geoJSONOptions,
    onEachFeature(feature: any, layer: any) {
      if (userOnEachFeature) userOnEachFeature(feature, layer);

      if (feature.id != null) {
        layer.bindTooltip(String(feature.id), {permanent: false});
      }

      if (!feature.properties || Object.keys(feature.properties).length === 0) return;

      const container = document.createElement('div');
      createPropertiesTable(feature, container);
      layer.bindPopup(container, popupOptions);

      if (ldContext) {
        loadContext(ldContext).then((resolvedContext: any) => {
          augment(container, resolvedContext, augmentOptions);
        });
      }
    },
  });
}
