<script setup lang="ts">
import { CesiumWidget, Credit } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import CameraReadout from './demo/camera-readout.vue';
import ConfigPanel from './demo/config-panel.vue';
import { demoMapConfig, demoSearchParameters, readDemoSelection } from './demo/demo-selection';
import PerformanceReadout from './demo/performance-readout.vue';
import { demoCameraConfig, widgetOptions } from './demo/scene-config';

const container = useTemplateRef<HTMLDivElement>('container');
const selection = ref(readDemoSelection(new URLSearchParams(location.search)));
const widget = shallowRef<CesiumWidget>();
const tileset = shallowRef<CesiumVectorTileset>();
const error = ref('');
const loading = ref(false);
const mapConfig = computed(() => demoMapConfig(selection.value));
const cameraConfig = computed(() => demoCameraConfig(selection.value));
let loadController: AbortController | undefined;
let credit: Credit | undefined;
let removeError: (() => void) | undefined;
let removeFrame: (() => void) | undefined;

function removeTileset(): void {
  loadController?.abort();
  loadController = undefined;
  removeError?.();
  removeError = undefined;
  if (tileset.value)
    widget.value!.scene.primitives.remove(tileset.value);
  tileset.value = undefined;
  if (credit)
    widget.value!.creditDisplay.removeStaticCredit(credit);
  credit = undefined;
  loading.value = false;
  error.value = '';
}

async function addTileset(): Promise<void> {
  if (!widget.value)
    return;
  loadController?.abort();
  const controller = loadController = new AbortController();
  const config = mapConfig.value;
  loading.value = true;
  error.value = '';
  let candidate: CesiumVectorTileset | undefined;
  try {
    // Pass cancellation to the SDK; superseded loads must stop their own work.
    candidate = await CesiumVectorTileset.fromUrl(config.url, { signal: controller.signal });
    controller.signal.throwIfAborted();
    loadController = undefined;
    removeTileset();
    tileset.value = widget.value.scene.primitives.add(candidate);
    removeError = candidate.errorEvent.addEventListener((cause) => {
      error.value = cause.message;
      loading.value = false;
    });
    if (config.credit) {
      credit = new Credit(config.credit, true);
      widget.value.creditDisplay.addStaticCredit(credit);
    }
    loading.value = !candidate.tilesLoaded;
  }
  catch (cause) {
    if (!controller.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      loading.value = false;
    }
  }
  finally {
    if (loadController === controller)
      loadController = undefined;
    if (candidate && candidate !== tileset.value && !candidate.isDestroyed())
      candidate.destroy();
  }
}

// Style and camera depend on separate selection fields: changing a scene
// moves only the camera; changing a style replaces only the tileset.
watch([widget, mapConfig], () => void addTileset());
watch([widget, cameraConfig], ([current, config], previous) => {
  if (!current)
    return;
  const scene = current.scene;
  const duration = previous[0] && scene.mode === config.mode.value ? 0.8 : 0;
  scene.camera.cancelFlight();
  if (scene.mode !== config.mode.value)
    scene[config.mode.morph](0);
  scene.camera.flyTo({ destination: config.destination, orientation: config.orientation, duration });
});
watch([widget, () => selection.value.resolutionRatio, () => selection.value.highDpi], ([current, ratio, highDpi]) => {
  if (!current)
    return;
  current.useBrowserRecommendedResolution = !highDpi;
  current.resolutionScale = ratio;
  current.resize();
  current.scene.requestRender();
});
watch(() => demoSearchParameters(selection.value).toString(), (search) => {
  const url = new URL(location.href);
  url.search = search;
  history.replaceState(null, '', url);
}, { immediate: true });

onMounted(() => {
  try {
    const current = new CesiumWidget(container.value!, {
      ...widgetOptions,
      sceneMode: cameraConfig.value.mode.value,
      useBrowserRecommendedResolution: !selection.value.highDpi,
    });
    current.scene.debugShowFramesPerSecond = true;
    widget.value = current;
    removeFrame = current.scene.postRender.addEventListener(() => {
      if (!loadController && !error.value && tileset.value)
        loading.value = !tileset.value.tilesLoaded;
    });
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});
onBeforeUnmount(() => {
  removeTileset();
  removeFrame?.();
});
onUnmounted(() => widget.value?.destroy());
</script>

<template>
  <div ref="container" class="map" />
  <ConfigPanel v-model="selection">
    <template #camera>
      <CameraReadout v-if="widget" :scene="widget.scene" />
    </template>
    <PerformanceReadout v-if="widget" :scene="widget.scene" :tileset="tileset" />
    <p v-if="loading" class="loading" role="status">
      正在加载…
    </p>
    <p v-if="error" role="alert">
      {{ error }}
    </p>
  </ConfigPanel>
</template>

<style>
:root {
  color-scheme: dark;
  --demo-surface: #202830;
  --demo-border: #56606a;
  --demo-text: #eef0f2;
  --demo-muted: #b7bec5;
  --demo-accent: #abd4fb;
  font:
    14px/1.5 system-ui,
    sans-serif;
}
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}
body {
  background: #101b23;
}
button,
select,
input {
  font: inherit;
}
* {
  box-sizing: border-box;
}
</style>

<style scoped>
.map {
  position: fixed;
  inset: 0;
}
.loading,
[role='alert'] {
  margin: 8px 0 0;
  font-size: 12px;
}
.loading {
  color: var(--demo-muted);
}
[role='alert'] {
  color: #ffb0b0;
  overflow-wrap: anywhere;
}
</style>
