import type { DashAtlas } from '../../assets/dash-atlas';
import type { LineBucket } from '../../data/bucket-runtime';
import type { DashRow } from '../../source/worker-source';
import { Cartesian2, Material } from 'cesium';
import { constantValue, findRange, layerFor } from '../vector/feature-attributes';

/** Dash atlas row centre, SDF band height, and period in line-width units. */
export interface DashAtlasRow {
  y: number;
  height: number;
  width: number;
}

/**
 * Fragment shader for the dash SDF: samples the line atlas rows with the
 * MapLibre line_sdf formulas - from/to rows mixed by u_mix (zoom crossfade),
 * dash lengths in the per-vertex line width, and a ~1/dpr SDF edge
 * blur. The row data arrives per vertex via v_dashFrom/v_dashTo
 * (y, height, width).
 *
 * The varying declarations live here rather than in {@link DASH_LINE_FS}:
 * Appearance.getFragmentShaderSource concatenates material.shaderSource
 * before the appearance's fragmentShaderSource, so any identifier used by
 * the material must be declared in this string or GLSL reports it as
 * undeclared.
 */
const DASH_SDF_MATERIAL_SOURCE = `
in vec4 v_color;
in vec2 v_lineDistance;
in float v_gamma_scale;
in float v_width;
flat in vec3 v_capTangent;
flat in vec3 v_capDenominator;
flat in vec2 v_capExtent;
in float v_linesofar;
in vec3 v_dashFrom;
in vec3 v_dashTo;

uniform sampler2D u_dashAtlas;
uniform vec2 u_atlasSize;
uniform float u_mix;
uniform float u_fromScale;
uniform float u_toScale;
uniform float u_dpr;
uniform float u_worldPixels;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);

    // v_width is each feature's CSS paint width, independent of the device
    // pixel AA margin, so all dash widths can share one material.
    float floorWidth = max(1.0, v_width);
    float periodFrom = v_dashFrom.z * floorWidth * u_fromScale;
    float periodTo = v_dashTo.z * floorWidth * u_toScale;
    // Atlas coordinates use the AA envelope, independent of the extra
    // transparent geometry margin needed by a multisampled framebuffer.
    float halfWidth = v_width * 0.5;
    float normal = v_lineDistance.x / (halfWidth + 0.5 / czm_pixelRatio);

    vec2 texFrom = vec2(
        v_linesofar * u_worldPixels / max(periodFrom, 0.0001),
        normal * (-v_dashFrom.y / 2.0 / u_atlasSize.y) + (v_dashFrom.x + 0.5) / u_atlasSize.y);
    vec2 texTo = vec2(
        v_linesofar * u_worldPixels / max(periodTo, 0.0001),
        normal * (-v_dashTo.y / 2.0 / u_atlasSize.y) + (v_dashTo.x + 0.5) / u_atlasSize.y);

    // DashAtlas rows use top-left coordinates; Cesium uploads the canvas with
    // bottom-left texture coordinates. Pattern textures make the same flip.
    texFrom.y = 1.0 - texFrom.y;
    texTo.y = 1.0 - texTo.y;

    // Cesium's canvas texture clamps horizontally; MapLibre's line atlas
    // repeats. Wrap only U so each atlas row keeps its own vertical SDF.
    texFrom.x = fract(texFrom.x);
    texTo.x = fract(texTo.x);

    float sdfdistFrom = texture(u_dashAtlas, texFrom).a;
    float sdfdistTo = texture(u_dashAtlas, texTo).a;
    float sdfdist = mix(sdfdistFrom, sdfdistTo, u_mix);
    float sdfgamma = (u_atlasSize.x / 256.0 / max(u_dpr, 0.0001)) / min(v_dashFrom.z, v_dashTo.z);
    float sdfAlpha = smoothstep(0.5 - sdfgamma / floorWidth, 0.5 + sdfgamma / floorWidth, sdfdist);

    material.diffuse = vec3(0.0, 0.0, 0.0);
    material.emission = vec3(0.0, 0.0, 0.0);
    material.alpha = sdfAlpha;
    return material;
}
`;

/**
 * The dash atlas row for a `y:height` key sent by the worker: the row's
 * position comes from the key, the period from the dash array values.
 */
function dashRowForKey(key: string, row: DashRow): DashAtlasRow {
  const [y, height] = key.split(':').map(Number);
  let width = 0;
  for (const length of row.dasharray) {
    width += length;
  }
  return { y, height, width };
}

/**
 * The from/to dash atlas rows a feature renders with.
 * Data-driven dasharrays read the per-vertex row keys written by the
 * CrossFadedDasharrayBinder (evaluated at zoom-1 and zoom); constant
 * dasharrays evaluate the cross-faded { from, to } pair and look the rows
 * up in the line atlas.
 */
export function dashRowsForFeature(
  bucket: LineBucket,
  featureIndex: number,
  layerId: string,
  dashRows: Record<string, DashRow> | undefined,
  dashAtlas: DashAtlas,
): { from: DashAtlasRow; to: DashAtlasRow } | undefined {
  const layer = layerFor(bucket, layerId);
  const config = bucket.programConfigurations.get(layer.id);
  const array = config.getAttributeArray('line-dasharray');
  if (array && dashRows) {
    const u16 = new Uint16Array(array.arrayBuffer);
    const offset = findRange(bucket, featureIndex).start * array.bytesPerElement / Uint16Array.BYTES_PER_ELEMENT;
    const toKey = `${u16[offset + 5]}:${u16[offset + 6]}`;
    const fromKey = `${u16[offset + 1]}:${u16[offset + 2]}`;
    const toRow = dashRows[toKey];
    const fromRow = dashRows[fromKey];
    return toRow && fromRow
      ? { to: dashRowForKey(toKey, toRow), from: dashRowForKey(fromKey, fromRow) }
      : undefined;
  }
  const constant = constantValue(layer, 'line-dasharray') as
    | { from?: unknown; to?: unknown }
    | number[]
    | undefined;
  const from = Array.isArray(constant)
    ? constant
    : Array.isArray(constant?.from)
      ? constant.from
      : undefined;
  const to = Array.isArray(constant)
    ? constant
    : Array.isArray(constant?.to)
      ? constant.to
      : undefined;
  if (Array.isArray(from) && Array.isArray(to)) {
    const round = (bucket.featureLineJoinCaps[featureIndex] ?? bucket.lineJoinCap).cap === 'round';
    const fromRow = dashAtlas.getDash(from as number[], round);
    const toRow = dashAtlas.getDash(to as number[], round);
    // A full atlas cannot supply a complete dash; omit that feature.
    if (!fromRow || !toRow) {
      return undefined;
    }
    return { from: fromRow, to: toRow };
  }
  return undefined;
}

/** One Style's SDF material, retained with its active and retired line collections. */
export class DashMaterial {
  private _material?: Material;

  private _revision = -1;

  private _source?: HTMLCanvasElement | OffscreenCanvas;

  private _needsUpload = false;

  readonly atlas: DashAtlas;

  constructor(atlas: DashAtlas) {
    this.atlas = atlas;
  }

  get material(): Material {
    if (!this._material) {
      this._material = new Material({
        translucent: true,
        fabric: {
          uniforms: {
            u_dashAtlas: this._source ?? Material.DefaultImageId,
            u_atlasSize: new Cartesian2(this.atlas.width, this.atlas.height),
            u_mix: 1,
            u_fromScale: 1,
            u_toScale: 1,
            u_dpr: 1,
            u_worldPixels: 512,
          },
          source: DASH_SDF_MATERIAL_SOURCE,
        },
      });
      this._needsUpload = true;
    }
    return this._material;
  }

  /** Prepare the SDF before Native's first Primitive update can emit a command. */
  update(
    context: unknown,
    zoom: number,
    pixelRatio: number,
    crossfade: { t: number; fromScale: number; toScale: number } | undefined,
  ): void {
    const material = this._material;
    if (!material)
      return;
    if (this._revision !== this.atlas.revision) {
      const { width, height, data } = this.atlas;
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext)
        throw new Error('A 2D canvas context is required to upload the dash atlas');
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < data.length; index++) rgba.fill(data[index], index * 4, index * 4 + 4);
      canvasContext.putImageData(new ImageData(rgba, width, height), 0, 0);
      this._source = canvas;
      this._revision = this.atlas.revision;
      material.uniforms.u_dashAtlas = canvas;
      this._needsUpload = true;
    }
    if (crossfade) {
      material.uniforms.u_mix = crossfade.t;
      material.uniforms.u_fromScale = crossfade.fromScale;
      material.uniforms.u_toScale = crossfade.toScale;
    }
    material.uniforms.u_dpr = pixelRatio;
    material.uniforms.u_worldPixels = 512 * 2 ** Math.floor(zoom);
    if (this._needsUpload && context) {
      // Material.update first enqueues a canvas. The following Native Primitive
      // update consumes it and creates the texture before the first draw.
      (material as Material & { update: (context: unknown) => void }).update(context);
      this._needsUpload = false;
    }
  }

  /** The tileset destroys every staged, live and retired Primitive first. */
  destroy(): void {
    this._material?.destroy();
    this._material = undefined;
    this._source = undefined;
  }
}
