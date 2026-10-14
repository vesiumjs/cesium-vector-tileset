<script setup lang="ts">
import type { Scene } from 'cesium';
import type { CesiumVectorTileset } from 'cesium-vector-tileset';
import { ref, shallowRef, watch } from 'vue';

const props = defineProps<{ scene: Scene; tileset?: CesiumVectorTileset }>();
const stats = shallowRef<ReturnType<CesiumVectorTileset['stats']>>();
const renderMilliseconds = ref<number>();

watch([() => props.scene, () => props.tileset], ([scene, tileset], _previous, onCleanup) => {
  stats.value = undefined;
  renderMilliseconds.value = undefined;
  const frames: number[] = [];
  let renderStart = 0;
  let lastSample = -Infinity;

  // Measure only rendered frames, using Cesium's public events. This is CPU
  // wall time for the whole scene between preUpdate/postRender, not GPU time.
  onCleanup(scene.preUpdate.addEventListener(() => renderStart = performance.now()));
  onCleanup(scene.postRender.addEventListener(() => {
    const now = performance.now();
    frames.push(now - renderStart);
    if (frames.length > 60)
      frames.shift();
    // Sample the scene's resident workload; never wake an idle scene for UI.
    if (now - lastSample < 500)
      return;
    lastSample = now;
    stats.value = tileset?.stats();
    renderMilliseconds.value = frames.reduce((sum, duration) => sum + duration, 0) / frames.length;
  }));
}, { immediate: true });
</script>

<template>
  <dl class="performance" aria-label="性能数据" data-testid="performance-readout">
    <div title="最近一次更新中可渲染的瓦片数，包含覆盖当前视图的父级回退瓦片">
      <dt>可渲染瓦片</dt>
      <dd>{{ stats?.renderableTiles ?? '—' }}</dd>
    </div>
    <div title="当前场景驻留的实色面、线、圆点和建筑集合数；一个批次可以包含多个地物，不等于地物数量">
      <dt>矢量批次</dt>
      <dd>{{ stats?.bucket.collections ?? '—' }}</dd>
    </div>
    <div title="当前场景驻留的文字和图标绘制批次数，不等于标签数量">
      <dt>符号批次</dt>
      <dd>{{ stats?.symbol.primitives ?? '—' }}</dd>
    </div>
    <div title="此 tileset 的瓦片驻留显存估算，包含缓存瓦片，不包含整个 Cesium 场景的显存">
      <dt>瓦片显存</dt>
      <dd>{{ stats ? `${(stats.gpuMemory.totalBytes / 1024 / 1024).toFixed(1)} MB` : '—' }}</dd>
    </div>
    <div title="整个 Cesium 场景 preUpdate 到 postRender 的 CPU 耗时，最近至多 60 个实际渲染帧的均值；不含 GPU 执行耗时">
      <dt>场景 CPU</dt>
      <dd>{{ renderMilliseconds === undefined ? '—' : `${renderMilliseconds.toFixed(1)} ms` }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.performance {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--demo-border);
  margin: 0;
  font-variant-numeric: tabular-nums;
}
dt {
  color: var(--demo-muted);
  font-size: 11px;
}
dd {
  margin: 0;
}
</style>
