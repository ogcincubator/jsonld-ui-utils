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
  /**
   * When true (default), adds a Leaflet layer attribution showing the original CRS
   * whenever coordinates are transformed from a non-WGS84 CRS.
   */
  crsAttribution?: boolean;
  [key: string]: any;
}

const POPUP_CLASS = 'jsonld-ui-popup';

// Leaflet sets inline width/max-width/max-height on the popup content element, hence !important
// so that the user-resized inline size wins over those caps.
const POPUP_CSS = `
.${POPUP_CLASS} .leaflet-popup-content {
  overflow: auto;
  resize: both;
  box-sizing: border-box;
  min-width: 150px;
  min-height: 60px;
  max-width: var(--jsonld-popup-max-width, 90vw) !important;
  max-height: var(--jsonld-popup-max-height, 80vh) !important;
}
/* Let the popup content be the single scroll container (otherwise the table's own
   horizontal scrollbar ends up at the very bottom of a tall popup). */
.${POPUP_CLASS} .object-properties {
  overflow: visible;
  width: max-content;
  min-width: 100%;
}
`;

let popupCssInjected = false;

function injectPopupCss() {
  if (popupCssInjected || typeof document === 'undefined') {
    return;
  }
  popupCssInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-jsonld-ui-utils', 'popup');
  style.textContent = POPUP_CSS;
  document.head.appendChild(style);
}

// Keeps the popup centered over its anchor (and its tip aligned) when the user drags the resize
// handle: Leaflet only computes the container offset when the popup is (re)laid out.
// Uses private Leaflet 1.x fields, hence the defensive guards.
function recenterOnResize(popup: any) {
  if (typeof ResizeObserver === 'undefined') {
    return;
  }
  let observer: ResizeObserver | null = null;
  popup.on('add', () => {
    const content = popup._contentNode as HTMLElement | undefined;
    if (!content) {
      return;
    }
    // A drag that starts inside the popup (resize handle, text selection) but is released outside
    // makes the browser dispatch a `click` on the map, which would close the popup. Swallow it.
    content.addEventListener('mousedown', () => {
      const swallowClick = (e: Event) => {
        if (!popup._container?.contains(e.target as Node)) {
          e.stopPropagation();
        }
      };
      document.addEventListener('click', swallowClick, true);
      document.addEventListener('mouseup', () => {
        setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
      }, {once: true, capture: true});
    });
    // Cap the popup to the map's own size (e.g. a small inline map): at most 60% of its width and 70% of its height, and
    // never more than what is left after the popup chrome, tip and marker offset.
    const map = popup._map;
    const updateMaxSize = () => {
      const size = map?.getSize?.();
      if (size && popup._container) {
        popup._container.style.setProperty('--jsonld-popup-max-width', `${Math.max(150, Math.min(size.x * 0.6, size.x - 60))}px`);
        popup._container.style.setProperty('--jsonld-popup-max-height', `${Math.max(100, Math.min(size.y * 0.7, size.y - 110))}px`);
      }
    };
    updateMaxSize();
    // Leaflet already measured the popup (and autopanned) before the caps existed: lay it out again.
    popup.update();
    map?.on('resize', updateMaxSize);
    popup.once('remove', () => map?.off('resize', updateMaxSize));
    observer = new ResizeObserver(() => {
      if (popup._container && typeof popup._updatePosition === 'function') {
        popup._containerWidth = popup._container.offsetWidth;
        popup._updatePosition();
      }
    });
    observer.observe(content);
  });
  popup.on('remove', () => {
    observer?.disconnect();
    observer = null;
  });
}

export async function createJsonLDGeoJSONLayer(L: any, data: any, options: JsonLDGeoJSONOptions = {}): Promise<any> {
  const {
    ldContext,
    popupOptions = {maxWidth: 400},
    augmentOptions = {},
    onEachFeature: userOnEachFeature,
    coordRefSys: coordRefSysOverride,
    proj4: proj4Override,
    crsAttribution = true,
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

  const crsAttributionText =
    crsAttribution && crsInfo !== null
      ? `Original CRS: EPSG:${crsInfo.epsgCode}`
      : null;

  const mergedAttribution = [geoJSONOptions.attribution, crsAttributionText]
    .filter(Boolean)
    .join(' | ') || undefined;

  return L.geoJSON(geoData, {
    ...geoJSONOptions,
    ...(mergedAttribution !== undefined ? {attribution: mergedAttribution} : {}),
    onEachFeature(feature: any, layer: any) {
      if (userOnEachFeature) userOnEachFeature(feature, layer);

      if (feature.id != null) {
        layer.bindTooltip(String(feature.id), {permanent: false});
      }

      if (!feature.properties || Object.keys(feature.properties).length === 0) return;

      const container = document.createElement('div');
      createPropertiesTable(feature, container);
      injectPopupCss();
      const className = [POPUP_CLASS, popupOptions.className].filter(Boolean).join(' ');
      layer.bindPopup(container, {...popupOptions, className});
      recenterOnResize(layer.getPopup());

      const dataContext = data != null && typeof data === 'object' && '@context' in data
        ? (data as any)['@context']
        : null;
      const contextsToMerge = [dataContext, ldContext].filter(v => v != null);
      if (contextsToMerge.length > 0) {
        const contextArg = contextsToMerge.length === 1 ? contextsToMerge[0] : contextsToMerge;
        loadContext(contextArg).then((resolvedContext: any) => {
          augment(container, resolvedContext, augmentOptions);
        });
      }
    },
  });
}
