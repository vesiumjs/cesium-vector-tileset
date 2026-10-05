<script setup lang="ts">
import type { CreditDisplay, Scene } from 'cesium';
import type { DemoMapConfig } from './demo-config';
import { Credit } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ scene: Scene; creditDisplay: CreditDisplay; config: DemoMapConfig; reload: number }>();
const error = ref('');
const loading = ref(true);
const status = computed(() => error.value ? '地图加载失败' : loading.value ? '正在加载地图' : '地图已加载');
let active: CesiumVectorTileset | undefined;
let credit: Credit | undefined;
let removeError: (() => void) | undefined;
let pending = false;

function removeActive(): void {
  removeError?.();
  if (credit)
    props.creditDisplay.removeStaticCredit(credit);
  if (active)
    props.scene.primitives.remove(active);
  active = undefined;
  credit = undefined;
}

const removeFrame = props.scene.postRender.addEventListener(() => {
  if (!pending && !error.value && active)
    loading.value = !active.tilesLoaded;
});

watch(() => [props.config, props.reload] as const, async ([config], _previous, onCleanup) => {
  const controller = new AbortController();
  let candidate: CesiumVectorTileset | undefined;
  onCleanup(() => {
    controller.abort();
    if (candidate && candidate !== active && !candidate.isDestroyed())
      candidate.destroy();
  });
  pending = loading.value = true;
  error.value = '';
  try {
    candidate = await CesiumVectorTileset.fromUrl(config.url, { ...config.options, signal: controller.signal });
    await candidate.whenReady();
    controller.signal.throwIfAborted();
    removeActive();
    active = props.scene.primitives.add(candidate);
    removeError = active.errorEvent.addEventListener((cause) => {
      error.value = cause.message;
      loading.value = false;
    });
    if (config.credit) {
      credit = new Credit(config.credit, true);
      props.creditDisplay.addStaticCredit(credit);
    }
    props.scene.requestRender();
  }
  catch (cause) {
    if (!controller.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      loading.value = false;
    }
  }
  finally {
    if (!controller.signal.aborted)
      pending = false;
    if (candidate && candidate !== active && !candidate.isDestroyed())
      candidate.destroy();
  }
}, { immediate: true });

onBeforeUnmount(() => {
  removeFrame();
  removeActive();
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
