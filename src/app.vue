<script setup lang="ts">
import type { SceneMode } from 'cesium';
import { BoundingSphere, Cartesian3, Math as CesiumMath, SceneMode as CesiumSceneMode, HeadingPitchRange, Rectangle } from 'cesium';
import { computed, onMounted, onUnmounted, ref, shallowRef, useTemplateRef } from 'vue';
import { cityPresets, scenarioPresets, stylePresets } from './presets';
import { SceneView } from './scene-view';
import TilesetLayer from './tileset-layer.vue';

const parameters = new URLSearchParams(window.location.search);
const container = useTemplateRef('container');
const sceneView = shallowRef<SceneView>();
const error = ref<string>();
const styleId = ref(parameters.get('source') ?? 'liberty');
const customStyle = ref(parameters.get('style') ?? '');
const customStyleInput = ref(customStyle.value);
const cityId = ref(parameters.get('view') ?? 'shanghai');
const sceneMode = ref(parameters.get('mode') ?? '3d');
const angle = ref(parameters.get('angle') ?? 'top');
const scenarioId = ref(parameters.get('scenario') ?? '');
const scenario = computed(() => scenarioPresets.find(preset => preset.id === scenarioId.value));
const initialHeight = Number(parameters.get('height'));
const cameraHeight = ref(initialHeight > 0 && Number.isFinite(initialHeight) ? initialHeight : scenario.value?.height ?? 60);
const heightOptions = computed(() => [...new Set([15, 60, 120, 250, 350, 700, 900, 1500, 45000, cameraHeight.value])].sort((a, b) => a - b));
const reload = ref(0);
const stylePreset = computed(() => stylePresets.find(preset => preset.id === styleId.value) ?? stylePresets[0]);
const styleUrl = computed(() => customStyle.value || stylePreset.value.url);

if (!parameters.has('source') && scenario.value)
  styleId.value = scenario.value.styleId;

function updateDemoUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('source', styleId.value);
  url.searchParams.set('view', cityId.value);
  url.searchParams.set('mode', sceneMode.value);
  url.searchParams.set('angle', angle.value);
  if (scenario.value) {
    url.searchParams.set('scenario', scenario.value.id);
    url.searchParams.set('height', String(cameraHeight.value));
  }
  else {
    url.searchParams.delete('scenario');
    url.searchParams.delete('height');
  }
  if (customStyle.value)
    url.searchParams.set('style', customStyle.value);
  else url.searchParams.delete('style');
  window.history.replaceState(null, '', url);
}

function selectStyle(): void {
  customStyle.value = '';
  customStyleInput.value = '';
  if (styleId.value === 'world')
    selectCity('world');
  else updateDemoUrl();
}

function loadCustomStyle(): void {
  try {
    const url = new URL(customStyleInput.value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('样式地址需要使用 HTTP 或 HTTPS');
    customStyle.value = url.href;
    error.value = undefined;
    updateDemoUrl();
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function selectCity(id: string, animate = true): void {
  scenarioId.value = '';
  const city = cityPresets.find(preset => preset.id === id) ?? cityPresets[0];
  cityId.value = city.id;
  const scale = !animate ? Number(parameters.get('scale') ?? city.scale) : city.scale;
  const size = Number.isFinite(scale) && scale > 0 ? scale : city.scale;
  const destination = Rectangle.fromDegrees(
    city.longitude - 0.0375 * size,
    Math.max(-85, city.latitude - 0.01575 * size),
    city.longitude + 0.0375 * size,
    Math.min(85, city.latitude + 0.01575 * size),
  );
  const camera = sceneView.value?.scene.camera;
  camera?.cancelFlight();
  if (sceneMode.value !== '2d' && angle.value !== 'top') {
    camera?.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(city.longitude, city.latitude), size * 2500), {
      duration: animate ? 0.8 : 0,
      offset: new HeadingPitchRange(CesiumMath.toRadians(35), CesiumMath.toRadians(angle.value === 'oblique' ? -45 : -20), size * 8000),
    });
  }
  else if (animate) {
    camera?.flyTo({ destination, duration: 0.8 });
  }
  else {
    camera?.setView({ destination });
  }
  updateDemoUrl();
}

function applyScenarioCamera(animate = true): void {
  const preset = scenario.value;
  const camera = sceneView.value?.scene.camera;
  if (!preset || !camera)
    return;
  const options = {
    destination: Cartesian3.fromDegrees(preset.longitude, preset.latitude, cameraHeight.value),
    orientation: { heading: CesiumMath.toRadians(preset.heading), pitch: CesiumMath.toRadians(preset.pitch), roll: 0 },
  };
  camera.cancelFlight();
  if (animate)
    camera.flyTo({ ...options, duration: 0.8 });
  else camera.setView(options);
  updateDemoUrl();
}

function selectScenario(): void {
  const preset = scenario.value;
  if (!preset)
    return;
  cityId.value = '';
  cameraHeight.value = preset.height;
  sceneMode.value = '3d';
  sceneView.value?.scene.camera.cancelFlight();
  sceneView.value?.scene.morphTo3D(0);
  styleId.value = preset.styleId;
  customStyle.value = '';
  applyScenarioCamera();
}

function selectMode(): void {
  const scene = sceneView.value?.scene;
  if (!scene)
    return;
  scene.camera.cancelFlight();
  if (sceneMode.value === '2d')
    scene.morphTo2D(0);
  else if (sceneMode.value === 'cv')
    scene.morphToColumbusView(0);
  else scene.morphTo3D(0);
  if (scenario.value)
    applyScenarioCamera(false);
  else selectCity(cityId.value, false);
}

onMounted(() => {
  try {
    const mode: SceneMode = sceneMode.value === '2d'
      ? CesiumSceneMode.SCENE2D
      : sceneMode.value === 'cv' ? CesiumSceneMode.COLUMBUS_VIEW : CesiumSceneMode.SCENE3D;
    sceneView.value = new SceneView(container.value!, {
      sceneMode: mode,
      resolutionRatio: parameters.has('resolutionRatio') ? Number(parameters.get('resolutionRatio')) : 1,
      onError: (cause) => {
        error.value = cause instanceof Error ? cause.message : String(cause);
        sceneView.value = undefined;
      },
    });
    if (scenario.value)
      applyScenarioCamera(false);
    else selectCity(cityId.value, false);
  }
  catch (cause) {
    sceneView.value?.destroy();
    sceneView.value = undefined;
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});

onUnmounted(() => {
  sceneView.value?.destroy();
});
</script>

<template>
  <div ref="container" class="map" />
  <aside class="controls" aria-label="地图预设">
    <label>
      矢量地图
      <select v-model="styleId" data-testid="source-select" @change="selectStyle">
        <option v-for="preset in stylePresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
    </label>
    <div class="cities" aria-label="城市场景">
      <button v-for="city in cityPresets" :key="city.id" :data-testid="`city-${city.id}`" :aria-pressed="!scenarioId && cityId === city.id" @click="selectCity(city.id)">
        {{ city.name }}
      </button>
    </div>
    <label class="angle">
      压力场景
      <select v-model="scenarioId" data-testid="scenario-select" @change="selectScenario">
        <option value="">选择场景</option>
        <option v-for="preset in scenarioPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
    </label>
    <template v-if="scenario">
      <p class="hint">
        {{ scenario.description }}
      </p>
      <label class="angle">
        {{ sceneMode === '2d' ? '视野尺度（米）' : '相机高度（椭球面）' }}
        <select v-model="cameraHeight" data-testid="height-select" @change="applyScenarioCamera()">
          <option v-for="height in heightOptions" :key="height" :value="height">{{ height }} 米</option>
        </select>
      </label>
    </template>
    <div class="actions">
      <label>
        视图
        <select v-model="sceneMode" data-testid="scene-select" @change="selectMode">
          <option value="3d">3D</option>
          <option value="2d">2D</option>
          <option value="cv">Columbus</option>
        </select>
      </label>
      <button data-testid="reload-style" @click="reload++">
        重新加载
      </button>
    </div>
    <p v-if="scenario" class="hint" data-testid="scenario-angle">
      <template v-if="sceneMode === '2d'">
        2D 俯视
      </template>
      <template v-else>
        朝向 {{ scenario.heading }}° · 俯角 {{ -scenario.pitch }}°
      </template>
    </p>
    <label v-else class="angle">
      相机角度
      <select v-model="angle" data-testid="angle-select" :disabled="sceneMode === '2d'" @change="selectCity(cityId)">
        <option value="top">俯视</option>
        <option value="oblique">斜视 45°</option>
        <option value="horizon">低角度 20°</option>
      </select>
    </label>
    <details class="angle">
      <summary>自定义 Style JSON 地址</summary>
      <form class="custom-style" @submit.prevent="loadCustomStyle">
        <input v-model="customStyleInput" type="url" required aria-label="Style JSON 地址" placeholder="https://…/style.json">
        <button type="submit">
          加载
        </button>
      </form>
    </details>
    <p v-if="customStyle" class="hint">
      当前使用链接中的自定义样式
    </p>
    <p v-else-if="styleId === 'world'" class="hint">
      全球概览数据仅到 z6，适合查看国家边界
    </p>
    <p v-else class="hint">
      {{ stylePreset.description }}
    </p>
    <details class="angle">
      <summary>来源与使用条件</summary>
      <p class="hint">
        {{ stylePreset.usage }}
      </p>
    </details>
    <TilesetLayer
      v-if="sceneView"
      :scene="sceneView.scene"
      :credit-display="sceneView.creditDisplay"
      :style-url="styleUrl"
      :credit-html="customStyle ? '' : stylePreset.credit"
      :reload="reload"
    />
    <p v-if="error" role="alert">
      {{ error }}
    </p>
  </aside>
</template>

<style scoped>
.map {
  position: absolute;
  inset: 0;
}
.controls {
  position: absolute;
  top: 16px;
  left: 16px;
  width: min(310px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 14px;
  border: 1px solid #ffffff26;
  border-radius: 10px;
  background: #18212ded;
  color: #edf2f7;
  font:
    13px/1.5 system-ui,
    sans-serif;
  box-shadow: 0 4px 24px #0004;
}
label {
  display: flex;
  align-items: center;
  gap: 10px;
}
select {
  flex: 1;
  min-width: 0;
}
select,
button,
input {
  padding: 6px 8px;
  border: 1px solid #ffffff30;
  border-radius: 5px;
  background: #263445;
  color: inherit;
  font: inherit;
}
button {
  cursor: pointer;
}
button:hover,
button[aria-pressed='true'] {
  background: #365b7a;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid #7dd3fc;
  outline-offset: 2px;
}
.cities {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0;
}
.actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.angle {
  margin-top: 10px;
}
.hint {
  color: #b9c7d6;
  margin-bottom: 0;
}
.custom-style {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
input {
  min-width: 0;
  flex: 1;
}
</style>
