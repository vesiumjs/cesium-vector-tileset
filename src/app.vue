<script setup lang="ts">
import { CesiumWidget } from 'cesium';
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { anglePresets, cityPresets, demoCameraConfig, demoMapConfig, demoSearchParameters, heightPresets, modePresets, readDemoSelection, scenarioPresets, sceneOptions, stylePresets, widgetOptions } from './demo-config';
import TilesetLayer from './tileset-layer.vue';

const container = useTemplateRef('container');
const widget = shallowRef<CesiumWidget>();
const selection = reactive(readDemoSelection(new URLSearchParams(window.location.search)));
const error = ref('');
const customStyleInput = ref(selection.style);
const reload = ref(0);
const mapConfig = computed(() => demoMapConfig(selection));
const cameraConfig = computed(() => demoCameraConfig(selection));
const scenario = computed(() => scenarioPresets.find(preset => preset.id === selection.scenario));
const stylePreset = computed(() => stylePresets.find(preset => preset.id === selection.source) ?? stylePresets[0]);
const heightOptions = computed(() => [...new Set([...heightPresets, selection.height])].sort((a, b) => a - b));

function selectStyle(): void {
  selection.style = customStyleInput.value = '';
  if (selection.source === 'world')
    selectCity('world');
}

function selectCity(id: string): void {
  Object.assign(selection, { view: id, scenario: '', scale: undefined });
}

function selectScenario(): void {
  if (scenario.value) {
    Object.assign(selection, { view: '', height: scenario.value.height, mode: '3d', source: scenario.value.styleId, style: '' });
    customStyleInput.value = '';
  }
}

watch([widget, cameraConfig], ([current, config], previous) => {
  if (!current)
    return;
  const scene = current.scene;
  const duration = previous[0] && scene.mode === config.mode.value ? 0.8 : 0;
  scene.camera.cancelFlight();
  if (scene.mode !== config.mode.value)
    scene[config.mode.morph](0);
  if (config.sphere)
    scene.camera.flyToBoundingSphere(config.sphere, { offset: config.offset, duration });
  else scene.camera.flyTo({ ...config.view, duration });
});

watch(() => demoSearchParameters(selection).toString(), (search) => {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.replaceState(null, '', url);
}, { immediate: true });

onMounted(() => {
  try {
    widget.value = new CesiumWidget(container.value!, { ...widgetOptions, sceneMode: cameraConfig.value.mode.value });
    widget.value.resolutionScale = selection.resolutionRatio;
    Object.assign(widget.value.scene, sceneOptions);
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});

onUnmounted(() => widget.value?.destroy());
</script>

<template>
  <div ref="container" class="map" />
  <aside class="controls" aria-label="地图预设">
    <label>
      矢量地图
      <select v-model="selection.source" data-testid="source-select" @change="selectStyle">
        <option v-for="preset in stylePresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
    </label>
    <div class="cities" aria-label="城市场景">
      <button v-for="city in cityPresets" :key="city.id" :data-testid="`city-${city.id}`" :aria-pressed="!selection.scenario && selection.view === city.id" @click="selectCity(city.id)">
        {{ city.name }}
      </button>
    </div>
    <label class="angle">
      压力场景
      <select v-model="selection.scenario" data-testid="scenario-select" @change="selectScenario">
        <option value="">选择场景</option>
        <option v-for="preset in scenarioPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
    </label>
    <template v-if="scenario">
      <p class="hint">
        {{ scenario.description }}
      </p>
      <label class="angle">
        {{ selection.mode === '2d' ? '视野尺度（米）' : '相机高度（椭球面）' }}
        <select v-model="selection.height" data-testid="height-select">
          <option v-for="height in heightOptions" :key="height" :value="height">{{ height }} 米</option>
        </select>
      </label>
    </template>
    <div class="actions">
      <label>
        视图
        <select v-model="selection.mode" data-testid="scene-select">
          <option v-for="preset in modePresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
        </select>
      </label>
      <button data-testid="reload-style" @click="reload++">
        重新加载
      </button>
    </div>
    <p v-if="scenario" class="hint" data-testid="scenario-angle">
      <template v-if="selection.mode === '2d'">
        2D 俯视
      </template>
      <template v-else>
        朝向 {{ scenario.heading }}° · 俯角 {{ -scenario.pitch }}°
      </template>
    </p>
    <label v-else class="angle">
      相机角度
      <select v-model="selection.angle" data-testid="angle-select" :disabled="selection.mode === '2d'">
        <option v-for="preset in anglePresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
    </label>
    <details class="angle">
      <summary>自定义 Style JSON 地址</summary>
      <form class="custom-style" @submit.prevent="selection.style = customStyleInput">
        <input
          v-model="customStyleInput"
          type="url"
          pattern="https?://.*"
          required
          aria-label="Style JSON 地址"
          placeholder="https://…/style.json"
        >
        <button type="submit">
          加载
        </button>
      </form>
    </details>
    <p v-if="selection.style" class="hint">
      当前使用链接中的自定义样式
    </p>
    <p v-else-if="selection.source === 'world'" class="hint">
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
      v-if="widget"
      :scene="widget.scene"
      :credit-display="widget.creditDisplay"
      :config="mapConfig"
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
