export const modeOptions = [
  { id: '3d', name: '3D' },
  { id: '2d', name: '2D' },
  { id: 'cv', name: 'Columbus' },
] as const;
export type DemoMode = typeof modeOptions[number]['id'];

const openFreeMapCredit = '<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export const stylePresets = [
  { id: 'liberty', name: 'OpenFreeMap · Liberty', provider: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/styles/liberty', credit: openFreeMapCredit },
  { id: 'bright', name: 'OpenFreeMap · Bright', provider: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/styles/bright', credit: openFreeMapCredit },
  { id: 'positron', name: 'OpenFreeMap · Positron', provider: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/styles/positron', credit: openFreeMapCredit },
  { id: 'versatiles', name: 'VersaTiles · Colorful', provider: 'VersaTiles', url: 'https://tiles.versatiles.org/assets/styles/colorful/style.json', credit: '<a href="https://versatiles.org/">VersaTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://esa-worldcover.org/">ESA WorldCover</a>' },
  { id: 'world', name: 'MapLibre · 世界概览', provider: 'MapLibre', url: 'https://demotiles.maplibre.org/style.json', credit: '<a href="https://maplibre.org/">MapLibre demo tiles</a> · <a href="https://www.naturalearthdata.com/">Natural Earth</a>' },
  { id: 'osm', name: 'OSMF · Shortbread Colorful', provider: 'OSMF', url: 'https://vector.openstreetmap.org/styles/shortbread/colorful.json', credit: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  { id: 'basemap-world', name: 'BKG · basemap.world', provider: 'BKG', url: 'https://sgx.geodatenzentrum.de/gdz_basemapworld_vektor/styles/bm_web_wld_col.json', credit: '© basemap.de / <a href="https://www.bkg.bund.de/">BKG</a> 2026 <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · 数据来源：© GeoBasis-DE / BKG · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a>' },
  { id: 'waymorphic', name: 'Waymorphic · 简洁矢量', provider: 'Waymorphic', url: new URL('../styles/waymorphic.json', import.meta.url).href, credit: '© <a href="https://waymorphic.com/">Waymorphic</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  { id: 'maptoolkit', name: 'Maptoolkit · 简洁矢量', provider: 'Maptoolkit', url: new URL('../styles/maptoolkit.json', import.meta.url).href, credit: '<a href="https://www.maptoolkit.com/copyright/"><img src="https://www.maptoolkit.org/assets/maptoolkit-attribution.png" alt="Maptoolkit" height="24" style="height:24px;width:auto;vertical-align:middle"></a> © <a href="https://www.maptoolkit.com/copyright/">Maptoolkit</a> © <a href="https://www.openstreetmap.org/copyright">Openstreetmap</a>' },
  { id: 'osm-us', name: 'OSM US · 简洁矢量', provider: 'OSM US', url: new URL('../styles/osm-us.json', import.meta.url).href, credit: 'Tiles by <a href="https://tiles.openstreetmap.us/">OSM US</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  { id: 'buildings', name: 'OpenFreeMap · 建筑白模', provider: 'OpenFreeMap', url: new URL('../styles/buildings.json', import.meta.url).href, credit: openFreeMapCredit },
] as const;

export type StyleId = typeof stylePresets[number]['id'];

/** Each preset defines one camera pose; height is metres above the ellipsoid. */
export interface DemoPreset {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}

// Camera presets describe views only. Any style can be used with any preset.
export const demoPresets = [
  { id: 'barcelona', name: '巴塞罗那 · 城区俯视', longitude: 2.17, latitude: 41.39, height: 12000, heading: 0, pitch: -90, roll: 0 },
  { id: 'world', name: '全球 · 地球俯视', longitude: 110, latitude: 25, height: 18000000, heading: 0, pitch: -90, roll: 0 },
  { id: 'manhattan', name: '曼哈顿 · 高层建筑', longitude: -74.018, latitude: 40.699, height: 1000, heading: 32, pitch: -30, roll: 0 },
  { id: 'amsterdam', name: '阿姆斯特丹 · 密集街区', longitude: 4.886, latitude: 52.368, height: 450, heading: 60, pitch: -40, roll: 0 },
  { id: 'london', name: '伦敦 · 河流与桥梁', longitude: -0.091, latitude: 51.498, height: 1800, heading: 0, pitch: -55, roll: 0 },
  { id: 'paris', name: '巴黎 · 放射路网', longitude: 2.295, latitude: 48.874, height: 4000, heading: 0, pitch: -90, roll: 0 },
  { id: 'shanghai', name: '上海 · 滨江高层', longitude: 121.478, latitude: 31.224, height: 1600, heading: 55, pitch: -35, roll: 0 },
] as const satisfies readonly DemoPreset[];

export type DemoPresetId = typeof demoPresets[number]['id'];
