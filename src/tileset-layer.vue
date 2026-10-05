<script setup lang="ts">
import type { CreditDisplay, Scene } from 'cesium';
import { Credit } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';
import { onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  scene: Scene;
  creditDisplay: CreditDisplay;
  styleUrl: string;
  creditHtml: string;
  reload: number;
}>();
const error = ref('');
const loading = ref(true);
const status = ref('正在加载地图');
let active: CesiumVectorTileset | undefined;
let removeActiveError: (() => void) | undefined;
const creditListeners = new WeakMap<CesiumVectorTileset, () => void>();

function removeTileset(tileset: CesiumVectorTileset | undefined): void {
  if (!tileset)
    return;
  creditListeners.get(tileset)?.();
  creditListeners.delete(tileset);
  if (!props.scene.isDestroyed() && props.scene.primitives.remove(tileset))
    props.scene.requestRender();
  if (!tileset.isDestroyed())
    tileset.destroy();
}

watch(() => [props.styleUrl, props.creditHtml, props.reload] as const, async ([url, creditHtml], _previous, onCleanup) => {
  const controller = new AbortController();
  const scene = props.scene;
  let candidate: CesiumVectorTileset | undefined;
  let removeFrame: (() => void) | undefined;
  let removeError: (() => void) | undefined;
  onCleanup(() => {
    controller.abort();
    removeFrame?.();
    removeError?.();
    removeTileset(candidate);
  });
  loading.value = true;
  error.value = '';
  status.value = active ? '正在切换地图' : '正在加载地图';
  try {
    candidate = await CesiumVectorTileset.fromUrl(url, { scene, signal: controller.signal });
    controller.signal.throwIfAborted();
    removeError = candidate.errorEvent.addEventListener((cause) => {
      if (controller.signal.aborted || !candidate) {
        return;
      }
      error.value = cause.message;
      loading.value = false;
      controller.abort();
      removeFrame?.();
      removeFrame = undefined;
      removeError?.();
      removeError = undefined;
      const failed = candidate;
      candidate = undefined;
      removeTileset(failed);
      status.value = active ? '保留上一次地图' : '地图加载失败';
      scene.requestRender();
    });
    await candidate.whenReady();
    controller.signal.throwIfAborted();
    if (scene.isDestroyed()) {
      controller.abort();
      removeTileset(candidate);
      candidate = undefined;
      return;
    }
    scene.primitives.add(candidate);
    if (creditHtml) {
      const credit = new Credit(creditHtml, true);
      // Native credits deduplicate equal notices across active and candidate.
      // postRender runs after beginFrame and before CreditDisplay.endFrame.
      creditListeners.set(candidate, scene.postRender.addEventListener(() => {
        props.creditDisplay.addCreditToNextFrame(credit);
      }));
    }
    // The old map keeps covering the viewport while the next map prepares.
    // Style readiness alone does not imply that a single tile was drawn.
    removeFrame = scene.postRender.addEventListener(() => {
      if (!candidate)
        return;
      if (!candidate.tilesLoaded)
        return;
      removeFrame?.();
      removeFrame = undefined;
      removeError?.();
      removeError = undefined;
      removeActiveError?.();
      removeTileset(active);
      active = candidate;
      candidate = undefined;
      removeActiveError = active.errorEvent.addEventListener((cause) => {
        error.value = cause.message;
        status.value = '部分地图数据加载失败';
      });
      loading.value = false;
      error.value = '';
      status.value = '地图已加载';
    });
    scene.requestRender();
  }
  catch (cause) {
    removeError?.();
    removeTileset(candidate);
    candidate = undefined;
    if (controller.signal.aborted)
      return;
    loading.value = false;
    error.value = cause instanceof Error ? cause.message : String(cause);
    status.value = active ? '保留上一次地图' : '地图加载失败';
  }
}, { immediate: true });

onBeforeUnmount(() => {
  removeActiveError?.();
  removeTileset(active);
});
</script>

<template>
  <p class="status" data-testid="tileset-status" role="status" :aria-busy="loading">
    {{ status }}
  </p>
  <p v-if="error" class="error" role="alert">
    {{ error }}
  </p>
</template>

<style scoped>
.status {
  margin: 12px 0 0;
  color: #b9c7d6;
}
.error {
  margin: 8px 0 0;
  color: #fca5a5;
  overflow-wrap: anywhere;
}
</style>
