<script setup lang="ts">
import type { OrthographicOffCenterFrustum, Scene } from 'cesium';
import { Cartesian3, Math as CesiumMath, SceneMode } from 'cesium';
import { onBeforeUnmount, shallowRef, watch } from 'vue';

const props = defineProps<{ scene: Scene }>();
const pose = shallowRef<{
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}>();

const stop = watch(() => props.scene, (scene, _previous, onCleanup) => {
  const position = new Cartesian3();
  const direction = new Cartesian3();
  const up = new Cartesian3();
  let mode: SceneMode | undefined;
  let width: number | undefined;

  function update(): void {
    if (scene.mode === SceneMode.MORPHING) {
      pose.value = undefined;
      mode = scene.mode;
      return;
    }
    const camera = scene.camera;
    const nextPosition = camera.positionWC;
    const nextDirection = camera.directionWC;
    const nextUp = camera.upWC;
    const frustum = camera.frustum as OrthographicOffCenterFrustum;
    const nextWidth = scene.mode === SceneMode.SCENE2D ? frustum.right - frustum.left : undefined;
    if (mode === scene.mode && width === nextWidth
      && Cartesian3.equals(position, nextPosition)
      && Cartesian3.equals(direction, nextDirection)
      && Cartesian3.equals(up, nextUp)) {
      return;
    }
    mode = scene.mode;
    width = nextWidth;

    // Cesium unprojects camera coordinates in Columbus View and 2D. In 2D,
    // positionCartographic.height represents the orthographic view width.
    const cartographic = camera.positionCartographic;
    pose.value = {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      height: cartographic.height,
      heading: CesiumMath.toDegrees(camera.heading),
      pitch: CesiumMath.toDegrees(camera.pitch),
      roll: CesiumMath.toDegrees(camera.roll),
    };
    // HPR getters temporarily change the camera transform. Keep the final
    // vectors so their rounding does not trigger work on a stationary frame.
    Cartesian3.clone(camera.positionWC, position);
    Cartesian3.clone(camera.directionWC, direction);
    Cartesian3.clone(camera.upWC, up);
  }

  // Camera motion renders frames even in requestRenderMode. Sampling here
  // follows flights and gestures without requesting frames for the readout.
  onCleanup(scene.postRender.addEventListener(update));
  update();
}, { immediate: true });

onBeforeUnmount(stop);

function format(value: number | undefined, digits: number): string {
  if (value === undefined || !Number.isFinite(value))
    return '—';
  return (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
}
function formatBearing(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value))
    return '—';
  const normalized = ((value % 360) + 360) % 360;
  return format(normalized > 359.95 ? 0 : normalized, 1);
}
</script>

<template>
  <section class="camera" aria-label="实时相机" data-testid="camera-readout">
    <dl>
      <div>
        <dt>经度</dt>
        <dd><output data-testid="camera-longitude" :data-value="pose?.longitude">{{ format(pose?.longitude, 5) }}°</output></dd>
      </div>
      <div>
        <dt>纬度</dt>
        <dd><output data-testid="camera-latitude" :data-value="pose?.latitude">{{ format(pose?.latitude, 5) }}°</output></dd>
      </div>
      <div>
        <dt>{{ scene.mode === SceneMode.SCENE2D ? '视野宽度' : '高度' }}</dt>
        <dd><output data-testid="camera-height" :data-value="pose?.height">{{ format(pose?.height, 2) }} m</output></dd>
      </div>
      <div>
        <dt>Heading</dt>
        <dd><output data-testid="camera-heading" :data-value="pose?.heading">{{ formatBearing(pose?.heading) }}°</output></dd>
      </div>
      <div>
        <dt>Pitch</dt>
        <dd><output data-testid="camera-pitch" :data-value="pose?.pitch">{{ format(pose?.pitch, 1) }}°</output></dd>
      </div>
      <div>
        <dt>Roll</dt>
        <dd><output data-testid="camera-roll" :data-value="pose?.roll">{{ formatBearing(pose?.roll) }}°</output></dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.camera {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #ffffff26;
}
dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 6px;
  margin: 0;
  font-variant-numeric: tabular-nums;
}
dt {
  color: #b9c7d6;
  font-size: 11px;
}
dd {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
