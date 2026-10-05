import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

const tile = fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] } }, { version: 2, extent: 4096 });

test('shared native atlas survives material replacement and repeated handoffs until its last owner releases it', async ({ page, renderUrl }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/atlas-test/**', (route) => {
    if (route.request().url().endsWith('.pbf'))
      return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
    return route.fulfill({ json: {
      version: 8,
      sources: { fixture: { type: 'vector', tiles: [`${renderUrl}/atlas-test/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
      layers: [{ 'id': 'land', 'type': 'fill', 'source': 'fixture', 'source-layer': 'land', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } }],
    } });
  });
  const query = new URLSearchParams({ atlas: '1', style: `${renderUrl}/atlas-test/style.json` });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation && Math.min(...window.renderValidation.readCoverage()))).toBeGreaterThanOrEqual(0.98);
  const result = await page.evaluate(() => {
    const validation = window.renderValidation;
    const { textures: SharedAtlasTextures, cesium } = validation.atlas;
    const context = validation.viewer.scene.context;
    interface NativeTexture { _texture: WebGLTexture; width: number; height: number; isDestroyed: () => boolean; destroy: () => void }
    const native = cesium as unknown as {
      Context: new (...args: never[]) => typeof context;
      Texture: new (...args: never[]) => NativeTexture;
      Framebuffer: new (options: { context: typeof context; colorTextures: NativeTexture[]; destroyAttachments: boolean }) => { destroy: () => void };
    };
    const registry = new SharedAtlasTextures() as unknown as Omit<InstanceType<typeof SharedAtlasTextures>, '_records'> & {
      _records: Map<string, { texture?: NativeTexture }>;
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    canvas.getContext('2d').fillStyle = '#ff3300';
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const key = 'material-handoffs';
    registry.canvas(key, 8, 8, () => canvas);
    const material = () => {
      const value = cesium.Material.fromType('Image') as ReturnType<typeof cesium.Material.fromType> & { update: (renderContext: typeof context) => void };
      value.uniforms.image = canvas;
      registry.track(key, value, 'image');
      return value;
    };
    registry.retain(key);
    registry.retain(key);
    const first = material();
    let active = material();
    registry.adopt(context as unknown as Parameters<typeof registry.adopt>[0]);
    const texture = registry._records.get(key).texture;
    if (!texture) {
      first.destroy();
      active.destroy();
      registry.clear();
      return { adopted: false, actualContext: context instanceof native.Context, maximumTextureSize: (context as typeof context & { maximumTextureSize: number }).maximumTextureSize };
    }
    const handle = texture._texture;
    const samples = [];
    const sample = () => {
      const framebuffer = new native.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false });
      try {
        return Array.from(context.readPixels({ framebuffer, x: 0, y: 0, width: 1, height: 1 }));
      }
      finally {
        framebuffer.destroy();
      }
    };
    first.update(context);
    active.update(context);
    const borrowedNativeTextures = first.uniforms.image instanceof native.Texture && active.uniforms.image instanceof native.Texture;
    samples.push(sample());
    // Material.update destroys its previous sampler when a uniform changes.
    // That sampler must release only this material's borrowed view.
    const replacement = document.createElement('canvas');
    replacement.width = replacement.height = 8;
    first.uniforms.image = replacement;
    first.update(context);
    first.destroy();
    registry.release(key);
    if (texture.isDestroyed())
      return { adopted: true, prematurelyDestroyed: true, borrowedNativeTextures, samples };
    samples.push(sample());
    let stable = true;
    for (let handoff = 0; handoff < 8; handoff++) {
      registry.retain(key);
      const next = material();
      registry.adopt(context as unknown as Parameters<typeof registry.adopt>[0]);
      next.update(context);
      active.destroy();
      registry.release(key);
      active = next;
      stable &&= registry._records.get(key).texture === texture && active.uniforms.image._texture === handle;
      if (texture.isDestroyed())
        return { adopted: true, prematurelyDestroyed: true, borrowedNativeTextures, stable, samples };
      samples.push(sample());
    }
    active.destroy();
    registry.release(key);
    return { adopted: true, prematurelyDestroyed: false, borrowedNativeTextures, stable, samples, released: texture.isDestroyed(), records: registry.size };
  });
  await testInfo.attach('atlas-lifecycle', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  assert.equal(result.adopted, true, `real WebGL context did not adopt an atlas texture: ${JSON.stringify(result)}`);
  assert.equal(result.borrowedNativeTextures, true, 'materials did not receive native Texture samplers');
  assert.equal(result.prematurelyDestroyed, false, 'one material destroyed an atlas still used by another material');
  assert.equal(result.stable, true, 'material handoffs reallocated the atlas GPU texture');
  assert.ok(result.samples.every(pixel => pixel.every((channel, index) => channel === [255, 51, 0, 255][index])), `shared GPU pixels changed: ${JSON.stringify(result.samples)}`);
  assert.equal(result.released, true);
  assert.equal(result.records, 0);
  assert.deepEqual(errors, []);
});
