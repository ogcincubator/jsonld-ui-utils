import {createPropertiesTable, augment, AugmentOptions} from './augment';
import {loadContext, type Context, type ContextObject} from './jsonld';

export interface JsonLDGeoJSONOptions {
  ldContext?: Context | ContextObject;
  popupOptions?: Record<string, any>;
  augmentOptions?: Partial<AugmentOptions>;
  onEachFeature?: (feature: any, layer: any) => void;
  [key: string]: any;
}

export function createJsonLDGeoJSONLayer(L: any, data: any, options: JsonLDGeoJSONOptions = {}) {
  const {
    ldContext,
    popupOptions = {maxWidth: 400},
    augmentOptions = {},
    onEachFeature: userOnEachFeature,
    ...geoJSONOptions
  } = options;

  return L.geoJSON(data, {
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