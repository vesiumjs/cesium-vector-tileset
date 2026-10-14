<script setup lang="ts">
import type { DemoSelection } from './demo-selection';
import { ref, watch } from 'vue';
import { demoPresets, modeOptions, stylePresets } from './preset-catalog';

const selection = defineModel<DemoSelection>({ required: true });
const customStyleInput = ref(selection.value.style);
const controlsOpen = ref(false);

watch(() => selection.value.style, style => customStyleInput.value = style);
</script>

<template>
  <aside class="controls" :data-expanded="controlsOpen" aria-label="地图设置">
    <button
      class="controls-toggle"
      data-testid="controls-toggle"
      :aria-expanded="controlsOpen"
      aria-controls="controls-content"
      @click="controlsOpen = !controlsOpen"
    >
      地图设置 <span>{{ controlsOpen ? '收起 −' : '展开 +' }}</span>
    </button>
    <div id="controls-content" class="controls-content">
      <label class="field">
        场景
        <select v-model="selection.preset" data-testid="preset-select">
          <option v-for="item in demoPresets" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <label class="field">
        样式
        <select v-model="selection.source" data-testid="source-select" @change="selection.style = ''">
          <option v-for="item in stylePresets" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <label class="field">
        视图
        <select v-model="selection.mode" data-testid="scene-select">
          <option v-for="item in modeOptions" :key="item.id" :value="item.id">{{ item.id === '3d' ? '三维地球' : item.id === '2d' ? '二维地图' : '哥伦布视图' }}</option>
        </select>
      </label>
      <label class="high-dpi">
        <input v-model="selection.highDpi" type="checkbox" data-testid="high-dpi-switch">
        高清显示
      </label>
      <form class="custom-style" @submit.prevent="selection.style = customStyleInput.trim()">
        <label for="style-url">自定义 Style JSON 地址</label>
        <div>
          <input
            id="style-url"
            v-model="customStyleInput"
            type="url"
            pattern="https?://.*"
            required
            placeholder="https://…/style.json"
          >
          <button type="submit">
            加载
          </button>
        </div>
      </form>
      <slot name="camera" />
      <slot />
      <a class="github" href="https://github.com/vesiumjs/cesium-vector-tileset" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </aside>
</template>

<style scoped>
.controls {
  position: fixed;
  top: calc(12px + env(safe-area-inset-top));
  left: calc(12px + env(safe-area-inset-left));
  width: 300px;
  max-height: calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  overflow-y: auto;
  border: 1px solid var(--demo-border);
  border-radius: 4px;
  background: var(--demo-surface);
  color: var(--demo-text);
  font-size: 12px;
}
.controls-toggle {
  display: none;
}
.controls-content {
  padding: 10px;
}
.field {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
select,
button,
input[type='url'] {
  min-width: 0;
  min-height: 30px;
  padding: 4px 6px;
  border: 1px solid var(--demo-border);
  border-radius: 3px;
  background: var(--demo-surface);
  color: inherit;
}
.high-dpi {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
}
input[type='checkbox'] {
  margin: 0;
  accent-color: var(--demo-accent);
}
.custom-style {
  margin-bottom: 8px;
}
.custom-style label {
  display: block;
  margin-bottom: 4px;
  color: var(--demo-muted);
}
.custom-style div {
  display: flex;
  gap: 6px;
}
input[type='url'] {
  flex: 1;
  width: 0;
}
button {
  cursor: pointer;
}
button:focus-visible,
select:focus-visible,
input:focus-visible,
a:focus-visible {
  outline: 2px solid var(--demo-accent);
  outline-offset: 2px;
}
.github {
  display: inline-block;
  margin-top: 8px;
  color: var(--demo-accent);
}
@media (max-width: 720px) {
  .controls {
    right: calc(12px + env(safe-area-inset-right));
    width: auto;
  }
  .controls-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 44px;
    padding: 8px 10px;
    border: 0;
  }
  .controls-content {
    display: none;
    padding-top: 0;
  }
  .controls[data-expanded='true'] .controls-content {
    display: block;
  }
  select,
  button,
  input[type='url'],
  .high-dpi {
    min-height: 40px;
  }
}
</style>
