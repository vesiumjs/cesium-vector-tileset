<script setup lang="ts">
import type { DemoSelection } from './demo-selection';
import { ref, watch } from 'vue';
import { createDemoSelection } from './demo-selection';
import { demoPresets, modeOptions, stylePresets } from './preset-catalog';

defineProps<{ hasTileset: boolean; loading: boolean }>();
const emit = defineEmits<{ add: []; remove: [] }>();
const selection = defineModel<DemoSelection>({ required: true });
const customStyleInput = ref(selection.value.style);

watch(() => selection.value.style, style => customStyleInput.value = style);

function selectPreset(): void {
  Object.assign(selection.value, createDemoSelection(selection.value.preset), { resolutionRatio: selection.value.resolutionRatio });
  customStyleInput.value = '';
}

function selectSource(): void {
  selection.value.style = customStyleInput.value = '';
}
</script>

<template>
  <aside class="controls" aria-label="地图预设">
    <label>
      预设
      <select v-model="selection.preset" data-testid="preset-select" @change="selectPreset">
        <option v-for="item in demoPresets" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
    </label>
    <label>
      矢量地图
      <select v-model="selection.source" data-testid="source-select" @change="selectSource">
        <option v-for="item in stylePresets" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
    </label>
    <label>
      视图
      <select v-model="selection.mode" data-testid="scene-select">
        <option v-for="item in modeOptions" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
    </label>
    <slot name="camera" />
    <details>
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
      当前使用自定义样式
    </p>
    <div class="actions">
      <button data-testid="add-tileset" :disabled="loading" @click="emit('add')">
        添加
      </button>
      <button data-testid="remove-tileset" :disabled="!hasTileset && !loading" @click="emit('remove')">
        移除
      </button>
      <a href="https://github.com/vesiumjs/cesium-vector-tileset/blob/main/README.zh-CN.md" target="_blank" rel="noreferrer">使用说明</a>
      <a href="https://github.com/vesiumjs/cesium-vector-tileset/issues" target="_blank" rel="noreferrer">反馈</a>
    </div>
    <slot />
  </aside>
</template>

<style scoped>
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
  margin-bottom: 8px;
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
button,
summary {
  cursor: pointer;
}
button:hover {
  background: #365b7a;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
button:focus-visible,
select:focus-visible,
input:focus-visible,
summary:focus-visible,
a:focus-visible {
  outline: 2px solid #7dd3fc;
  outline-offset: 2px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 12px;
}
details {
  margin-top: 10px;
}
.hint {
  color: #b9c7d6;
  margin: 8px 0;
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
a {
  color: #7dd3fc;
}
</style>
