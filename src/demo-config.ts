import type { CesiumWidget } from 'cesium';
import type { CesiumVectorTilesetFromUrlOptions } from 'cesium-vector-tileset';
import { BoundingSphere, Cartesian3, Math as CesiumMath, HeadingPitchRange, Rectangle, SceneMode, WebMercatorProjection } from 'cesium';

export const widgetOptions = {
  baseLayer: false,
  mapProjection: new WebMercatorProjection(),
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity,
} satisfies NonNullable<ConstructorParameters<typeof CesiumWidget>[1]>;

export const sceneOptions = { debugShowFramesPerSecond: true };
export const tilesetOptions = {} satisfies CesiumVectorTilesetFromUrlOptions;
export const heightPresets = [15, 60, 120, 250, 350, 700, 900, 1500, 45000];
export const modePresets = [
  { id: '3d', name: '3D', value: SceneMode.SCENE3D, morph: 'morphTo3D' },
  { id: '2d', name: '2D', value: SceneMode.SCENE2D, morph: 'morphTo2D' },
  { id: 'cv', name: 'Columbus', value: SceneMode.COLUMBUS_VIEW, morph: 'morphToColumbusView' },
] as const;
export const anglePresets = [
  { id: 'top', name: '俯视', pitch: -90 },
  { id: 'oblique', name: '斜视 45°', pitch: -45 },
  { id: 'horizon', name: '低角度 20°', pitch: -20 },
] as const;

export interface DemoSelection {
  source: string;
  style: string;
  view: string;
  mode: string;
  angle: string;
  scenario: string;
  height: number;
  scale?: number;
  resolutionRatio: number;
}

export interface DemoMapConfig {
  url: string;
  credit: string;
  options: CesiumVectorTilesetFromUrlOptions;
}

const openFreeMapCredit = '<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const openFreeMapUsage = '全球 z0–14；免密钥，可商用，保留地图署名；无 SLA。';

export const stylePresets = [
  { id: 'liberty', name: 'OpenFreeMap · Liberty', provider: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/styles/liberty', credit: openFreeMapCredit, description: '完整地图样式：建筑、道路、图标与标签。', usage: openFreeMapUsage },
  { id: 'bright', name: 'OpenFreeMap · Bright', provider: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/styles/bright', credit: openFreeMapCredit, description: '明亮地图样式：道路网与密集标签。', usage: openFreeMapUsage },
  { id: 'positron', name: 'OpenFreeMap · Positron', provider: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/styles/positron', credit: openFreeMapCredit, description: '浅色地图样式：低对比底图与标签。', usage: openFreeMapUsage },
  { id: 'versatiles', name: 'VersaTiles · Colorful', provider: 'VersaTiles', url: 'https://tiles.versatiles.org/assets/styles/colorful/style.json', credit: '<a href="https://versatiles.org/">VersaTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://esa-worldcover.org/">ESA WorldCover</a>', description: '全球 Shortbread 地图样式。', usage: '全球 z0–14；公共服务用于原型和小项目；保留 OSM 与 ESA WorldCover 署名。' },
  { id: 'world', name: 'MapLibre · 世界概览', provider: 'MapLibre', url: 'https://demotiles.maplibre.org/style.json', credit: '<a href="https://maplibre.org/">MapLibre demo tiles</a> · <a href="https://www.naturalearthdata.com/">Natural Earth</a>', description: '国家面、国界与经纬线，适合全球低缩放检查。', usage: '全球仅 z0–6；演示数据，城市高度不含详细建筑和道路。' },
  { id: 'osm', name: 'OSMF · Shortbread Colorful', provider: 'OSMF', url: 'https://vector.openstreetmap.org/styles/shortbread/colorful.json', credit: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', description: 'OSMF 官方 Shortbread 全球地图样式。', usage: '全球 z0–14；遵循 OSMF 缓存政策，禁止预抓取与离线批量下载；无 SLA。' },
  { id: 'basemap-world', name: 'BKG · basemap.world', provider: 'BKG', url: 'https://sgx.geodatenzentrum.de/gdz_basemapworld_vektor/styles/bm_web_wld_col.json', credit: '© basemap.de / <a href="https://www.bkg.bund.de/">BKG</a> 2026 <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · 数据来源：© GeoBasis-DE / BKG · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a>', description: '完整双源全球地图：德国官方数据与世界 OSM 数据。', usage: '全球 z0–14，德国 z0–15；服务 CC BY 4.0，世界数据库 ODbL；保留完整署名。' },
  { id: 'waymorphic', name: 'Waymorphic · 简洁矢量', provider: 'Waymorphic', url: new URL('./styles/waymorphic.json', import.meta.url).href, credit: '© <a href="https://waymorphic.com/">Waymorphic</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', description: '明确维护的 OpenMapTiles 简洁矢量样式。', usage: '全球 z0–14；免密钥，可商用；保留署名，禁止整星球抓取；无 SLA。' },
  { id: 'maptoolkit', name: 'Maptoolkit · 简洁矢量', provider: 'Maptoolkit', url: new URL('./styles/maptoolkit.json', import.meta.url).href, credit: '<a href="https://www.maptoolkit.com/copyright/"><img src="https://www.maptoolkit.org/assets/maptoolkit-attribution.png" alt="Maptoolkit" height="24" style="height:24px;width:auto;vertical-align:middle"></a> © <a href="https://www.maptoolkit.com/copyright/">Maptoolkit</a> © <a href="https://www.openstreetmap.org/copyright">Openstreetmap</a>', description: '明确维护的 Maptoolkit schema 简洁矢量样式，无 DEM 或 hillshade。', usage: '全球 z0–15；Community 资格限定的开源、非商或小型组织；必须展示 logo 与署名；禁止批量、离线和固定媒体输出。' },
  { id: 'osm-us', name: 'OSM US · 简洁矢量', provider: 'OSM US', url: new URL('./styles/osm-us.json', import.meta.url).href, credit: 'Tiles by <a href="https://tiles.openstreetmap.us/">OSM US</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', description: '明确维护的 OpenMapTiles 简洁矢量样式。', usage: '全球 z0–14；匿名 Starter Tier 仅低量非营收用途，localhost 可开发；营收用途需书面许可；禁止批量离线下载。' },
  { id: 'buildings', name: 'OpenFreeMap · 建筑白模', provider: 'OpenFreeMap', url: new URL('./styles/buildings.json', import.meta.url).href, credit: openFreeMapCredit, description: '白色建筑挤出，直接读取 render_height / render_min_height；用于超低高度深度精度和瓦片接缝检查。', usage: openFreeMapUsage },
] as const;

export const cityPresets = [
  { id: 'shanghai', name: '上海', longitude: 121.454, latitude: 31.258, scale: 1 },
  { id: 'london', name: '伦敦', longitude: -0.1276, latitude: 51.5072, scale: 1 },
  { id: 'newYork', name: '纽约', longitude: -74.006, latitude: 40.7128, scale: 1.5 },
  { id: 'tokyo', name: '东京', longitude: 139.6917, latitude: 35.6895, scale: 1 },
  { id: 'hongKong', name: '香港', longitude: 114.17, latitude: 22.29, scale: 1 },
  { id: 'amsterdam', name: '阿姆斯特丹', longitude: 4.895, latitude: 52.37, scale: 1 },
  { id: 'alps', name: '阿尔卑斯', longitude: 8.05, latitude: 46.58, scale: 60 },
  { id: 'beibu', name: '北部湾', longitude: 109.12, latitude: 21.03, scale: 30 },
  { id: 'antimeridian', name: '日期变更线', longitude: 179.98, latitude: -16.5, scale: 6 },
  { id: 'world', name: '全球', longitude: 0, latitude: 20, scale: 1800 },
] as const;

/** Camera heights are metres above the WGS84 ellipsoid, independent of tile zoom. */
export const scenarioPresets = [
  { id: 'manhattan', name: '曼哈顿 · 低空白模', longitude: -74.01192337274551, latitude: 40.70752701473173, height: 60, heading: 32, pitch: -12, styleId: 'buildings', description: '沿 Broadway 道路中心看向密集建筑，检查近裁剪面和遮挡；可降至 15 米观察街道。' },
  { id: 'hong-kong', name: '香港中环 · 高楼密集', longitude: 114.1578, latitude: 22.2797, height: 120, heading: 70, pitch: -18, styleId: 'buildings', description: '高楼与海岸交界，检查侧墙、透明度、瓦片接缝与近距离拾取。' },
  { id: 'shinjuku', name: '东京新宿 · 高负载', longitude: 139.7005, latitude: 35.6905, height: 1500, heading: 15, pitch: -45, styleId: 'liberty', description: '密集路网、铁路、多层符号和建筑，观察帧率与缩放重绘。' },
  { id: 'london', name: '伦敦桥 · 接缝与标注', longitude: -0.0863, latitude: 51.5078, height: 900, heading: 110, pitch: -35, styleId: 'osm', description: '河流、桥梁与路网交叉，检查线连接、标注碰撞和瓦片交接。' },
  { id: 'shanghai', name: '上海陆家嘴 · 低空白模', longitude: 121.5013, latitude: 31.237, height: 120, heading: 220, pitch: -15, styleId: 'buildings', description: '高楼、河岸与近水平相机；建筑高度取自数据，不补造缺失高度。' },
  { id: 'amsterdam', name: '阿姆斯特丹 · 密集小建筑', longitude: 4.8954, latitude: 52.3728, height: 350, heading: 60, pitch: -40, styleId: 'buildings', description: '大量小建筑、运河与复杂轮廓，检查几何构建和 GPU 上传。' },
  { id: 'san-francisco', name: '旧金山 · 长距离斜视', longitude: -122.4098, latitude: 37.791, height: 700, heading: 75, pitch: -12, styleId: 'versatiles', description: '远近瓦片混合和地平线附近细节，检查覆盖、裁剪与 LOD。' },
  { id: 'paris', name: '巴黎 · 复杂路口与小建筑', longitude: 2.2951, latitude: 48.8738, height: 900, heading: 135, pitch: -45, styleId: 'osm', description: '放射状路口、连续街区与密集标签，检查线连接、轮廓和标注碰撞。' },
  { id: 'sao-paulo', name: '圣保罗 · 大片密集城区', longitude: -46.6559, latitude: -23.5614, height: 1500, heading: 50, pitch: -35, styleId: 'liberty', description: '南半球高密度城区与长距离可见路网，检查瓦片调度、上传负载和缩放交接。' },
  { id: 'sydney', name: '悉尼港 · 海岸与跨水桥梁', longitude: 151.2108, latitude: -33.8588, height: 1500, heading: 75, pitch: -30, styleId: 'bright', description: '曲折海岸、岛屿与桥梁，检查多环多边形、道路接缝和远近瓦片覆盖。' },
  { id: 'cape-town', name: '开普敦 · 城区与海岸交界', longitude: 18.4241, latitude: -33.9249, height: 1500, heading: 300, pitch: -30, styleId: 'versatiles', description: '非洲城区、港口与海岸，检查全球数据 schema、标签和斜视覆盖。' },
  { id: 'dateline', name: '斐济 · 日期变更线', longitude: 179.99, latitude: -16.8, height: 45000, heading: 90, pitch: -70, styleId: 'bright', description: '跨 ±180° 平移和缩放，检查瓦片 wrap、线条和相机边界。' },
] as const;

export function readDemoSelection(parameters: URLSearchParams): DemoSelection {
  const scenario = scenarioPresets.find(preset => preset.id === parameters.get('scenario'));
  const positiveNumber = (key: string, fallback: number) => {
    const value = Number(parameters.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    source: parameters.get('source') ?? scenario?.styleId ?? 'liberty',
    style: parameters.get('style') ?? '',
    view: parameters.get('view') ?? 'shanghai',
    mode: parameters.get('mode') ?? '3d',
    angle: parameters.get('angle') ?? 'top',
    scenario: scenario?.id ?? '',
    height: positiveNumber('height', scenario?.height ?? 60),
    scale: parameters.has('scale') ? positiveNumber('scale', 1) : undefined,
    resolutionRatio: positiveNumber('resolutionRatio', 1),
  };
}

export function demoMapConfig(selection: Pick<DemoSelection, 'source' | 'style'>): DemoMapConfig {
  const preset = stylePresets.find(preset => preset.id === selection.source) ?? stylePresets[0];
  return { url: selection.style || preset.url, credit: selection.style ? '' : preset.credit, options: tilesetOptions };
}

export function demoCameraConfig(selection: DemoSelection) {
  const mode = modePresets.find(preset => preset.id === selection.mode) ?? modePresets[0];
  const scenario = scenarioPresets.find(preset => preset.id === selection.scenario);
  if (scenario) {
    return {
      mode,
      view: {
        destination: Cartesian3.fromDegrees(scenario.longitude, scenario.latitude, selection.height),
        orientation: { heading: CesiumMath.toRadians(scenario.heading), pitch: CesiumMath.toRadians(scenario.pitch), roll: 0 },
      },
    };
  }
  const city = cityPresets.find(preset => preset.id === selection.view) ?? cityPresets[0];
  const size = selection.scale ?? city.scale;
  const angle = anglePresets.find(preset => preset.id === selection.angle) ?? anglePresets[0];
  if (mode.value !== SceneMode.SCENE2D && angle.id !== 'top') {
    return {
      mode,
      sphere: new BoundingSphere(Cartesian3.fromDegrees(city.longitude, city.latitude), size * 2500),
      offset: new HeadingPitchRange(CesiumMath.toRadians(35), CesiumMath.toRadians(angle.pitch), size * 8000),
    };
  }
  return {
    mode,
    view: {
      destination: Rectangle.fromDegrees(
        city.longitude - 0.0375 * size,
        Math.max(-85, city.latitude - 0.01575 * size),
        city.longitude + 0.0375 * size,
        Math.min(85, city.latitude + 0.01575 * size),
      ),
    },
  };
}

export function demoSearchParameters(selection: DemoSelection): URLSearchParams {
  const parameters = new URLSearchParams({ source: selection.source, view: selection.view, mode: selection.mode, angle: selection.angle });
  if (selection.style)
    parameters.set('style', selection.style);
  if (selection.scenario) {
    parameters.set('scenario', selection.scenario);
    parameters.set('height', String(selection.height));
  }
  if (selection.scale !== undefined)
    parameters.set('scale', String(selection.scale));
  if (selection.resolutionRatio !== 1)
    parameters.set('resolutionRatio', String(selection.resolutionRatio));
  return parameters;
}
