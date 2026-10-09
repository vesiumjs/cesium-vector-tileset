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
  styleId: StyleId;
}

export const demoPresets = [
  { id: 'shanghai', name: '上海 · 跨江高层白模', longitude: 121.478, latitude: 31.224, height: 1600, heading: 55, pitch: -30, roll: 0, styleId: 'buildings' },
  { id: 'manhattan', name: '曼哈顿 · 滨水高楼白模', longitude: -74.018, latitude: 40.699, height: 1000, heading: 32, pitch: -25, roll: 0, styleId: 'buildings' },
  { id: 'hong-kong', name: '香港 · 海岸高楼白模', longitude: 114.177, latitude: 22.2865, height: 1000, heading: 250, pitch: -25, roll: 0, styleId: 'buildings' },
  { id: 'shinjuku', name: '东京新宿 · 高负载', longitude: 139.7005, latitude: 35.6905, height: 1500, heading: 15, pitch: -45, roll: 0, styleId: 'liberty' },
  { id: 'london', name: '伦敦桥 · 接缝与标注', longitude: -0.0863, latitude: 51.5078, height: 900, heading: 110, pitch: -35, roll: 0, styleId: 'osm' },
  { id: 'amsterdam', name: '阿姆斯特丹 · 密集小建筑', longitude: 4.8954, latitude: 52.3728, height: 350, heading: 60, pitch: -40, roll: 0, styleId: 'buildings' },
  { id: 'san-francisco', name: '旧金山 · 长距离斜视', longitude: -122.392, latitude: 37.803, height: 1000, heading: 225, pitch: -25, roll: 0, styleId: 'versatiles' },
  { id: 'paris', name: '巴黎 · 复杂路口与小建筑', longitude: 2.285, latitude: 48.867, height: 900, heading: 45, pitch: -40, roll: 0, styleId: 'osm' },
  { id: 'sao-paulo', name: '圣保罗 · 大片密集城区', longitude: -46.6559, latitude: -23.5614, height: 1500, heading: 50, pitch: -35, roll: 0, styleId: 'liberty' },
  { id: 'dateline', name: '斐济 · 日期变更线', longitude: 179.99, latitude: -16.8, height: 45000, heading: 90, pitch: -70, roll: 0, styleId: 'bright' },
  { id: 'chicago', name: '芝加哥 · 湖岸高层街区', longitude: -87.606, latitude: 41.884, height: 1200, heading: 270, pitch: -30, roll: 0, styleId: 'liberty' },
  { id: 'barcelona', name: '巴塞罗那 · 密集网格路口', longitude: 2.149, latitude: 41.380, height: 1500, heading: 45, pitch: -55, roll: 0, styleId: 'liberty' },
  { id: 'chongqing', name: '重庆 · 两江桥梁与路网', longitude: 106.596, latitude: 29.578, height: 1600, heading: 240, pitch: -45, roll: 0, styleId: 'liberty' },
] as const satisfies readonly DemoPreset[];

export type DemoPresetId = typeof demoPresets[number]['id'];
