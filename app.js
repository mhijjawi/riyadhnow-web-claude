// ================================
// Toast Notification System
// ================================
function showToast(message, type = "info", duration = 4000) {
  try {
    const container = document.getElementById("toastContainer");
    if (!container) {
      console.error("[Toast] Container not found");
      return;
    }

    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "polite");

    container.appendChild(toast);

    // Auto-dismiss after duration
    const dismissTimeout = setTimeout(() => {
      dismissToast(toast);
    }, duration);

    // Allow click to dismiss
    toast.addEventListener("click", () => {
      clearTimeout(dismissTimeout);
      dismissToast(toast);
    });

    return toast;
  } catch (error) {
    console.error("[Toast] Failed to show toast:", error);
    // Fallback to alert if toast system fails
    if (typeof alert === "function") alert(message);
  }
}

function dismissToast(toast) {
  try {
    toast.classList.add("hiding");
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300); // Match animation duration
  } catch (error) {
    console.error("[Toast] Failed to dismiss toast:", error);
  }
}

// Performance hint: avoid Chrome Canvas2D getImageData warning (leaflet-heat)
// Safe monkey-patch: request willReadFrequently for 2D contexts.
(() => {
  try {
    const _orig = HTMLCanvasElement.prototype.getContext;
    if (!_orig) return;
    HTMLCanvasElement.prototype.getContext = function (type, opts) {
      if (type === "2d") {
        const o = (opts && typeof opts === "object") ? opts : {};
        if (!("willReadFrequently" in o)) o.willReadFrequently = true;
        return _orig.call(this, type, o);
      }
      return _orig.call(this, type, opts);
    };
  } catch (_e) { }
})();

// Responsive helper
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

// ================================
// Input Validation for API Responses
// ================================
function validatePlaceData(p) {
  if (!p || typeof p !== 'object') {
    return { valid: false, reason: "not_an_object" };
  }

  // Must have a valid ID
  if (!p.place_id && !p.id && !p.gid) {
    return { valid: false, reason: "missing_id" };
  }

  // Must have valid coordinates
  const lat = Number(p.lat ?? p.latitude);
  const lng = Number(p.lng ?? p.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { valid: false, reason: "invalid_coordinates" };
  }

  // Coordinates must be in reasonable range
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { valid: false, reason: "coordinates_out_of_range" };
  }

  // Should have a name (warn but don't reject)
  if (!p.name || typeof p.name !== 'string' || p.name.trim().length === 0) {
    console.warn("[Validation] Place missing name:", p.place_id || p.id);
  }

  return { valid: true };
}

function validateAPIResponse(payload, source = "unknown") {
  try {
    // Check if payload exists
    if (!payload || typeof payload !== 'object') {
      console.error(`[Validation] Invalid ${source} response: not an object`);
      return { valid: false, error: "Invalid response format" };
    }

    // Check if results array exists
    if (!Array.isArray(payload.results)) {
      console.error(`[Validation] Invalid ${source} response: missing results array`);
      return { valid: false, error: "Missing results array" };
    }

    // Check if results is empty
    if (payload.results.length === 0) {
      console.warn(`[Validation] ${source} response has no results`);
      return { valid: true, results: [] };
    }

    // Validate each place and filter out invalid ones
    const validResults = [];
    const invalidCount = { total: 0, reasons: {} };

    for (const place of payload.results) {
      const validation = validatePlaceData(place);
      if (validation.valid) {
        validResults.push(place);
      } else {
        invalidCount.total++;
        invalidCount.reasons[validation.reason] = (invalidCount.reasons[validation.reason] || 0) + 1;
      }
    }

    if (invalidCount.total > 0) {
      console.warn(`[Validation] Filtered out ${invalidCount.total} invalid places from ${source}:`, invalidCount.reasons);
    }

    return { valid: true, results: validResults, filtered: invalidCount.total };
  } catch (error) {
    console.error(`[Validation] Error validating ${source} response:`, error);
    return { valid: false, error: error.message };
  }
}

// ================================
// API Retry Logic with Exponential Backoff
// ================================
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // If successful, return immediately
      if (response.ok) {
        return response;
      }

      // If rate limited (429), wait and retry
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000;
        console.warn(`[API] Rate limited (429). Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // If server error (5xx), retry with exponential backoff
      if (response.status >= 500 && response.status < 600) {
        if (attempt < maxRetries - 1) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.warn(`[API] Server error (${response.status}). Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
      }

      // For other errors (4xx except 429), don't retry
      return response;

    } catch (error) {
      lastError = error;

      // Network errors - retry with exponential backoff
      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(`[API] Network error. Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries})`, error);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
    }
  }

  // If all retries failed, throw the last error
  if (lastError) {
    throw lastError;
  }

  // This shouldn't happen, but just in case
  throw new Error("Failed to fetch after maximum retries");
}

// ================================
// GA4 events helper (production-safe; no-op if blocked)
// ================================
function gaEvent(name, params = {}) {
  try {
    if (typeof window === "undefined") return;
    const g = window.gtag;
    if (typeof g !== "function") return;
    g("event", name, params || {});
  } catch (_e) {
    // no-op
  }
}

// Avoid sending raw search text (privacy-safe)
function gaSearchMeta(q) {
  const s = (q || "").toString().trim();
  const hasArabic = /[\u0600-\u06FF]/.test(s);
  return {
    q_len: s.length,
    q_words: s ? s.split(/\s+/).filter(Boolean).length : 0,
    q_has_ar: hasArabic ? 1 : 0
  };
}

// Debounced filter-change tracking (prevents event spam)
let __gaFilterT = null;
let __gaLastSig = "";
function gaTrackFiltersDebounced(reason) {
  try {
    clearTimeout(__gaFilterT);
    __gaFilterT = setTimeout(() => {
      // Build a stable signature so we don't emit duplicates
      const cats = state.categories ? [...state.categories].sort().join(",") : "all";
      const tagsCount = state.tags ? state.tags.size : 0;
      const sig = [
        state.district || "all",
        state.insight || "all",
        cats,
        state.sentiment || "الكل",
        state.price || "الكل",
        tagsCount,
        (state.q || "").trim(),
        state.heatmap || "Off",
        state.similarMode ? 1 : 0
      ].join("|");
      if (sig === __gaLastSig) return;
      __gaLastSig = sig;

      gaEvent("filters_change", {
        reason: reason || "unknown",
        district: state.district || "all",
        insight_mode: state.insight || "all",
        categories: cats,
        sentiment: state.sentiment || "الكل",
        price_bucket: state.price || "الكل",
        tags_count: tagsCount,
        heatmap: state.heatmap || "Off",
        similar_mode: state.similarMode ? 1 : 0,
        ...gaSearchMeta(state.q || "")
      });
    }, 450);
  } catch (_e) { }
}

// slug -> Arabic label (from API field district_slug_ar)
let DISTRICT_LABEL_AR_BY_SLUG = new Map();

// NEW: District label helper (UI-only)
function districtLabelArFromSlug(slug) {
  const s = String(slug || "");
  const fromDb = DISTRICT_LABEL_AR_BY_SLUG && DISTRICT_LABEL_AR_BY_SLUG.get(s);
  if (fromDb) return fromDb;

  // Fallback mapping (in case some rows are missing district_slug_ar)
  switch (s) {
    case "Olaya": return "العليا";
    case "Malqa": return "الملقا";
    case "Nakheel": return "النخيل";
    case "Yasmin": return "الياسمين";
    case "Sulaymaniyah": return "السليمانية";
    case "Rabwah": return "الربوة";
    case "Wurod": return "الورود";
    default: return s;
  }
}

// ================================
// Config: Production endpoints + caching
// ================================
const PLACES_API_URL = "https://places-830507251115.europe-west1.run.app";
const SIMILAR_API_URL = "https://get-similar-places-830507251115.europe-west1.run.app";

const PLACES_CACHE_NAME = "rn_places_cache_v1";
const PLACES_CACHE_META_KEY = "rn_places_cache_meta_v1";
const PLACES_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function readPlacesCacheMeta() {
  try {
    const raw = localStorage.getItem(PLACES_CACHE_META_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    return j;
  } catch (_e) { return null; }
}
function writePlacesCacheMeta(meta) {
  try { localStorage.setItem(PLACES_CACHE_META_KEY, JSON.stringify(meta || {})); } catch (_e) { }
}

async function fetchPlacesCached(requestUrl) {
  const meta = readPlacesCacheMeta();
  const now = Date.now();
  const isFresh = !!(meta && meta.url === requestUrl && meta.ts && (now - meta.ts) < PLACES_CACHE_MAX_AGE_MS);

  try {
    if ("caches" in window) {
      const cache = await caches.open(PLACES_CACHE_NAME);
      const cachedResp = await cache.match(requestUrl);
      if (cachedResp) {
        if (!isFresh) {
          // Background refresh with retry logic
          (async () => {
            try {
              const net = await fetchWithRetry(requestUrl, { cache: "no-store" }, 3);
              if (net.ok) {
                await cache.put(requestUrl, net.clone());
                writePlacesCacheMeta({ url: requestUrl, ts: Date.now() });
              }
            } catch (error) {
              console.error("[Cache] Background refresh failed:", error);
            }
          })();
        }
        const payload = await cachedResp.json();
        return { payload, source: isFresh ? "cache_fresh" : "cache_stale" };
      }
      // No cache hit - fetch with retry
      const net = await fetchWithRetry(requestUrl, { cache: "no-store" }, 3);
      if (net.ok) {
        await cache.put(requestUrl, net.clone());
        writePlacesCacheMeta({ url: requestUrl, ts: Date.now() });
      }
      const payload = await net.json();
      return { payload, source: "network" };
    }
  } catch (error) {
    console.error("[Cache] Cache operation failed, falling back to direct fetch:", error);
  }

  // Fallback to direct fetch with retry
  const net = await fetchWithRetry(requestUrl, { cache: "no-store" }, 3);
  const payload = await net.json();
  return { payload, source: "network_nocache" };
}

// ================================
// Leaflet map globals
// ================================
let MAP = null;
let MARKERS_LAYER = null;
let MARKERS_BY_ID = new Map();
let DID_FIT_BOUNDS = false;
let DID_INVALIDATE_ON_FIRST_RENDER = false;

let HEAT_LAYER = null;

let SELECTED_ID = null;
let selectedDistrictLayer = null;

let DISTRICT_GEOJSON_MAP = null;

// ================================
// Data + UI state
// ================================
let DATA = [];

let TOGGLE_CONFIG = null;
let INSIGHTS = [
  { key: "all", label: "الكل", emoji: "✨", predicate: (_) => true, sort: "desc:bayes2_score", heatFn: null },
];

let CATEGORIES = [{ key: "all", label: "الكل", emoji: "✨" }];

const SENTIMENTS = ["الكل", "إيجابي", "محايد", "سلبي"];
const PRICES = ["الكل", "$", "$$", "$$$"];

let TAGS = [];
let TAG_COUNTS = new Map();
let TAGS_DRAFT = null;

const state = {
  similarMode: false,
  similarAnchor: null,
  similarResults: [],
  q: "",
  district: "all",
  insight: "must_go",
  categories: new Set(["all"]),
  sentiment: "الكل",
  price: "الكل",
  tags: new Set(),
  tagsQuery: "",
  heatmap: "Off",
};

const el = (id) => document.getElementById(id);

// ================================
// Utilities
// ================================
function debounce(fn, wait = 120) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}
function escapeHtml(s) { return escHtml(s); }
function cssEscape(v) { return String(v).replace(/"/g, '\\"'); }

function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // diacritics + tatweel
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ================================
// District GeoJSON
// ================================
async function loadDistrictGeojsonMap() {
  if (DISTRICT_GEOJSON_MAP) return DISTRICT_GEOJSON_MAP;
  try {
    const res = await fetch("./district_geojson_map.json", { cache: "force-cache" });
    if (!res.ok) throw new Error("district_geojson_map fetch failed");
    DISTRICT_GEOJSON_MAP = await res.json();
  } catch (e) {
    console.warn("Failed to load district_geojson_map.json", e);
    DISTRICT_GEOJSON_MAP = {};
  }
  return DISTRICT_GEOJSON_MAP;
}

// Backwards compatible alias (some earlier stages referenced this name)
async function loadDistrictGeoJSON() {
  return loadDistrictGeojsonMap();
}

function computeGeojsonBounds(fc) {
  try {
    const coords = [];
    const pushCoords = (arr) => {
      if (!Array.isArray(arr)) return;
      if (typeof arr[0] === "number" && typeof arr[1] === "number") {
        coords.push([arr[1], arr[0]]); // [lat,lng]
      } else {
        for (const x of arr) pushCoords(x);
      }
    };
    if (fc && fc.features) {
      for (const f of fc.features) {
        if (f && f.geometry && f.geometry.coordinates) pushCoords(f.geometry.coordinates);
      }
    }
    if (!coords.length) return null;
    return L.latLngBounds(coords);
  } catch (_e) { return null; }
}

function clearDistrictBoundary() {
  if (!MAP) return;
  if (selectedDistrictLayer) {
    try { MAP.removeLayer(selectedDistrictLayer); } catch (_e) { }
    selectedDistrictLayer = null;
  }
}

function showSelectedDistrictBoundary(districtName) {
  if (!MAP) return;
  clearDistrictBoundary();
  if (!districtName || districtName === "all") return;

  const gj = (DISTRICT_GEOJSON_MAP && DISTRICT_GEOJSON_MAP[districtName]) ? DISTRICT_GEOJSON_MAP[districtName] : null;
  if (!gj) return;

  selectedDistrictLayer = L.geoJSON(gj, {
    interactive: false,
    style: () => ({
      color: "#0ea5e9",
      weight: 2,
      opacity: 0.95,
      fillOpacity: 0.04
    })
  }).addTo(MAP);

  try { selectedDistrictLayer.bringToFront(); } catch (_e) { }
}

async function focusDistrict(key) {
  if (!MAP) return;
  if (!key) return;

  let b = null;

  // Handle "all" case - fit all visible markers
  if (key === "all") {
    const bounds = [];
    MARKERS_BY_ID.forEach((marker) => {
      const latLng = marker.getLatLng();
      if (latLng) {
        bounds.push([latLng.lat, latLng.lng]);
      }
    });
    if (bounds.length >= 2) {
      b = L.latLngBounds(bounds);
    }
  } else {
    // Handle specific district
    const m = await loadDistrictGeojsonMap();
    const fc = m[key];
    if (!fc) return;
    b = computeGeojsonBounds(fc);
  }

  if (!b) return;

  // Calculate dynamic padding based on UI elements
  let topPadding = 30;
  let bottomPadding = 30;
  let leftPadding = 30;
  let rightPadding = 30;

  try {
    const isDesktop = window.matchMedia("(min-width: 980px)").matches;

    // Account for topbar (search box + filters)
    const topbar = document.querySelector(".topbar");
    if (topbar) {
      const topbarHeight = topbar.getBoundingClientRect().height || 0;
      topPadding = Math.max(topPadding, topbarHeight + 80); // 80px extra for spacing above topbar
    }

    // Account for bottom panel on mobile
    if (!isDesktop) {
      const panel = document.getElementById("panel");
      if (panel) {
        const panelHeight = panel.getBoundingClientRect().height || 0;
        bottomPadding = Math.max(bottomPadding, panelHeight + 20);
      }
    }
  } catch (_e) { }

  try {
    MAP.fitBounds(b, {
      paddingTopLeft: [leftPadding, topPadding],
      paddingBottomRight: [rightPadding, bottomPadding],
      animate: true
    });
  } catch (_e) { }
}

// Find which district contains a given lat/lng point
async function findDistrictForLocation(lat, lng) {
  if (!lat || !lng) return null;

  const m = await loadDistrictGeojsonMap();
  if (!m) return null;

  const point = L.latLng(lat, lng);

  // Check each district to see if the point is inside
  for (const [districtKey, featureCollection] of Object.entries(m)) {
    if (!featureCollection || !featureCollection.features) continue;

    // Create a temporary layer to check if point is inside
    try {
      const layer = L.geoJSON(featureCollection);
      let isInside = false;

      layer.eachLayer((l) => {
        if (l.getBounds && l.getBounds().contains(point)) {
          // More precise check using polygon contains
          if (l.feature && l.feature.geometry && l.feature.geometry.coordinates) {
            const poly = l.feature.geometry.coordinates;
            if (pointInPolygon([lng, lat], poly)) {
              isInside = true;
            }
          }
        }
      });

      if (isInside) {
        return districtKey;
      }
    } catch (e) {
      console.warn(`[District] Error checking district ${districtKey}:`, e);
    }
  }

  return null;
}

// Point-in-polygon algorithm for GeoJSON coordinates
function pointInPolygon(point, polygon) {
  const x = point[0];
  const y = point[1];

  // Handle both Polygon and MultiPolygon
  let rings = polygon;
  if (polygon[0] && Array.isArray(polygon[0][0]) && Array.isArray(polygon[0][0][0])) {
    // MultiPolygon - check all polygons
    for (const poly of polygon) {
      if (pointInPolygon(point, poly)) return true;
    }
    return false;
  }

  // Single Polygon - check outer ring (first ring)
  const ring = rings[0];
  if (!ring || !Array.isArray(ring)) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }

  return inside;
}

// ================================
// Leaflet map init + tiles
// ================================
function initLeafletMap() {
  if (MAP) return MAP;

  const DEFAULT_CENTER = [24.7136, 46.6753];
  const DEFAULT_ZOOM = 12;

  MAP = L.map("map", { zoomControl: false }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  });
  const carto = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap © CARTO",
    subdomains: "abcd",
  });

  let usingFallback = false;
  const switchToFallback = () => {
    if (usingFallback) return;
    usingFallback = true;
    try { MAP.removeLayer(osm); } catch (_e) { }
    try { carto.addTo(MAP); } catch (_e) { }
  };

  let tileErrors = 0;
  osm.on("tileerror", () => {
    tileErrors++;
    if (tileErrors >= 2) switchToFallback();
  });
  osm.addTo(MAP);

  MARKERS_LAYER = L.layerGroup().addTo(MAP);

  return MAP;
}
// ================================
// Locate me (geolocation)
// ================================
let USER_LOC_MARKER = null;
let USER_LOC_CIRCLE = null;

// Shared geolocation trigger function
function triggerGeolocation(options = {}) {
  const { isAuto = false, setBusy = null, showError = null } = options;

  if (!navigator.geolocation) {
    if (!isAuto && showError) {
      showError("Geolocation is not supported on this device.");
    }
    return;
  }

  const map = initLeafletMap();
  if (!map) return;

  if (setBusy) setBusy(true);

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      if (setBusy) setBusy(false);
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = Math.max(10, pos.coords.accuracy || 50);

      if (USER_LOC_MARKER) {
        USER_LOC_MARKER.setLatLng([lat, lng]);
      } else {
        USER_LOC_MARKER = L.circleMarker([lat, lng], {
          radius: 7,
          weight: 2,
          fillOpacity: 0.9,
        }).addTo(map);
      }

      if (USER_LOC_CIRCLE) {
        USER_LOC_CIRCLE.setLatLng([lat, lng]);
        USER_LOC_CIRCLE.setRadius(acc);
      } else {
        USER_LOC_CIRCLE = L.circle([lat, lng], {
          radius: acc,
          weight: 1,
          fillOpacity: 0.10,
        }).addTo(map);
      }

      // Find and auto-select district if location is within one
      try {
        const foundDistrict = await findDistrictForLocation(lat, lng);
        if (foundDistrict) {
          // Auto-select the district
          state.district = foundDistrict;
          const districtEl = el("district");
          if (districtEl) districtEl.value = foundDistrict;

          // Show district boundary
          showSelectedDistrictBoundary(foundDistrict);

          // Render with new district filter
          render();

          // Zoom out to show places in the district
          await focusDistrict(foundDistrict);

          gaEvent("locate_me", { ok: true, accuracy_m: Math.round(acc), district: foundDistrict, auto: isAuto });
        } else {
          // Location not in any district, just zoom to location
          const targetZoom = Math.max(map.getZoom(), 14);
          map.setView([lat, lng], targetZoom, { animate: true });

          gaEvent("locate_me", { ok: true, accuracy_m: Math.round(acc), district: "none", auto: isAuto });
        }
      } catch (err) {
        console.warn("[Geolocation] District detection failed:", err);
        // Fallback: just zoom to location
        const targetZoom = Math.max(map.getZoom(), 14);
        map.setView([lat, lng], targetZoom, { animate: true });

        gaEvent("locate_me", { ok: true, accuracy_m: Math.round(acc), auto: isAuto });
      }
    },
    (err) => {
      if (setBusy) setBusy(false);
      gaEvent("locate_me", { ok: false, code: err && err.code, message: err && err.message, auto: isAuto });

      // Only show error toast if not auto-detect
      if (!isAuto && showError) {
        const msg =
          (err && err.code === 1) ? "تم رفض مشاركة الموقع." :
          (err && err.code === 2) ? "تعذر تحديد موقعك حالياً." :
          (err && err.code === 3) ? "انتهت مهلة تحديد الموقع." :
          "تعذر الحصول على موقعك.";
        showError(msg);
      } else if (isAuto) {
        // Silent fail for auto-detect - user didn't explicitly request it
        console.log("[Geolocation] Auto-detect failed silently:", err && err.code);
      }
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

// Auto-detect location on startup
function autoDetectLocation() {
  triggerGeolocation({ isAuto: true });
}

function initLocateMe() {
  const btn = el("locateBtn");
  if (!btn) return;

  const setBusy = (busy) => {
    btn.disabled = !!busy;
    btn.classList.toggle("is-busy", !!busy);
  };

  const showError = (msg) => {
    try { showToast(msg, "error", 5000); } catch (_e) { }
  };

  const onLocate = (ev) => {
    ev && ev.preventDefault && ev.preventDefault();
    ev && ev.stopPropagation && ev.stopPropagation();

    triggerGeolocation({ isAuto: false, setBusy, showError });
  };

  // iOS Safari sometimes prefers touchend over click
  btn.addEventListener("click", onLocate, { passive: false });
  btn.addEventListener("touchend", onLocate, { passive: false });
}


function clearMarkers() {
  if (!MARKERS_LAYER) return;
  MARKERS_LAYER.clearLayers();
  MARKERS_BY_ID = new Map();
}

// ================================
// Insights config (toggle_config.json)
// ================================
// SECURITY: Safe predicate evaluator - NO eval() or new Function()
// This evaluates simple predicates from config without code execution risks
function compilePredicate(codeStr) {
  try {
    const code = String(codeStr || "").trim();
    if (!code || code === "return true;") return (_) => true;

    // Safe evaluation: parse the predicate pattern and create a function
    // IMPORTANT: Check more specific patterns FIRST before generic ones

    // Pattern 1: discover style - rating range && review count range && sentiment check (MOST SPECIFIC)
    const discoverMatch = code.match(/r\s*>=\s*([\d.]+)\s*&&\s*v\s*>=\s*(\d+)\s*&&\s*v\s*<=\s*(\d+)\s*&&\s*s\s*!==\s*['"]([^'"]+)['"]/);
    if (discoverMatch) {
      const minRating = parseFloat(discoverMatch[1]);
      const minReviews = parseInt(discoverMatch[2], 10);
      const maxReviews = parseInt(discoverMatch[3], 10);
      const excludeSentiment = discoverMatch[4];
      return (p) => {
        const r = p.rating ?? 0;
        const v = p.rating_count ?? 0;
        const s = p.sentiment_label_ar || '';
        return r >= minRating && v >= minReviews && v <= maxReviews && s !== excludeSentiment;
      };
    }

    // Pattern 2: must_go style - bayes2_score >= X && rating_count >= Y && sentiment check
    const mustGoMatch = code.match(/b2\s*>=\s*([\d.]+)\s*&&\s*v\s*>=\s*(\d+)\s*&&\s*s\s*!==\s*['"]([^'"]+)['"]/);
    if (mustGoMatch) {
      const minBayes = parseFloat(mustGoMatch[1]);
      const minReviews = parseInt(mustGoMatch[2], 10);
      const excludeSentiment = mustGoMatch[3];
      return (p) => {
        const b2 = p.bayes2_score ?? 0.50;
        const v = p.rating_count ?? 0;
        const s = p.sentiment_label_ar || '';
        return b2 >= minBayes && v >= minReviews && s !== excludeSentiment;
      };
    }

    // Pattern 3: top_rated style - rating >= X && rating_count >= Y (check AFTER discover)
    const topRatedMatch = code.match(/r\s*>=\s*([\d.]+)\s*&&\s*v\s*>=\s*(\d+)/);
    if (topRatedMatch) {
      const minRating = parseFloat(topRatedMatch[1]);
      const minReviews = parseInt(topRatedMatch[2], 10);
      return (p) => {
        const r = p.rating ?? 0;
        const v = p.rating_count ?? 0;
        return r >= minRating && v >= minReviews;
      };
    }

    // Pattern 4: raqi style - text search in fields
    const raqiMatch = code.match(/const q\s*=\s*['"]([^'"]+)['"]/);
    if (raqiMatch) {
      const searchTerm = raqiMatch[1].toLowerCase();
      return (p) => {
        const haystack = `${p.name} ${(p.tags||[]).join(' ')} ${p.category} ${p.district}`.toLowerCase();
        return haystack.includes(searchTerm);
      };
    }

    console.warn("[Security] Unknown predicate pattern - using safe default (allow all):", code.substring(0, 100));
    return (_) => true;
  } catch (e) {
    console.error("[Security] Predicate compilation error:", e);
    return (_) => true;
  }
}

function compileHeat(codeStr) {
  try {
    const code = String(codeStr || "").trim();
    if (!code) return (_) => 0;

    // Safe heat evaluation - only allow accessing known numeric fields
    // Pattern: "return (p.field_name ?? default);"
    const fieldMatch = code.match(/return\s*\(\s*p\.(\w+)\s*\?\?\s*([\d.]+)\s*\)\s*;?/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      const defaultValue = parseFloat(fieldMatch[2]) || 0;

      // Whitelist of allowed numeric fields
      const allowedFields = ['bayes2_score', 'rating', 'rating_count', 'trust_score'];
      if (!allowedFields.includes(fieldName)) {
        console.warn("[Security] Unsafe heat field access attempt:", fieldName);
        return (_) => 0;
      }

      return (p) => {
        const v = p[fieldName] ?? defaultValue;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
    }

    console.warn("[Security] Unknown heat pattern - using safe default (0):", code.substring(0, 100));
    return (_) => 0;
  } catch (e) {
    console.error("[Security] Heat compilation error:", e);
    return (_) => 0;
  }
}

async function loadToggleConfig() {
  if (TOGGLE_CONFIG) return TOGGLE_CONFIG;
  try {
    const res = await fetch("./toggle_config.json", { cache: "force-cache" });
    if (!res.ok) throw new Error("toggle_config fetch failed");
    TOGGLE_CONFIG = await res.json();
    return TOGGLE_CONFIG;
  } catch (e) {
    console.warn("toggle_config.json not available, using fallback insights.", e);
    TOGGLE_CONFIG = null;
    return null;
  }
}

function rebuildInsightsFromToggleConfig(cfg) {
  const base = [{ key: "all", label: "الكل", emoji: "✨", predicate: (_) => true, sort: "desc:bayes2_score", heatFn: null }];

  if (!cfg) { INSIGHTS = base; return; }

  const order = ["must_go", "trust_rank", "top_rated", "old_is_gold", "search_match"];
  const keys = order.filter(k => cfg[k]).concat(Object.keys(cfg).filter(k => !order.includes(k)));

  const mapped = keys.map((k) => {
    const it = cfg[k] || {};
    const labelRaw = String(it.label_ar || k);
    const m = labelRaw.match(/^([\p{Extended_Pictographic}\u2600-\u27BF]+)\s+(.*)$/u);
    const emoji = m ? m[1] : (k === "must_go" ? "🔥" : k === "trust_rank" ? "🎯" : "✨");
    const label = m ? m[2] : labelRaw;

    return {
      key: k,
      label,
      emoji,
      micro: it.micro_ar || "",
      desc: it.desc_ar || "",
      predicate: compilePredicate(it.predicate || "return true;"),
      sort: String(it.sort || "desc:bayes2_score"),
      heatFn: it.heat ? compileHeat(it.heat) : null,
    };
  });

  INSIGHTS = base.concat(mapped);
}

// ================================
// Popup + Similar
// ================================
function popupHtml(p) {
  const name = escHtml(p.name || "");
  const rating = (p.rating != null) ? Number(p.rating).toFixed(1) : "";
  const rc = (p.rating_count != null) ? String(p.rating_count) : "";
  const price = p.price_bucket_ar ? `السعر: ${escHtml(p.price_bucket_ar)}` : "";
  const sent = p.sentiment_label_ar ? `الانطباع: ${escHtml(p.sentiment_label_ar)}` : "";
  const meta = [price, sent].filter(Boolean).join(" • ");
  const g = p.link ? `<a href="${escHtml(p.link)}" target="_blank" rel="noopener noreferrer" style="font-weight:900;text-decoration:none;">Google Maps</a>` : "";
  // SECURITY FIX: Use data attribute instead of inline onclick handler
  const btn = `<button class="rnPopBtn" data-place-id="${escHtml(String(p.id))}" data-action="find-similar">🔎 مشابه</button>`;
  return `
    <div style="direction:rtl;text-align:right;max-width:260px;font-family:inherit;">
      <div style="font-weight:900;font-size:14px;line-height:1.25;">${name}</div>
      ${p.summary ? `<div style="opacity:.86;margin-top:6px;font-size:12px;line-height:1.35;">${escHtml(p.summary)}</div>` : ``}
      <div style="margin-top:8px;opacity:.85;font-size:12px;">
        ${meta ? meta + " • " : ""}
        ${rating ? ("التقييم: " + rating) : ""}${rc ? (" (" + rc + ")") : ""}
      </div>
      <div style="margin-top:10px;display:flex;gap:10px;align-items:center;justify-content:space-between;">
        ${g}
        ${btn}
      </div>
    </div>
  `;
}

(function ensurePopupBtnStyle() {
  if (document.getElementById("rnPopBtnStyle")) return;
  const st = document.createElement("style");
  st.id = "rnPopBtnStyle";
  st.textContent = `.rnPopBtn{padding:8px 10px;border-radius:12px;border:1px solid rgba(0,0,0,.12);background:rgba(245,158,11,.12);font-weight:900;cursor:pointer;white-space:nowrap}`;
  document.head.appendChild(st);
})();

function setMarkers(places) {
  initLeafletMap();
  clearMarkers();

  const bounds = [];
  for (const p of places) {
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const rank = bounds.length + 1;
    const size = isMobile() ? 24 : 26;
    const color = rank <= 3 ? "#f59e0b" : "#3b82f6";

    const icon = L.divIcon({
      className: "",
      html: `<div class="rn-pin" style="--pin:${color};--s:${size}px"><span>${rank}</span></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });

    const m = L.marker([lat, lng], { icon, keyboard: false }).addTo(MARKERS_LAYER);
    m.bindPopup(popupHtml(p), { closeButton: true, autoPan: false, autoPanPadding: [16, 16] });
    m.on("click", () => {
      selectPlaceById(p.id, "marker");
      try { m.openPopup(); } catch (_e) { }
    });

    MARKERS_BY_ID.set(String(p.id), m);
    bounds.push([lat, lng]);
  }

  if (!DID_FIT_BOUNDS && bounds.length >= 2) {
    DID_FIT_BOUNDS = true;
    try { MAP.fitBounds(bounds, { padding: [40, 40] }); } catch (_e) { }
  }
}

function updateHeatLayer(places) {
  if (!MAP) return;

  if (state.heatmap === "Off") {
    if (HEAT_LAYER) {
      try { MAP.removeLayer(HEAT_LAYER); } catch (_e) { }
      HEAT_LAYER = null;
    }
    return;
  }

  const insightObj = INSIGHTS.find(x => x.key === state.insight) || INSIGHTS[0];
  const weightFn = (insightObj && insightObj.heatFn)
    ? insightObj.heatFn
    : (p) => {
      const b2 = Number(p.bayes2_score ?? 0);
      const v = Number(p.rating_count ?? 0);
      const nv = Math.max(0, Math.min(1, v / 500));
      return Math.max(0, Math.min(1, 0.65 * b2 + 0.35 * nv));
    };

  const pts = [];
  for (const p of places) {
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const w = Number(weightFn(p));
    pts.push([lat, lng, Number.isFinite(w) ? w : 0.2]);
  }

  if (!window.L || !L.heatLayer) {
    console.warn("leaflet.heat not loaded; cannot render heatmap");
    return;
  }

  if (!HEAT_LAYER) {
    HEAT_LAYER = L.heatLayer(pts, { radius: 22, blur: 18, maxZoom: 17 });
    HEAT_LAYER.addTo(MAP);
  } else {
    try { HEAT_LAYER.setLatLngs(pts); } catch (_e) { }
    if (!MAP.hasLayer(HEAT_LAYER)) {
      try { HEAT_LAYER.addTo(MAP); } catch (_e) { }
    }
  }
}

function focusPlace(p) {
  if (!MAP) return;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const zoom = Math.max(16, MAP.getZoom() || 16);
  let centerLatLng = L.latLng(lat, lng);

  try {
    const mapContainer = MAP.getContainer();
    const mapHeight = mapContainer ? mapContainer.offsetHeight : window.innerHeight;
    const isDesktop = window.matchMedia("(min-width: 980px)").matches;

    let offsetY = 0;

    // Account for bottom panel on mobile
    if (!isDesktop) {
      const panel = document.getElementById("panel");
      if (panel) {
        const ph = panel.getBoundingClientRect().height || 0;
        if (ph > 0) {
          offsetY += Math.round(ph * 0.4);
        }
      }
    }

    // Account for popup appearing above marker (approximately 120px)
    // Shift map down so popup and marker are both visible
    offsetY -= 60;

    if (offsetY !== 0) {
      const targetPoint = MAP.project(centerLatLng, zoom);
      centerLatLng = MAP.unproject(targetPoint.add([0, offsetY]), zoom);
    }
  } catch (_e) { }

  MAP.setView(centerLatLng, zoom, { animate: true });

  const marker = MARKERS_BY_ID.get(String(p.id));
  if (marker && marker.bringToFront) marker.bringToFront();
}

function selectPlaceById(id, source = "select") {
  const pid = String(id);
  const p = DATA.find(x => String(x.id) === pid);
  if (!p) return;

  // GA: place select
  gaEvent("place_select", {
    place_id: (p && p.place_id) ? String(p.place_id) : pid,
    source: source || "select"
  });

  if (SELECTED_ID && SELECTED_ID !== pid) {
    const prev = MARKERS_BY_ID.get(String(SELECTED_ID));
    if (prev && prev.getElement) {
      const node = prev.getElement();
      const pin = node ? node.querySelector(".rn-pin") : null;
      if (pin) pin.classList.remove("active");
    }
  }

  SELECTED_ID = pid;

  const marker = MARKERS_BY_ID.get(pid);
  if (marker && marker.getElement) {
    const node = marker.getElement();
    const pin = node ? node.querySelector(".rn-pin") : null;
    if (pin) pin.classList.add("active");
  }

  // Open the popup when clicking from list
  if (marker) {
    try { marker.openPopup(); } catch (_e) { }
  }

  // Center the place on map after popup opens
  focusPlace(p);

  const wrap = document.getElementById("resultsList");
  if (wrap) {
    wrap.querySelectorAll(".card.is-selected").forEach(x => x.classList.remove("is-selected"));
    const card = wrap.querySelector(`.card[data-id="${cssEscape(pid)}"]`);
    if (card) {
      card.classList.add("is-selected");
      try { card.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_e) { }
    }
  }
}

// ================================
// Similar mode
// ================================
function enterSimilarMode(anchor, results) {
  state.similarMode = true;
  state.similarAnchor = anchor || null;
  state.similarResults = Array.isArray(results) ? results : [];
  const bar = document.getElementById("similarBar");
  const txt = document.getElementById("similarText");
  if (bar && txt) {
    txt.textContent = `أماكن مشابهة لـ: ${anchor?.name || ""}`;
    bar.style.display = "flex";
  }
  SELECTED_ID = null;
  gaTrackFiltersDebounced("similar_enter");
  render();
}

function exitSimilarMode(reason = "ui") {
  if (state.similarMode) {
    gaEvent("similar_clear", { source: reason || "ui" });
  }
  state.similarMode = false;
  state.similarAnchor = null;
  state.similarResults = [];
  const bar = document.getElementById("similarBar");
  if (bar) bar.style.display = "none";
  SELECTED_ID = null;
  gaTrackFiltersDebounced("similar_exit");
  render();
}

function normalizeSimilarResults(arr, anchorId) {
  return (arr || [])
    .filter(x => x && (x.place_id || x.id) && String(x.place_id || x.id) !== String(anchorId))
    .map(x => ({
      id: String(x.place_id || x.id),
      place_id: String(x.place_id || x.id),
      name: x.name || "",
      lat: Number(x.lat),
      lng: Number(x.lng),
      rating: (x.rating != null ? Number(x.rating) : null),
      rating_count: (x.rating_count != null ? Number(x.rating_count) : null),
      bayes2_score: (x.bayes2_score != null ? Number(x.bayes2_score) : null),
      sentiment_label_ar: x.sentiment_label_ar || "",
      price_bucket_ar: x.price_bucket_ar || "",
      tags: Array.isArray(x.tags) ? x.tags : [],
      summary: x.summary || "",
      link: x.link || ""
    }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

window.findSimilar = async function (place_id, source = "ui") {
  const anchor = DATA.find(p => String(p.id) === String(place_id));
  if (!anchor) return;

  const bar = document.getElementById("similarBar");
  const txt = document.getElementById("similarText");
  if (bar && txt) {
    bar.style.display = "flex";
    txt.textContent = `جارِ البحث عن أماكن مشابهة لـ: ${anchor.name}…`;
  }

  // GA: similar request
  gaEvent("similar_request", { place_id: String(place_id), scope: "category", source: source || "ui" });

  try {
    const url = new URL(SIMILAR_API_URL);
    url.searchParams.set("place_id", String(place_id));
    url.searchParams.set("scope", "category");
    url.searchParams.set("k", "40");
    url.searchParams.set("min_sim", "0");

    const resp = await fetchWithRetry(url.toString(), { method: "GET" }, 3);
    if (!resp.ok) {
      const raw = await resp.text().catch(() => "");
      gaEvent("similar_error", { place_id: String(place_id), http_status: resp.status });
      showToast(`تعذر تحميل أماكن مشابهة (HTTP ${resp.status}).`, "error", 5000);
      console.error("[API Error] Similar places failed:", resp.status, raw.slice(0, 300));
      exitSimilarMode("http_error");
      return;
    }
    const payload = await resp.json();
    const arr = Array.isArray(payload) ? payload : (payload?.results || payload?.items || []);
    const results = normalizeSimilarResults(arr, place_id);

    gaEvent("similar_success", { place_id: String(place_id), results_count: results.length });
    enterSimilarMode(anchor, results);
  } catch (e) {
    console.error("[API Error] Similar places fetch error:", e);
    gaEvent("similar_error", { place_id: String(place_id), http_status: 0 });
    showToast("تعذر تحميل أماكن مشابهة. حاول مرة أخرى.", "error", 5000);
    exitSimilarMode("exception");
  }
};

// ================================
// Filtering + sorting
// ================================
function sortBySpec(a, b, spec) {
  const s = String(spec || "");

  if (s.startsWith("desc:")) {
    const f = s.slice(5);
    return (num(b[f]) - num(a[f]));
  }
  if (s.startsWith("asc:")) {
    const f = s.slice(4);
    return (num(a[f]) - num(b[f]));
  }
  if (s === "special:mustgo") {
    const d1 = (num(b.bayes2_score) - num(a.bayes2_score));
    if (d1) return d1;
    const d2 = (num(b.rating_count) - num(a.rating_count));
    if (d2) return d2;
    return (num(b.rating) - num(a.rating));
  }

  const d = (num(b.trust) - num(a.trust));
  if (d) return d;
  return (num(b.rating_count) - num(a.rating_count));
}

function filterData(rows) {
  const insightObj = INSIGHTS.find(x => x.key === state.insight) || INSIGHTS[0];
  const pred = insightObj.predicate || (() => true);
  const q = state.q.toLowerCase();

  return rows
    // In similar mode, we intentionally ignore district/category/insight for the results coming back
    .filter(p => state.similarMode ? true : (state.district === "all" ? true : p.district === state.district))
    .filter(p => state.similarMode ? true : (state.categories.has("all") ? true : state.categories.has(p.category)))
    .filter(p => state.similarMode ? true : pred(p))
    .filter(p => {
      if (!q) return true;
      const hay = `${p.name} ${(p.tags || []).join(" ")} ${p.category} ${p.district}`.toLowerCase();
      return hay.includes(q);
    })
    .filter(p => state.sentiment === "الكل" ? true : p.sentiment === state.sentiment)
    .filter(p => state.price === "الكل" ? true : p.price === state.price)
    .filter(p => state.tags.size === 0 ? true : [...state.tags].every(t => (p.tags || []).includes(t)))
    .sort((a, b) => sortBySpec(a, b, insightObj.sort));
}

// ================================
// UI menus (Insights/Categories/Panel menus)
// ================================
function buildInsightTopMenu() {
  const wrap = el("insightTopItems");
  if (!wrap) return;
  wrap.innerHTML = "";

  for (const it of INSIGHTS) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "opt" + (state.insight === it.key ? " is-active" : "");
    opt.innerHTML = `<span>${it.emoji} ${it.label}</span><span class="badge">${state.insight === it.key ? "✓" : ""}</span>`;
    opt.addEventListener("click", async (e) => {
      state.insight = it.key;

      gaEvent("insight_pick", { insight_mode: it.key });
      gaTrackFiltersDebounced("insight_pick");

      buildInsightTopMenu();
      syncTopChipLabels();
      closeMenus();
      render();

      // Zoom out to show places matching the new insight filter in the selected district
      if (state.district && state.district !== "all") {
        try {
          await focusDistrict(state.district);
        } catch (err) {
          console.warn("[Insight] Failed to focus district after insight change:", err);
        }
      }

      e.stopPropagation();
    });
    wrap.appendChild(opt);
  }
}

function labelForCategory(key) {
  return (CATEGORIES.find(c => c.key === key)?.label) ?? key;
}

function buildCatsTopMenu() {
  const wrap = el("catsTopItems");
  if (!wrap) return;
  wrap.innerHTML = "";

  const staging = new Set(state.categories);

  const paint = (btn, key) => btn.classList.toggle("is-active", staging.has(key));

  for (const c of CATEGORIES) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "opt opt--chip";
    opt.innerHTML = `<span>${c.emoji} ${c.label}</span>`;
    paint(opt, c.key);

    opt.addEventListener("click", (e) => {
      if (c.key === "all") {
        staging.clear();
        staging.add("all");
        [...wrap.querySelectorAll(".opt")].forEach(x => x.classList.remove("is-active"));
        opt.classList.add("is-active");
      } else {
        staging.delete("all");
        if (staging.has(c.key)) staging.delete(c.key); else staging.add(c.key);
        if (staging.size === 0) staging.add("all");
        const buttons = [...wrap.querySelectorAll(".opt")];
        buttons.forEach((b, idx) => paint(b, CATEGORIES[idx].key));
      }

      // INSTANT APPLY: Apply filter immediately on click
      state.categories = new Set(staging);
      gaEvent("categories_apply", { count: state.categories.size, has_all: state.categories.has("all") ? 1 : 0 });
      gaTrackFiltersDebounced("categories_apply");
      syncTopChipLabels();
      render();

      e.stopPropagation();
    });

    wrap.appendChild(opt);
  }

  // Apply button removed - filters now apply instantly on click

  const clearBtn = el("clearCatsTop");
  if (clearBtn) clearBtn.onclick = (e) => {
    staging.clear();
    staging.add("all");
    state.categories = new Set(staging);

    [...wrap.querySelectorAll(".opt")].forEach((b, idx) => b.classList.toggle("is-active", CATEGORIES[idx].key === "all"));

    gaEvent("categories_clear", { source: "menu" });
    gaTrackFiltersDebounced("categories_clear");

    syncTopChipLabels();
    render();

    e.stopPropagation();
  };
}

// Backwards compatible alias
function buildCategoriesTopMenu() { return buildCatsTopMenu(); }

function syncTopChipLabels() {
  const i = INSIGHTS.find(x => x.key === state.insight);
  const insightEl = el("insightTopValue");
  if (insightEl) insightEl.textContent = i ? i.label : "الكل";

  const catsEl = el("catsTopValue");
  if (!catsEl) return;

  if (state.categories.has("all")) {
    catsEl.textContent = "الكل";
  } else {
    const keys = [...state.categories];
    if (keys.length === 1) catsEl.textContent = labelForCategory(keys[0]);
    else catsEl.textContent = `${keys.length} تصنيفات`;
  }
}

function buildSingleSelectMenu(containerId, options, onPick, getCurrent) {
  const wrap = el(containerId);
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const v of options) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "opt" + (getCurrent() === v ? " is-active" : "");
    opt.innerHTML = `<span>${v}</span><span class="badge">${v === "الكل" ? "Any" : (getCurrent() === v ? "✓" : "")}</span>`;
    opt.addEventListener("click", (e) => { onPick(v); e.stopPropagation(); });
    wrap.appendChild(opt);
  }
}

function buildHeatmapMenu() {
  const wrap = el("heatmapItems");
  if (!wrap) return;
  wrap.innerHTML = "";
  const options = ["Off", "Density", "Score"];
  for (const v of options) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "opt" + (state.heatmap === v ? " is-active" : "");
    opt.innerHTML = `<span>${v}</span><span class="badge">${state.heatmap === v ? "✓" : ""}</span>`;
    opt.addEventListener("click", (e) => {
      state.heatmap = v;

      gaEvent("heatmap_change", { heatmap: v });
      gaTrackFiltersDebounced("heatmap_change");

      const hv = el("heatmapValue");
      if (hv) hv.textContent = v;
      buildHeatmapMenu();
      closeMenus();
      render();
      e.stopPropagation();
    });
    wrap.appendChild(opt);
  }
}

function buildTagsMenu() {
  const wrap = el("tagsItems");
  if (!wrap) return;

  TAGS_DRAFT = TAGS_DRAFT || new Set(state.tags);
  const staging = TAGS_DRAFT;

  const q = normalizeText(state.tagsQuery || "");
  const list = TAGS.filter(t => normalizeText(t).includes(q)).slice(0, 200);

  const sub = el("tagsSub");
  if (sub) {
    const parts = [`اختر أكثر من وسم`, `المحدد: ${staging.size}`];
    if (q) parts.push(`نتائج: ${list.length}`);
    sub.textContent = parts.join(" • ");
  }

  wrap.innerHTML = "";
  for (const t of list) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "opt opt--chip";
    const c = TAG_COUNTS.get(t) || 0;
    opt.innerHTML = `<span>#${escapeHtml(t)}</span><span class="badge">${c}</span>`;

    const paint = () => opt.classList.toggle("is-active", staging.has(t));
    paint();

    opt.addEventListener("click", (e) => {
      if (staging.has(t)) staging.delete(t); else staging.add(t);
      paint();
      if (sub) {
        const parts = [`اختر أكثر من وسم`, `المحدد: ${staging.size}`];
        if (q) parts.push(`نتائج: ${list.length}`);
        sub.textContent = parts.join(" • ");
      }

      // INSTANT APPLY: Apply filter immediately on click
      state.tags = new Set(staging);
      gaEvent("tags_apply", { tags_count: state.tags.size });
      gaTrackFiltersDebounced("tags_apply");
      const tv = el("tagsValue");
      if (tv) tv.textContent = state.tags.size ? `${state.tags.size} وسم` : "الكل";
      render();

      e.stopPropagation();
    });

    wrap.appendChild(opt);
  }

  // Clear button: Apply instantly after clearing
  const clear = el("clearTags");
  if (clear) clear.onclick = (e) => {
    staging.clear();
    wrap.querySelectorAll(".opt").forEach(o => o.classList.remove("is-active"));

    gaEvent("tags_clear", { source: "menu" });
    gaTrackFiltersDebounced("tags_clear");

    if (sub) {
      const parts = [`اختر أكثر من وسم`, `المحدد: ${staging.size}`];
      if (q) parts.push(`نتائج: ${list.length}`);
      sub.textContent = parts.join(" • ");
    }

    // INSTANT APPLY: Apply changes immediately
    state.tags = new Set(staging);
    const tv = el("tagsValue");
    if (tv) tv.textContent = "الكل";
    render();

    e.stopPropagation();
  };
}

function toggleMenu(key) {
  const menu = el(`menu-${key}`);
  if (!menu) return;
  const isOpen = menu.classList.contains("is-open");
  closeMenus();
  if (!isOpen) {
    if (key === "tags") {
      TAGS_DRAFT = TAGS_DRAFT || new Set(state.tags);
      state.tagsQuery = "";
      const inp = el("tagsSearch");
      if (inp) inp.value = "";
      buildTagsMenu();
      menu.classList.add("is-open");
      setTimeout(() => { try { inp && inp.focus(); } catch (_e) { } }, 0);

      gaEvent("menu_open", { menu: "tags" });

      return;
    }
    menu.classList.add("is-open");

    gaEvent("menu_open", { menu: String(key || "") });
  }
}

function closeMenus() {
  const tagsMenu = el("menu-tags");
  if (tagsMenu && tagsMenu.classList.contains("is-open")) {
    TAGS_DRAFT = null;
    state.tagsQuery = "";
    const inp = el("tagsSearch");
    if (inp) inp.value = "";
  }
  document.querySelectorAll(".menu").forEach(m => m.classList.remove("is-open"));
}

// ================================
// Place loading + bootstrap
// ================================
async function loadRealPlacesAndBootstrapUI() {
  const url = new URL(PLACES_API_URL);
  url.searchParams.set("limit", "20000");
  url.searchParams.set("sort", "bayes2_desc");

  const { payload } = await fetchPlacesCached(url.toString());

  // Validate API response
  const validation = validateAPIResponse(payload, "places_api");
  if (!validation.valid) {
    console.error("[Data Loading] Invalid API response:", validation.error);
    showToast("فشل تحميل البيانات. يرجى المحاولة مرة أخرى.", "error", 5000);
    DATA = [];
    return;
  }

  if (validation.filtered > 0) {
    console.warn(`[Data Loading] Filtered out ${validation.filtered} invalid places`);
  }

  DATA = validation.results.map((p) => {
    const tags = Array.isArray(p.tags) ? p.tags
      : Array.isArray(p.tags_ar) ? p.tags_ar
        : Array.isArray(p.top_tags) ? p.top_tags
          : [];

    const district = p.district || p.district_ar || "all";
    const district_slug_ar = p.district_slug_ar || "";           // ✅ NEW field from API
    const category = p.category || p.primary_type || p.primary_type_display_name || "other";
    const sentiment = p.sentiment_label_ar || p.sentiment || "محايد";
    const price = p.price_level || p.price || "الكل";

    return {
      id: p.place_id || p.id || p.gid || String(Math.random()),
      place_id: p.place_id || p.id,

      name: p.name || "",
      district,
      district_slug_ar,
      category,
      sentiment,
      price,
      
      rating: Number(p.rating ?? 0),

      // Keep both names used in various parts
      reviews: Number(p.rating_count ?? p.user_ratings_total ?? p.reviews ?? 0),
      rating_count: Number(p.rating_count ?? p.user_ratings_total ?? p.reviews ?? 0),

      trust: Number(p.bayes2_score ?? p.trust ?? 0),
      bayes2_score: Number(p.bayes2_score ?? p.trust ?? 0),

      sentiment_label_ar: sentiment,
      price_level: price,
      price_bucket_ar: p.price_bucket_ar || "",

      lat: Number(p.lat ?? p.latitude),
      lng: Number(p.lng ?? p.longitude),

      tags: tags.map(String),

      summary: p.summary || "",
      link: p.link || "",
      pros_ar: Array.isArray(p.pros_ar) ? p.pros_ar : [],
    };
  });

  // Build slug → Arabic label map ONCE for UI
  try {
    DISTRICT_LABEL_AR_BY_SLUG = new Map();
    for (const p of DATA) {
      const sl = String(p.district || "");
      const ar = String(p.district_slug_ar || "").trim();
      if (sl && ar && !DISTRICT_LABEL_AR_BY_SLUG.has(sl)) {
        DISTRICT_LABEL_AR_BY_SLUG.set(sl, ar);
      }
    }
  } catch (_e) {
    DISTRICT_LABEL_AR_BY_SLUG = new Map();
  }
  // District options
  const districts = Array.from(new Set(DATA.map(p => p.district).filter(Boolean)))
    .sort((a, b) => String(a).localeCompare(String(b), "ar"));

  const distSel = el("district");
  if (distSel) {
    distSel.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "كل الأحياء";
    distSel.appendChild(optAll);

    for (const d of districts) {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = districtLabelArFromSlug(d); // ✅ Arabic label
      distSel.appendChild(o);
    }

    state.district = "all";
    distSel.value = "all";
  }

  // Categories
  const cats = Array.from(new Set(DATA.map(p => p.category).filter(Boolean)))
    .sort((a, b) => String(a).localeCompare(String(b), "ar"));
  CATEGORIES = [{ key: "all", label: "الكل", emoji: "✨" }, ...cats.map(c => ({ key: c, label: c, emoji: "🏷️" }))];

  // Tags
  const freq = new Map();
  for (const p of DATA) {
    for (const t of (p.tags || [])) {
      if (!t) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  TAG_COUNTS = new Map(freq);
  TAGS = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 200).map(x => x[0]);

  // Insights config
  const cfg = await loadToggleConfig();
  rebuildInsightsFromToggleConfig(cfg);

  // Rebuild menus
  buildInsightTopMenu();
  buildCategoriesTopMenu();
  buildTagsMenu();

  gaEvent("places_loaded", { count: DATA.length });
}

// ================================
// Rendering
// ================================
function getActiveInsightObj() {
  return (INSIGHTS || []).find(t => t.key === state.insight) || null;
}

function cardPrimaryBadge(p) {
  const t = getActiveInsightObj();
  if (!t || t.key === "all") {
    // Default: show trust score
    return `Trust ${((p.trust ?? 0)).toFixed(2)}`;
  }

  // Smart badges based on insight mode
  switch (t.key) {
    case "must_go":
      // Show bayes score as percentage
      return `💎 ${((p.bayes2_score ?? 0) * 100).toFixed(0)}%`;

    case "top_rated":
      // Show rating with stars
      return `⭐ ${Number(p.rating || 0).toFixed(1)} (${p.rating_count || 0})`;

    case "raqi":
      // Show price level or trust
      return p.price_bucket_ar ? `${p.price_bucket_ar}` : `💎 ${((p.bayes2_score ?? 0) * 100).toFixed(0)}%`;

    case "discover":
      // Show rating + review count (hidden gems)
      return `🧭 ${Number(p.rating || 0).toFixed(1)} • ${p.rating_count || 0} مراجعة`;

    default:
      // Fallback to insight label
      return t.label || "فلتر";
  }
}

function render() {
  const insightObj = getActiveInsightObj() || INSIGHTS[0];
  const insightLabel = `${insightObj.emoji} ${insightObj.label}`;
  const qPart = state.q ? `• بحث: "${state.q}"` : "";
  const tagsPart = state.tags.size ? `• وسوم: ${[...state.tags].slice(0, 2).join(", ")}${state.tags.size > 2 ? "…" : ""}` : "";
  const heatPart = state.heatmap !== "Off" ? `• Heatmap: ${state.heatmap}` : "";
  const catsPart = state.categories.has("all") ? "الكل" : [...state.categories].join("+");

  const titleEl = el("resultsTitle");
  const metaEl = el("resultsMeta");
  const panelTitleEl = el("panelInsightTitle");

  if (titleEl) titleEl.textContent = state.similarMode ? `أماكن مشابهة` : `قائمة الأماكن (${insightLabel})`;
  if (panelTitleEl) panelTitleEl.textContent = state.similarMode ? `أماكن مشابهة` : insightLabel;

  const distLabel = (state.district === "all") ? "كل الأحياء" : state.district;
  if (metaEl) metaEl.textContent = `${distLabel} • ${catsPart}${qPart} ${tagsPart} ${heatPart}`.trim();

  const baseRows = state.similarMode ? state.similarResults : DATA;
  const list = filterData(baseRows);

  setMarkers(list);
  updateHeatLayer(list);

  if (!DID_INVALIDATE_ON_FIRST_RENDER) {
    DID_INVALIDATE_ON_FIRST_RENDER = true;
    setTimeout(() => { try { MAP && MAP.invalidateSize(true); } catch (_e) { } }, 0);
  }

  if (metaEl) metaEl.textContent += ` • ${list.length} نتيجة`;

  const wrap = el("resultsList");
  if (!wrap) return;
  wrap.innerHTML = "";

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const rank = i + 1;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = String(p.id);
    card.addEventListener("click", () => selectPlaceById(p.id, "list"));
    const sentimentEmoji = p.sentiment === "إيجابي" ? "🙂" : p.sentiment === "سلبي" ? "😞" : "😐";
    const pros = Array.isArray(p.pros_ar) ? p.pros_ar.filter(Boolean).slice(0, 3) : [];

    card.innerHTML = `
      <div class="card__header">
        <div class="card__name">${rank}. ${escapeHtml(p.name)}</div>
        <div class="badge">${escapeHtml(cardPrimaryBadge(p))}</div>
      </div>
      <div class="card__meta">
        ${escapeHtml(p.district)} • ${escapeHtml(p.category)} • ⭐ ${Number(p.rating || 0).toFixed(1)} • 🗣️ ${Number(p.reviews || 0)} • ${sentimentEmoji} ${escapeHtml(p.sentiment || "")}
      </div>
      ${p.summary ? `<div class="card__summary">${escapeHtml(p.summary)}</div>` : ''}
      ${pros.length > 0 ? `<div class="card__pros">${pros.map(pr => `<span class="pro-tag">${escapeHtml(pr)}</span>`).join('')}</div>` : ''}
    `;
    wrap.appendChild(card);
  }

  if (SELECTED_ID) {
    const card = wrap.querySelector(`.card[data-id="${cssEscape(SELECTED_ID)}"]`);
    if (card) card.classList.add("is-selected");
  }
}

// ================================
// Panel collapse / drag (mobile-first)
// ================================
function initPanelCollapse() {
  const panel = el("panel");
  const handle = el("panelHandle");
  const btn = el("collapseBtn");
  if (!panel || !handle || !btn) return;

  const isDesktop = () => window.matchMedia("(min-width: 980px)").matches;
  const root = document.documentElement;
  const body = document.body;

  const setH = (vh) => {
    root.style.setProperty("--panel-h", `${vh}vh`);
    // If any CSS sets --panel-h on body (higher precedence), keep it in sync.
    try { body && body.style && body.style.setProperty("--panel-h", `${vh}vh`); } catch (_e) {}
  };

  const MIN = 22;
  const MAX = 66;
  const START = 40; // mobile initial peek height

  let collapsed = false;

  // Ensure a predictable initial height on mobile
  try {
    if (!isDesktop()) {
      const peek = document.body && document.body.classList && document.body.classList.contains("panelPeekMobile");
      setH(peek ? START : MAX);
      btn.textContent = "▾";
    }
  } catch (_e) { }

  btn.addEventListener("click", (e) => {
    if (isDesktop()) return;
    collapsed = !collapsed;
    setH(collapsed ? MIN : MAX);
    btn.textContent = collapsed ? "▴" : "▾";

    gaEvent("panel_toggle", { panel: "results", state: collapsed ? "collapsed" : "expanded" });

  btn.addEventListener("touchend", (e) => {
    // iOS Safari: ensure toggle works reliably
    btn.click();
    e.preventDefault();
  }, { passive: false });

    closeMenus();
    e.stopPropagation();
  });

  let startY = 0;
  let startH = MAX;
  let dragging = false;

  const onDown = (e) => {
    if (isDesktop()) return;
    if (e.target && e.target.closest && e.target.closest("#collapseBtn")) return;
    dragging = true;
    closeMenus();
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    if (e.touches) { try { e.preventDefault(); } catch (_e) {} }
    const cur = parseFloat(getComputedStyle(root).getPropertyValue("--panel-h")) || MAX;
    startH = cur;
    panel.style.transition = "none";
  };

  const onMove = (e) => {
    if (!dragging || isDesktop()) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    const dy = y - startY;
    const vhPerPx = 100 / window.innerHeight;
    let next = startH - (dy * vhPerPx);
    next = Math.max(MIN, Math.min(MAX, next));
    setH(next);
    e.preventDefault();
  };

  const onUp = () => {
    if (!dragging || isDesktop()) return;
    dragging = false;
    panel.style.transition = "";
    const cur = parseFloat(getComputedStyle(root).getPropertyValue("--panel-h")) || MAX;
    const snapToMin = cur < (MIN + MAX) / 2;
    setH(snapToMin ? MIN : MAX);
    collapsed = snapToMin;
    btn.textContent = collapsed ? "▴" : "▾";
  };

  handle.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);

  handle.addEventListener("touchstart", onDown, { passive: false });
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onUp);
  window.addEventListener("touchcancel", onUp);

  window.addEventListener("resize", () => {
    if (isDesktop()) root.style.setProperty("--panel-h", "100%");
    else setH(collapsed ? MIN : MAX);
  });
}

// ================================
// App init
// ================================
async function init() {
  try {
    if (isMobile()) {
      document.body.classList.add("panelPeekMobile");
      try { document.documentElement.style.setProperty("--panel-h", "40vh"); } catch (_e) {}
    }
  } catch (_e) { }

  // Load district shapes first so focus/border works immediately
  await loadDistrictGeojsonMap();

  // District change
  const districtEl = el("district");
  if (districtEl) {
    districtEl.addEventListener("change", async (e) => {
      state.district = e.target.value;
      SELECTED_ID = null;

      gaEvent("district_change", { district: state.district, source: "select" });
      gaTrackFiltersDebounced("district_change");

      render();
      showSelectedDistrictBoundary(state.district);
      await focusDistrict(state.district);
    });
  }

  // Search
  const debouncedRender = debounce(render, 140);
  const qEl = el("q");
  const clearQEl = el("clearQ");
  if (qEl) qEl.addEventListener("input", (e) => {
    state.q = e.target.value.trim();

    gaTrackFiltersDebounced("search");

    debouncedRender();
  });
  if (clearQEl) clearQEl.addEventListener("click", () => {
    if (qEl) qEl.value = "";
    state.q = "";

    gaEvent("search_clear", { source: "main" });
    gaTrackFiltersDebounced("search_clear");

    render();
  });

  // Menus (initial placeholders, real values after bootstrap)
  buildInsightTopMenu();
  buildCatsTopMenu();

  buildSingleSelectMenu("sentimentItems", SENTIMENTS, (v) => {
    state.sentiment = v;

    gaEvent("sentiment_change", { sentiment: v });
    gaTrackFiltersDebounced("sentiment_change");

    const sv = el("sentimentValue");
    if (sv) sv.textContent = v;
    closeMenus();
    render();
  }, () => state.sentiment);

  buildSingleSelectMenu("priceItems", PRICES, (v) => {
    state.price = v;

    gaEvent("price_change", { price_bucket: v });
    gaTrackFiltersDebounced("price_change");

    const pv = el("priceValue");
    if (pv) pv.textContent = v;
    closeMenus();
    render();
  }, () => state.price);

  buildHeatmapMenu();
  buildTagsMenu();

  // Tags search
  const tagsSearchEl = el("tagsSearch");
  const tagsSearchClearEl = el("tagsSearchClear");
  const debouncedTagsBuild = debounce(() => buildTagsMenu(), 80);
  if (tagsSearchEl) tagsSearchEl.addEventListener("input", (e) => {
    state.tagsQuery = String(e.target.value || "");
    debouncedTagsBuild();
  });
  if (tagsSearchClearEl) tagsSearchClearEl.addEventListener("click", (e) => {
    state.tagsQuery = "";
    if (tagsSearchEl) tagsSearchEl.value = "";
    buildTagsMenu();
    try { tagsSearchEl && tagsSearchEl.focus(); } catch (_e) { }
    e.stopPropagation();
  });

  // Chip open menus
  document.querySelectorAll(".chip[data-menu]").forEach(chip => {
    chip.addEventListener("click", (e) => {
      toggleMenu(chip.dataset.menu);
      e.stopPropagation();
    });
  });

  // Reset
  function resetAllFiltersToDefault() {
    gaEvent("filters_reset", { source: "ui" });

    // If user was in similar mode, count that explicitly as a clear
    if (state.similarMode) gaEvent("similar_clear", { source: "reset" });

    state.q = "";
    state.district = "all";
    state.insight = "must_go";
    state.categories = new Set(["all"]);
    state.sentiment = "الكل";
    state.price = "الكل";
    state.tags = new Set();
    state.heatmap = "Off";

    if (qEl) qEl.value = "";
    if (districtEl) districtEl.value = state.district;

    const sv = el("sentimentValue");
    const pv = el("priceValue");
    const tv = el("tagsValue");
    const hv = el("heatmapValue");
    if (sv) sv.textContent = "الكل";
    if (pv) pv.textContent = "الكل";
    if (tv) tv.textContent = "الكل";
    if (hv) hv.textContent = "Off";

    clearDistrictBoundary();
    syncTopChipLabels();
    buildInsightTopMenu();
    buildCatsTopMenu();
    buildTagsMenu();
    buildHeatmapMenu();
    closeMenus();

    // Reset map view to initial behavior (fit bounds on next render)
    try { if (MAP) MAP.closePopup(); } catch (_e) { }
    try { SELECTED_ID = null; } catch (_e) { }
    try { DID_FIT_BOUNDS = false; } catch (_e) { }

    gaTrackFiltersDebounced("reset");

    render();
  }

  const resetEl = el("resetAll");
  if (resetEl) resetEl.addEventListener("click", resetAllFiltersToDefault);

  const resetTopEl = el("resetTop");
  if (resetTopEl) resetTopEl.addEventListener("click", resetAllFiltersToDefault);

  // Filter toggle button
  const filterToggleBtn = el("filterToggleBtn");
  const filtersRow = el("filtersRow");
  if (filterToggleBtn && filtersRow) {
    filterToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = filtersRow.style.display !== "none";
      filtersRow.style.display = isVisible ? "none" : "flex";
      filterToggleBtn.classList.toggle("active", !isVisible);
    });
  }

  // Close menus
  document.addEventListener("click", () => closeMenus());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

  // Panel collapse/drag
  initPanelCollapse();

  // Init map + locate me
  initLeafletMap();
  initLocateMe();
  setTimeout(() => { try { MAP && MAP.invalidateSize(true); } catch (_e) { } }, 50);

  // Load places + bootstrap dynamic menus
  await loadRealPlacesAndBootstrapUI();

  syncTopChipLabels();

  // If district already selected (rare), show boundary
  showSelectedDistrictBoundary(state.district);

  // GA: initial filters snapshot (after bootstrap)
  gaTrackFiltersDebounced("init");

  render();

  // Auto-detect user location and select district on first load
  autoDetectLocation();
}

// Keep map sized properly
window.addEventListener("load", () => {
  try { if (MAP) MAP.invalidateSize(true); } catch (_e) { }
});

window.addEventListener("DOMContentLoaded", () => {
  init().catch(err => console.error(err));

  // SECURITY FIX: Event delegation for popup buttons (replaces inline onclick)
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='find-similar']");
    if (btn) {
      e.preventDefault();
      const placeId = btn.getAttribute("data-place-id");
      if (placeId && typeof window.findSimilar === "function") {
        window.findSimilar(placeId, "popup");
      }
    }
  });
});
