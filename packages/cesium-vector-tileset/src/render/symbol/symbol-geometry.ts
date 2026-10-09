import type { CollisionBoxArray } from '../../data/array-types.g';
import type { SymbolBucket } from '../../data/bucket-runtime';
import type { ProgramConfiguration } from '../../data/program-configuration';
import type { OverlapMode } from '../../style/style-layer/overlap-mode';
import type { SizeData } from '../../symbol/symbol-size';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { getOverlapMode } from '../../style/style-layer/overlap-mode';
import { tileLocalToWgs84Ecef } from '../geometry/tile-to-ecef';
import { vertexColor } from '../vector/feature-attributes';

type TileID = CanonicalTileID | OverscaledTileID;

/**
 * One draw batch of symbol quads. Every vertex carries the ECEF anchor of the
 * symbol it belongs to; point viewport quad corners are window offsets
 * scaled by the live MapLibre perspective ratio. Other alignment paths
 * preserve their existing geometry and live line projection.
 */
export interface SymbolPrimitiveGeometry {
  /** Viewport pitch alignment uses the shared worker-anchor perspective ratio. */
  viewportPerspective: boolean;
  /** Map-pitched quads use Mercator label space before world projection. */
  mapPitch: boolean;
  /** Ground point label-plane axes; along-line geometry owns its own glyph angles. */
  pointMapRotation?: 'map' | 'viewport';
  /** MapLibre disables GPU size perspective when this layer explicitly sets icon-offset. */
  sizePerspective: boolean;
  /** ECEF anchor per vertex, 3 doubles per vertex. */
  positions: Float64Array;
  /** Quad corner offset in pixels at text-size 24, 2 floats per vertex. */
  offsets: Float32Array;
  /** Stretch pixel offset (a_pixeloffset.xy / 16), 2 floats per vertex. */
  pxoffsets: Float32Array;
  /** Per-vertex minimum font scale (a_pixeloffset.zw / 256), 2 floats per vertex. */
  minfontscales: Float32Array;
  /** Atlas texel coordinate, 2 floats per vertex. */
  tex: Float32Array;
  /** Packed `(size * 128) << 2 | isSdf << 1 | isText`, 1 float per vertex. */
  sizes: Float32Array;
  /**
   * Upper zoom stop of a composite size, `size * 128`, 1 float per vertex.
   * The vertex shader mixes it with the lower stop (`sizes`) by `u_size_t`;
   * for every other size kind it equals the lower stop, so the mix is a
   * no-op at `u_size_t = 0`.
   */
  sizesMax: Float32Array;
  /**
   * Zoom stops of a composite size, 2 floats per vertex (`[minZoom,
   * maxZoom]`); zero for every other size kind. Together with `sizes` and
   * `sizesMax` the shader derives the size at the current camera zoom.
   */
  sizeZooms: Float32Array;
  /**
   * Straight-alpha fill color, 4 floats per vertex. White (1,1,1,1) unless
   * the layer's `text-color`/`icon-color` is data-driven, in which case the
   * fragment shader multiplies it into the material color - the same channel
   * MapLibre's `a_fill_color` attribute occupies.
   */
  colors: Float32Array;
  /**
   * Straight-alpha `text-halo-color`, 4 floats per vertex. White for
   * constant halo colors and for icon batches (whose material has no halo).
   */
  halos: Float32Array;
  /** Live glyph displacement and angle: device pixels for viewport, Mercator metres for map lines. */
  dynamics: Float32Array;
  /** The bucket's overlap mode, checked against previously placed symbols. */
  overlapMode: OverlapMode;
  /** Drawn symbols with ignore-placement do not block later symbols. */
  ignorePlacement: boolean;
  /** Per-vertex opacity; the collision pass writes 0 for hidden symbols. */
  opacities: Float32Array;
  /** Placement changed the generation channel before its GPU upload. */
  opacityDirty: boolean;
  /** Triangle indices into the arrays above. */
  indices: Uint32Array;
  /** Placement metadata, one entry per symbol, in vertex order. */
  instances: SymbolInstance[];
  /** Whether the sampled atlas stores a signed distance field. */
  sdf: boolean;
}

/**
 * One placed symbol: the vertex range it owns and its extent in pixels, used
 * by the collision pass to decide whether the symbol survives.
 */
export interface SymbolInstance {
  /** First vertex of the symbol in the batch's arrays. */
  vertexStart: number;
  /** Vertex count (always a multiple of four: one quad per glyph or icon). */
  vertexCount: number;
  /** Extent of the quads in pixels at text-size 24. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Worker placement box in CSS pixels at the bucket's layout size. */
  collisionBox?: { x1: number; y1: number; x2: number; y2: number; layoutSize: number };
  /** Worker line-text collision diameter in CSS pixels, plus runtime padding. */
  collisionCircles?: { diameter: number; padding: number };
  /** Present for line-placed labels: the per-frame view state. */
  line?: LineLabelView;
}

/** Worker line and glyph offsets retained for the per-frame projection pass. */
export interface LineLabelView {
  anchorECEF: { x: number; y: number; z: number };
  /** ECEF points of the worker line, three doubles per point. */
  pathECEF: Float64Array;
  segment: number;
  glyphOffsets: Float32Array;
  lineOffsetX: number;
  lineOffsetY: number;
  keepUpright: boolean;
  rotateToLine: boolean;
  writingMode: number;
}

export interface SymbolTileGeometry {
  text?: SymbolPrimitiveGeometry;
  icon?: SymbolPrimitiveGeometry;
  /**
   * Per-symbol text/icon pairing in symbol-instance order: each entry names
   * the index into text/icon `instances` for one worker symbol instance
   * (-1 when that half is absent). MapLibre pairs the two halves of a
   * symbol for its text-optional/icon-optional combine step, and without
   * the pairing an index-based zip would couple unrelated features whenever
   * the two halves have different counts.
   */
  pairs: ReadonlyArray<{ text: number; icon: number }>;
}

interface SymbolInstanceRow {
  anchorX: number;
  anchorY: number;
  numHorizontalGlyphVertices: number;
  numVerticalGlyphVertices: number;
  numIconVertices: number;
  numVerticalIconVertices: number;
  rightJustifiedTextSymbolIndex: number;
  centerJustifiedTextSymbolIndex: number;
  leftJustifiedTextSymbolIndex: number;
  verticalPlacedTextSymbolIndex: number;
  placedIconSymbolIndex: number;
  verticalPlacedIconSymbolIndex: number;
  /** Shaped-space to tile-unit scale for this symbol (see textBoxScale). */
  textBoxScale: number;
  textBoxStartIndex: number;
  textBoxEndIndex: number;
  iconBoxStartIndex: number;
  iconBoxEndIndex: number;
  useRuntimeCollisionCircles: number;
  collisionCircleDiameter: number;
}

interface PlacedSymbolView {
  length: number;
  get: (index: number) => {
    glyphStartIndex: number;
    numGlyphs: number;
    vertexStartIndex: number;
    lineStartIndex: number;
    lineLength: number;
    segment: number;
    lineOffsetX: number;
    lineOffsetY: number;
    writingMode: number;
  };
}

interface LineDataView {
  keepUpright: boolean;
  rotateToLine: boolean;
  placed: PlacedSymbolView;
  glyphOffsetX: (index: number) => number;
  linePointX: (index: number) => number;
  linePointY: (index: number) => number;
}

/** Components of the symbol layout vertex (a_pos_offset, a_data, a_pixeloffset). */
const LAYOUT_COMPONENTS = 12;

interface LineGlyphPlacement {
  /** Position per glyph, in the supplied label plane and glyph order. */
  points: Array<{ x: number; y: number }>;
  /** Segment angle per glyph, with the caller's reading direction. */
  angles: number[];
  /** Worker polyline between the first and last glyph, in the same label plane. */
  path: Array<{ x: number; y: number }>;
  /** The caller's keep-upright flip after screen projection. */
  flipped: boolean;
}

/**
 * A caller supplies label-plane projection only when its vertices must be
 * projected lazily; a map-plane walk reads the cached worker coordinates.
 */
export interface LineGlyphOptions {
  flip: boolean;
  lineOffsetY: number;
  rotateToLine: boolean;
  project?: (index: number, previous: { x: number; y: number }, direction: 1 | -1, travelled: number, required: number) => { x: number; y: number } | undefined;
}

/** Walk only glyph-required legs, including intersections of Y-offset legs. */
export function projectGlyphsAlongLine(
  lineX: (index: number) => number,
  lineY: (index: number) => number,
  lineStartIndex: number,
  lineLength: number,
  anchorX: number,
  anchorY: number,
  anchorSegment: number,
  glyphDistances: readonly number[],
  lineOffset: number,
  options: LineGlyphOptions,
): LineGlyphPlacement | undefined {
  if (glyphDistances.length === 0)
    return undefined;
  const end = lineStartIndex + lineLength;
  interface Leg { x: number; y: number; dx: number; dy: number; start: number; end: number; angle: number }
  const makeLegs = (direction: 1 | -1) => {
    const legs: Leg[] = [];
    let previous = { x: anchorX, y: anchorY };
    let offsetPrevious: { x: number; y: number } | undefined;
    let index = lineStartIndex + anchorSegment + (direction > 0 ? 1 : 0);
    let distance = 0;
    const inRange = (index: number) => index >= lineStartIndex && index < end;
    const point = (index: number, required: number) => options.project
      ? options.project(index, previous, direction, distance, required)
      : { x: lineX(index), y: lineY(index) };
    const ensure = (required: number): Leg[] | undefined => {
      while ((legs.length === 0 || distance <= required) && inRange(index)) {
        const current = point(index, required);
        if (!current || !Number.isFinite(current.x) || !Number.isFinite(current.y))
          return undefined;
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        const length = Math.hypot(dx, dy);
        if (length === 0) {
          previous = current;
          index += direction;
          continue;
        }
        const normal = { x: -dy / length * options.lineOffsetY * direction, y: dx / length * options.lineOffsetY * direction };
        const from = offsetPrevious ?? { x: previous.x + normal.x, y: previous.y + normal.y };
        let to = { x: current.x + normal.x, y: current.y + normal.y };
        if (options.lineOffsetY !== 0 && inRange(index + direction)) {
          const next = point(index + direction, required);
          if (!next)
            return undefined;
          const nx = next.x - current.x;
          const ny = next.y - current.y;
          const nextLength = Math.hypot(nx, ny);
          if (nextLength > 0) {
            const nextNormal = { x: -ny / nextLength * options.lineOffsetY * direction, y: nx / nextLength * options.lineOffsetY * direction };
            const bx = current.x + nextNormal.x;
            const by = current.y + nextNormal.y;
            const ax = to.x - from.x;
            const ay = to.y - from.y;
            const denominator = ax * ny - ay * nx;
            if (denominator !== 0) {
              const t = ((bx - from.x) * ny - (by - from.y) * nx) / denominator;
              to = { x: from.x + ax * t, y: from.y + ay * t };
            }
          }
        }
        const lx = to.x - from.x;
        const ly = to.y - from.y;
        const segmentLength = Math.hypot(lx, ly);
        if (segmentLength > 0) {
          legs.push({ x: from.x, y: from.y, dx: lx, dy: ly, start: distance, end: distance + segmentLength, angle: Math.atan2(dy, dx) });
          distance += segmentLength;
        }
        previous = current;
        offsetPrevious = to;
        index += direction;
      }
      return legs;
    };
    return { legs, ensure };
  };
  const forward = makeLegs(1);
  const backward = makeLegs(-1);
  const distances = glyphDistances.map(distance => (options.flip ? -distance : distance) + lineOffset);
  const points: Array<{ x: number; y: number; angle: number }> = [];
  for (const distance of distances) {
    const direction = distance > 0 ? 1 : -1;
    const branch = direction > 0 ? forward : backward;
    const travel = Math.abs(distance);
    const legs = branch.ensure(travel);
    if (!legs)
      return undefined;
    const leg = legs.find(leg => leg.end > travel) ?? (travel === legs.at(-1)?.end ? legs.at(-1) : undefined);
    if (!leg)
      return undefined;
    const t = (travel - leg.start) / (leg.end - leg.start);
    const angle = (options.flip ? Math.PI : 0) + (direction < 0 ? Math.PI : 0) + leg.angle;
    points.push({ x: leg.x + leg.dx * t, y: leg.y + leg.dy * t, angle: options.rotateToLine ? normalizeAngle(angle) : 0 });
  }
  const firstDistance = distances[0];
  const lastDistance = distances[distances.length - 1];
  const minimum = Math.min(firstDistance, lastDistance);
  const maximum = Math.max(firstDistance, lastDistance);
  const intermediates: Array<{ x: number; y: number; distance: number }> = [];
  for (const [legs, direction] of [[backward.legs, -1], [forward.legs, 1]] as const) {
    for (const leg of legs) {
      const distance = direction * leg.end;
      if (distance > minimum && distance < maximum)
        intermediates.push({ x: leg.x + leg.dx, y: leg.y + leg.dy, distance });
    }
  }
  intermediates.sort((a, b) => firstDistance < lastDistance ? a.distance - b.distance : b.distance - a.distance);
  return { points, path: [points[0], ...intermediates, points[points.length - 1]], angles: points.map(point => point.angle), flipped: options.flip };
}

function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

interface SymbolBuffersView {
  layoutVertexArray: { int16: Int16Array; uint16: Uint16Array; length: number };
  indexArray: { uint16: Uint16Array; length: number };
  programConfigurations: { get: (layerId: string) => ProgramConfiguration };
}

/**
 * Per-vertex data-driven paint lookup for one symbol part. Symbol buckets
 * populate their paint arrays parallel to the layout vertex array, so the
 * paint value of a vertex is read at the vertex's own index; this mirrors
 * MapLibre's `a_fill_color`/`a_halo_color` symbol attributes, which the layer
 * shader multiplies into `u_color`/`u_halo_color`. A constant property has no
 * array (and no lookup), so the geometry stays white and the material color
 * applies unchanged — one shader path for both kinds.
 */
interface SymbolPaintView {
  config: ProgramConfiguration;
  /** `text-color` or `icon-color`. */
  colorProperty: string;
  /** `text-halo-color`; absent for icons, whose material has no halo pass. */
  haloProperty?: string;
  /** Zoom the paint arrays were populated at (composite stops interpolate from it). */
  zoom: number;
}

/**
 * How one symbol part derives its size. `vertexOwned` parts (source and
 * composite sizes) carry per-feature packed values in the layout vertex;
 * constant and camera sizes carry none, so the geometry bakes the fallback
 * stops here - camera stops interpolate in the shader by the live camera zoom
 * exactly as MapLibre's `evaluateSizeForZoom` does, instead of freezing at
 * the bucket's build zoom.
 */
export interface SymbolPartSize {
  /** Lower packed stop (`size * 128`) for vertex-less sizes. */
  minPacked: number;
  /** Upper packed stop; equals `minPacked` when there is no zoom interpolation. */
  maxPacked: number;
  /** `[minZoom, maxZoom]` for shader interpolation, else undefined. */
  zoomRange?: readonly [number, number];
  /** Whether the layout vertex carries the packed value (`source`/`composite`). */
  vertexOwned: boolean;
}

/** Packs a symbol size the way the layout vertex stores it, clamped like MapLibre. */
export function packSymbolSize(size: number): number {
  return Math.min(255 * 128, Math.max(0, Math.round(size * 128)));
}

/**
 * Whitespace-stripped size description of one part: which stops the shader
 * mixes and whether the layout vertex owns them. Camera sizes interpolate by
 * the live camera zoom (MapLibre's `evaluateSizeForZoom`), so geometry no
 * longer freezes at the bucket's build zoom.
 */
function partSize(data: SizeData): SymbolPartSize {
  if (data.kind === 'constant') {
    const packed = packSymbolSize(data.layoutSize);
    return { minPacked: packed, maxPacked: packed, vertexOwned: false };
  }
  if (data.kind === 'camera') {
    return {
      minPacked: packSymbolSize(data.minSize),
      maxPacked: packSymbolSize(data.maxSize),
      zoomRange: [data.minZoom, data.maxZoom],
      vertexOwned: false,
    };
  }
  // source/composite: the worker packed the per-feature stops into the vertex.
  return { minPacked: 0, maxPacked: 0, vertexOwned: true };
}

/**
 * Pack the surviving vertices of one SymbolBuffers into GPU-ready arrays.
 *
 * A symbol bucket emits one vertex block per orientation: horizontal glyphs,
 * vertical glyphs, horizontal icons, vertical icons. Without the placement
 * pass nothing selects an orientation, so all four would be drawn on top of
 * each other. This pass keeps the horizontal blocks only and drops the rest,
 * which is what a point-placed label looks like before collision culling.
 *
 * Line-placed symbols (placed records with a line range) take a separate
 * branch: every glyph is projected onto its line segment in tile units and
 * carries the segment angle, so road and river labels spread along their
 * geometry instead of stacking on the anchor. One justification variant is
 * baked (center, falling back to right then left); upstream selects it per
 * frame, which a baked collection cannot do.
 */
function extractGeometry(
  buffers: SymbolBuffersView,
  instances: { length: number; get: (index: number) => SymbolInstanceRow },
  tileID: TileID,
  kind: 'text' | 'icon',
  sdf: boolean,
  /**
   * Size fallback for vertices whose layout record carries no packed size
   * (constant and camera sizes). `vertexOwned` parts (source/composite) read
   * the worker's own packed stops instead.
   */
  size: SymbolPartSize,
  overlapMode: OverlapMode,
  ignorePlacement: boolean,
  viewportPerspective: boolean,
  mapPitch: boolean,
  sizePerspective: boolean,
  collision: { boxes: CollisionBoxArray; tilePixelRatio: number; layoutZoom: number; textPadding: number },
  line?: LineDataView,
  /** Collects the worker symbol-instance ordinal for each emitted entry. */
  emittedOrdinals?: number[],
  /**
   * Per-vertex data-driven fill/halo colors of the layer that owns this part.
   * Absent for constant-paint layers; every emitted vertex is then white.
   */
  paint?: SymbolPaintView,
  pointMapRotation?: SymbolPrimitiveGeometry['pointMapRotation'],
): ExtractedSymbolGeometry | undefined {
  const int16 = buffers.layoutVertexArray.int16;
  const uint16 = buffers.layoutVertexArray.uint16;
  const indices = buffers.indexArray.uint16;

  // old vertex index -> new vertex index, -1 for dropped (vertical) vertices.
  const remap = new Int32Array(buffers.layoutVertexArray.length).fill(-1);
  const positions: number[] = [];
  const offsets: number[] = [];
  const pxoffsets: number[] = [];
  const minfontscales: number[] = [];
  const tex: number[] = [];
  const sizes: number[] = [];
  const sizesMax: number[] = [];
  // Two floats per vertex: the zoom stops a composite size's two values
  // belong to. Zero for every other size kind (the shader then leaves the
  // lower stop untouched).
  const sizeZooms: number[] = [];
  const colors: number[] = [];
  const halos: number[] = [];
  const placed: SymbolInstance[] = [];

  // Straight-alpha white; constant properties contribute nothing but the
  // shader still multiplies, keeping one code path for both paint kinds.
  const WHITE = [1, 1, 1, 1] as const;
  const readPaint = (property: string | undefined, vertexStart: number): readonly number[] => {
    if (!paint || !property) {
      return WHITE;
    }
    const color = vertexColor(paint.config, property, vertexStart, paint.zoom);
    return color ? [color.red, color.green, color.blue, color.alpha] : WHITE;
  };

  let cursor = 0;
  // The packed size vertex carries two flag bits below the size so the
  // vertex shader can scale text (24px glyph em) and icons (sprite pixels)
  // differently without a per-batch vertex uniform: bit0 = text kind,
  // bit1 = SDF sampling. See the decode in symbol-renderer's vertex shader.
  const textBit = kind === 'text' ? 1 : 0;
  for (let i = 0; i < instances.length; i++) {
    const instance = instances.get(i);
    const horizontal = kind === 'text'
      ? instance.numHorizontalGlyphVertices
      : instance.numIconVertices;
    const vertical = kind === 'text'
      ? instance.numVerticalGlyphVertices
      : instance.numVerticalIconVertices;

    const linePlacement = line ? linePlacedSymbol(instance, kind, line) : undefined;
    if (linePlacement) {
      // The placed-driven branch owns its vertices; the instance cursor
      // range is skipped below so nothing double-draws.
      const placedBefore = placed.length;
      emitLinePlacement(
        buffers,
        tileID,
        sdf,
        size,
        textBit,
        linePlacement,
        line,
        positions,
        offsets,
        pxoffsets,
        minfontscales,
        tex,
        sizes,
        sizesMax,
        sizeZooms,
        colors,
        halos,
        placed,
        remap,
        paint,
      );
      // emitLinePlacement drops the whole label when a glyph does not fit
      // (matching upstream): only record ordinals for emitted entries.
      if (placed.length > placedBefore) {
        const emitted = placed[placedBefore];
        if (kind === 'text' && instance.useRuntimeCollisionCircles)
          emitted.collisionCircles = { diameter: instance.collisionCircleDiameter, padding: collision.textPadding };
        if (kind === 'icon')
          emitted.collisionBox = pointCollisionBox(instance, kind, collision, sizes, sizesMax, sizeZooms, emitted.vertexStart);
        emittedOrdinals?.push(i);
      }
    }
    else if (horizontal > 0) {
      const cartesian = tileLocalToWgs84Ecef(tileID, instance.anchorX, instance.anchorY);
      const vertexStart = positions.length / 3;
      // One paint read per symbol: every vertex of an instance belongs to the
      // same feature, whose value sits at the instance's first paint slot.
      const fill = readPaint(paint?.colorProperty, cursor);
      const halo = readPaint(paint?.haloProperty, cursor);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let v = 0; v < horizontal; v++) {
        const old = cursor + v;
        const base = old * LAYOUT_COMPONENTS;
        remap[old] = positions.length / 3;
        positions.push(cartesian.x, cartesian.y, cartesian.z);
        // a_pos_offset.zw stores round(offset * 32); undo the packing so the
        // shader scales from pixels-at-size-24 like MapLibre does.
        offsets.push(int16[base + 2] / 32, int16[base + 3] / 32);
        // a_pixeloffset.xy stores round(pixelOffset * 16) for stretchable
        // icons (icon-text-fit); a_pixeloffset.zw stores round(minFontScale *
        // 256). Text quads leave both at zero.
        pxoffsets.push(int16[base + 8] / 16, int16[base + 9] / 16);
        minfontscales.push(int16[base + 10] / 256, int16[base + 11] / 256);
        tex.push(uint16[base + 4], uint16[base + 5]);
        // A constant or camera {text,icon}-size leaves the packed size at zero
        // because MapLibre ships those kinds as uniforms. Bake the part's
        // stops into the vertex instead, so the shader reads one code path
        // (camera stops interpolate by u_camera_zoom exactly like composite).
        const packed = uint16[base + 6];
        const packedSize = Math.floor(packed / 2);
        const vertexOwned = size.vertexOwned && packedSize !== 0;
        sizes.push(vertexOwned
          ? (packed << 1) + textBit
          : ((size.minPacked << 1) + (sdf ? 1 : 0) << 1) + textBit);
        // a_data.w carries the upper stop of a zoom-interpolated size; for
        // single-value parts it equals the lower stop, so the shader's mix
        // is a no-op.
        sizesMax.push(vertexOwned ? uint16[base + 7] : size.maxPacked);
        sizeZooms.push(size.zoomRange ? size.zoomRange[0] : 0, size.zoomRange ? size.zoomRange[1] : 0);
        colors.push(fill[0], fill[1], fill[2], fill[3]);
        halos.push(halo[0], halo[1], halo[2], halo[3]);
        minX = Math.min(minX, int16[base + 2] / 32);
        maxX = Math.max(maxX, int16[base + 2] / 32);
        minY = Math.min(minY, int16[base + 3] / 32);
        maxY = Math.max(maxY, int16[base + 3] / 32);
      }
      placed.push({
        vertexStart,
        vertexCount: horizontal,
        minX,
        minY,
        maxX,
        maxY,
        collisionBox: pointCollisionBox(instance, kind, collision, sizes, sizesMax, sizeZooms, vertexStart),
      });
      emittedOrdinals?.push(i);
    }
    cursor += horizontal + vertical;
  }

  if (positions.length === 0) {
    return undefined;
  }

  const kept: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]];
    const b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a >= 0 && b >= 0 && c >= 0) {
      kept.push(a, b, c);
    }
  }
  if (kept.length === 0) {
    return undefined;
  }

  return {
    positions: new Float64Array(positions),
    offsets: new Float32Array(offsets),
    pxoffsets: new Float32Array(pxoffsets),
    minfontscales: new Float32Array(minfontscales),
    tex: new Float32Array(tex),
    sizes: new Float32Array(sizes),
    sizesMax: new Float32Array(sizesMax),
    sizeZooms: new Float32Array(sizeZooms),
    colors: new Float32Array(colors),
    halos: new Float32Array(halos),
    indices: new Uint32Array(kept),
    instances: placed,
    sdf,
    overlapMode,
    ignorePlacement,
    viewportPerspective,
    mapPitch,
    pointMapRotation,
    sizePerspective,
  };
}

/** Use the worker's padded and rotated point box instead of the atlas quad bounds. */
function pointCollisionBox(
  instance: SymbolInstanceRow,
  kind: 'text' | 'icon',
  collision: { boxes: CollisionBoxArray; tilePixelRatio: number; layoutZoom: number },
  sizes: number[],
  sizesMax: number[],
  sizeZooms: number[],
  vertexStart: number,
): SymbolInstance['collisionBox'] {
  const start = kind === 'text' ? instance.textBoxStartIndex : instance.iconBoxStartIndex;
  const end = kind === 'text' ? instance.textBoxEndIndex : instance.iconBoxEndIndex;
  if (start >= end) {
    return undefined;
  }
  const box = collision.boxes.get(start);
  const pixelScale = 1 / collision.tilePixelRatio;
  const sizeMin = Math.floor(sizes[vertexStart] / 4) / 128;
  const zoomMin = sizeZooms[vertexStart * 2];
  const zoomMax = sizeZooms[vertexStart * 2 + 1];
  const zoomT = zoomMax > zoomMin
    ? Math.min(1, Math.max(0, (collision.layoutZoom - zoomMin) / (zoomMax - zoomMin)))
    : 0;
  const iconLayoutSize = sizeMin + (Math.max(sizeMin, sizesMax[vertexStart] / 128) - sizeMin) * zoomT;
  const layoutSize = kind === 'text'
    ? instance.textBoxScale * pixelScale * 24
    : iconLayoutSize;
  return {
    x1: box.x1 * pixelScale,
    y1: box.y1 * pixelScale,
    x2: box.x2 * pixelScale,
    y2: box.y2 * pixelScale,
    layoutSize,
  };
}

/**
 * A line-placed symbol's own vertex range, resolved through its placed
 * record. Returns undefined for point placement (or when the placed record
 * is missing), in which case the caller falls back to the anchor path.
 */
interface LinePlacedRange {
  placedIndex: number;
  anchorX: number;
  anchorY: number;
  segment: number;
  lineStartIndex: number;
  lineLength: number;
  lineOffsetTiles: number;
  lineOffsetX: number;
  lineOffsetY: number;
  writingMode: number;
  textBoxScale: number;
  vertexStart: number;
  numGlyphs: number;
  glyphStartIndex: number;
}

function linePlacedSymbol(
  instance: SymbolInstanceRow,
  kind: 'text' | 'icon',
  line: LineDataView,
): LinePlacedRange | undefined {
  // One justification variant is baked (center first): upstream selects it
  // per frame, which a baked collection cannot do.
  const candidates = kind === 'text'
    ? [
        instance.centerJustifiedTextSymbolIndex,
        instance.rightJustifiedTextSymbolIndex,
        instance.leftJustifiedTextSymbolIndex,
        instance.verticalPlacedTextSymbolIndex,
      ]
    : [instance.placedIconSymbolIndex, instance.verticalPlacedIconSymbolIndex];
  for (const placedIndex of candidates) {
    if (placedIndex === undefined || placedIndex < 0 || placedIndex >= line.placed.length) {
      continue;
    }
    const placed = line.placed.get(placedIndex);
    if (placed.lineLength === 0 || placed.numGlyphs === 0) {
      continue;
    }
    return {
      placedIndex,
      anchorX: instance.anchorX,
      anchorY: instance.anchorY,
      segment: placed.segment,
      lineStartIndex: placed.lineStartIndex,
      lineLength: placed.lineLength,
      // The worker already converted text-offset ems to 24-em shaped units.
      lineOffsetTiles: placed.lineOffsetX * instance.textBoxScale,
      lineOffsetX: placed.lineOffsetX,
      lineOffsetY: placed.lineOffsetY,
      writingMode: placed.writingMode,
      textBoxScale: instance.textBoxScale,
      vertexStart: placed.vertexStartIndex,
      numGlyphs: placed.numGlyphs,
      glyphStartIndex: placed.glyphStartIndex,
    };
  }
  return undefined;
}

/**
 * Emit one line-placed symbol: project every glyph onto the line, write its
 * own ECEF anchor and segment angle per vertex, and remap the quad indices.
 * Glyphs that do not fit drop the whole label, matching upstream.
 */
function emitLinePlacement(
  buffers: SymbolBuffersView,
  tileID: TileID,
  sdf: boolean,
  size: SymbolPartSize,
  textBit: number,
  range: LinePlacedRange,
  line: LineDataView,
  positions: number[],
  offsets: number[],
  pxoffsets: number[],
  minfontscales: number[],
  tex: number[],
  sizes: number[],
  sizesMax: number[],
  sizeZooms: number[],
  colors: number[],
  halos: number[],
  placed: SymbolInstance[],
  remap: Int32Array,
  paint?: SymbolPaintView,
): void {
  const int16 = buffers.layoutVertexArray.int16;
  const uint16 = buffers.layoutVertexArray.uint16;
  // Glyph shaped-space offsets to tile units (textBoxScale is the
  // tilePixelRatio * fontScale product the collision boxes use), plus the
  // text-offset resolved the same way upstream combines it.
  const distances: number[] = [];
  for (let g = 0; g < range.numGlyphs; g++) {
    const offsetX = line.glyphOffsetX(range.glyphStartIndex + g);
    distances.push(offsetX * range.textBoxScale);
  }
  const placement = projectGlyphsAlongLine(
    index => line.linePointX(index),
    index => line.linePointY(index),
    range.lineStartIndex,
    range.lineLength,
    range.anchorX,
    range.anchorY,
    range.segment,
    distances,
    range.lineOffsetTiles,
    { flip: false, lineOffsetY: range.lineOffsetY * range.textBoxScale, rotateToLine: line.rotateToLine },
  );
  if (!placement) {
    return;
  }
  // Straight-alpha white for constant paint; the shader multiplies either way.
  const readPlacedPaint = (property: string | undefined): readonly number[] => {
    if (!paint || !property) {
      return [1, 1, 1, 1];
    }
    const color = vertexColor(paint.config, property, range.vertexStart, paint.zoom);
    return color ? [color.red, color.green, color.blue, color.alpha] : [1, 1, 1, 1];
  };
  const fill = readPlacedPaint(paint?.colorProperty);
  const halo = readPlacedPaint(paint?.haloProperty);
  const vertexStart = positions.length / 3;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let g = 0; g < range.numGlyphs; g++) {
    const point = placement.points[g];
    const cartesian = tileLocalToWgs84Ecef(tileID, point.x, point.y);
    // The placed record's vertex range holds this symbol's quads in glyph
    // order, four vertices per glyph.
    for (let q = 0; q < 4; q++) {
      const old = range.vertexStart + g * 4 + q;
      const base = old * LAYOUT_COMPONENTS;
      remap[old] = positions.length / 3;
      positions.push(cartesian.x, cartesian.y, cartesian.z);
      const ox = int16[base + 2] / 32;
      const oy = int16[base + 3] / 32;
      offsets.push(ox, oy);
      pxoffsets.push(int16[base + 8] / 16, int16[base + 9] / 16);
      minfontscales.push(int16[base + 10] / 256, int16[base + 11] / 256);
      tex.push(uint16[base + 4], uint16[base + 5]);
      const packed = uint16[base + 6];
      const packedSize = Math.floor(packed / 2);
      const vertexOwned = size.vertexOwned && packedSize !== 0;
      sizes.push(vertexOwned
        ? (packed << 1) + textBit
        : ((size.minPacked << 1) + (sdf ? 1 : 0) << 1) + textBit);
      // Keep every per-vertex array in lockstep with the layout vertices:
      // a missing push here would shift sizesMax/sizeZooms/colors for every
      // later instance.
      sizesMax.push(vertexOwned ? uint16[base + 7] : size.maxPacked);
      sizeZooms.push(size.zoomRange ? size.zoomRange[0] : 0, size.zoomRange ? size.zoomRange[1] : 0);
      colors.push(fill[0], fill[1], fill[2], fill[3]);
      halos.push(halo[0], halo[1], halo[2], halo[3]);
      // Unrotated bounds: the collision pass re-derives the rotated union
      // per quad from the angles, so the stored box only needs the offsets.
      minX = Math.min(minX, ox);
      maxX = Math.max(maxX, ox);
      minY = Math.min(minY, oy);
      maxY = Math.max(maxY, oy);
    }
  }
  placed.push({
    vertexStart,
    vertexCount: range.numGlyphs * 4,
    minX,
    minY,
    maxX,
    maxY,
    line: lineLabelView(tileID, range, line),
  });
}

/** Retain the worker path and glyph offsets for camera-space placement. */
export function lineLabelView(
  tileID: TileID,
  range: LinePlacedRange,
  line: LineDataView,
): LineLabelView {
  const anchor = tileLocalToWgs84Ecef(tileID, range.anchorX, range.anchorY);
  const pathECEF = new Float64Array(range.lineLength * 3);
  for (let i = 0; i < range.lineLength; i++) {
    const index = range.lineStartIndex + i;
    const point = tileLocalToWgs84Ecef(tileID, line.linePointX(index), line.linePointY(index));
    pathECEF.set([point.x, point.y, point.z], i * 3);
  }
  const glyphOffsets = new Float32Array(range.numGlyphs);
  for (let i = 0; i < range.numGlyphs; i++) {
    glyphOffsets[i] = line.glyphOffsetX(range.glyphStartIndex + i);
  }
  return {
    anchorECEF: { x: anchor.x, y: anchor.y, z: anchor.z },
    pathECEF,
    segment: range.segment,
    glyphOffsets,
    lineOffsetX: range.lineOffsetX,
    lineOffsetY: range.lineOffsetY,
    keepUpright: line.keepUpright,
    rotateToLine: line.rotateToLine,
    writingMode: range.writingMode,
  };
}

/** Cached worker extraction has no mutable placement or live projection state. */
type ExtractedSymbolGeometry = Readonly<Omit<SymbolPrimitiveGeometry, 'dynamics' | 'opacities' | 'opacityDirty'>>;
interface ExtractedSymbolTileGeometry {
  text?: ExtractedSymbolGeometry;
  icon?: ExtractedSymbolGeometry;
  pairs: SymbolTileGeometry['pairs'];
}
const geometryCache = new WeakMap<SymbolBucket, Map<string, ExtractedSymbolTileGeometry>>();

/** Each generation owns its dynamic channels; extracted vertex data is shared. */
function generationGeometry(extracted: ExtractedSymbolTileGeometry): SymbolTileGeometry {
  const part = (geometry: ExtractedSymbolGeometry | undefined): SymbolPrimitiveGeometry | undefined => geometry && ({
    ...geometry,
    dynamics: new Float32Array(geometry.positions.length),
    opacities: new Float32Array(geometry.positions.length / 3),
    opacityDirty: true,
  });
  return { text: part(extracted.text), icon: part(extracted.icon), pairs: extracted.pairs };
}

export function symbolBucketGeometry(
  bucket: SymbolBucket,
  tileID: TileID,
  tileKey: string,
  collisionBoxArray: CollisionBoxArray,
): SymbolTileGeometry {
  let byTile = geometryCache.get(bucket);
  if (!byTile) {
    byTile = new Map();
    geometryCache.set(bucket, byTile);
  }
  const key = tileKey;
  const cached = byTile.get(key);
  if (cached) {
    return generationGeometry(cached);
  }

  const instances = bucket.symbolInstances;
  const result: ExtractedSymbolTileGeometry = { pairs: [] };
  // The icon atlas stores an SDF only when the sprite is an SDF sprite; the
  // packed size vertex bit records which one this bucket was built for.
  const iconSdf = bucket.sdfIcons === true;
  // Each half decides independently whether to test earlier symbols and
  // whether to reserve collision space for later symbols.
  const firstLayout = bucket.layers?.[0]?.layout;
  const textOverlapMode = firstLayout
    ? getOverlapMode(firstLayout, 'text-overlap', 'text-allow-overlap')
    : 'never';
  const iconOverlapMode = firstLayout
    ? getOverlapMode(firstLayout, 'icon-overlap', 'icon-allow-overlap')
    : 'never';
  const textIgnorePlacement = firstLayout?.get('text-ignore-placement') === true;
  const iconIgnorePlacement = firstLayout?.get('icon-ignore-placement') === true;
  // Text and icon buffers own separate placed-symbol arrays; the glyph
  // offsets and line vertices are shared per bucket.
  const lineDataFor = (placed: LineDataView['placed'], keepUpright: boolean): LineDataView => ({
    keepUpright,
    rotateToLine: firstLayout?.get('text-rotation-alignment') === 'map',
    placed,
    glyphOffsetX: index => bucket.glyphOffsetArray.getoffsetX(index),
    linePointX: index => bucket.lineVertexArray.getx(index),
    linePointY: index => bucket.lineVertexArray.gety(index),
  });
  // Composite and camera sizes carry the two zoom stops their packed values
  // belong to; the shader interpolates them by the live camera zoom. Constant
  // and source kinds leave the vertex untouched.
  const textSize = partSize(bucket.textSizeData);
  const iconSize = partSize(bucket.iconSizeData);
  // A bucket carries one layer; its per-part program configuration holds the
  // data-driven paint arrays (text filters to text* properties, icon to
  // icon*), so a missing entry means a constant paint and no vertex colors.
  const bucketLayer = bucket.layers?.[0];
  const textPaintConfig = bucketLayer
    ? bucket.text.programConfigurations.programConfigurations[bucketLayer.id]
    : undefined;
  const iconPaintConfig = bucketLayer
    ? bucket.icon.programConfigurations.programConfigurations[bucketLayer.id]
    : undefined;
  const textPaint: SymbolPaintView | undefined = textPaintConfig
    ? { config: textPaintConfig, colorProperty: 'text-color', haloProperty: 'text-halo-color', zoom: bucket.zoom }
    : undefined;
  const iconPaint: SymbolPaintView | undefined = iconPaintConfig
    ? { config: iconPaintConfig, colorProperty: 'icon-color', zoom: bucket.zoom }
    : undefined;
  const textOrdinals: number[] = [];
  const linePlacement = firstLayout?.get('symbol-placement') !== 'point';
  const textAlongLine = linePlacement && firstLayout?.get('text-rotation-alignment') === 'map';
  const iconAlongLine = linePlacement && firstLayout?.get('icon-rotation-alignment').constantOr('viewport') === 'map';
  const collision = { boxes: collisionBoxArray, tilePixelRatio: bucket.tilePixelRatio, layoutZoom: bucket.zoom, textPadding: firstLayout?.get('text-padding') ?? 0 };
  const text = extractGeometry(
    bucket.text as unknown as SymbolBuffersView,
    instances as unknown as { length: number; get: (index: number) => SymbolInstanceRow },
    tileID,
    'text',
    true,
    textSize,
    textOverlapMode,
    textIgnorePlacement,
    firstLayout?.get('text-pitch-alignment') === 'viewport',
    (textAlongLine || !linePlacement) && firstLayout?.get('text-pitch-alignment') === 'map',
    !bucketLayer?._unevaluatedLayout.hasValue('icon-offset'),
    collision,
    textAlongLine ? lineDataFor(bucket.text.placedSymbolArray as unknown as LineDataView['placed'], firstLayout?.get('text-keep-upright') === true) : undefined,
    textOrdinals,
    textPaint,
    !linePlacement && firstLayout?.get('text-pitch-alignment') === 'map' ? firstLayout?.get('text-rotation-alignment') === 'map' ? 'map' : 'viewport' : undefined,
  );
  if (text) {
    result.text = text;
  }
  const iconOrdinals: number[] = [];
  const icon = extractGeometry(
    bucket.icon as unknown as SymbolBuffersView,
    instances as unknown as { length: number; get: (index: number) => SymbolInstanceRow },
    tileID,
    'icon',
    iconSdf,
    iconSize,
    iconOverlapMode,
    iconIgnorePlacement,
    firstLayout?.get('icon-pitch-alignment') === 'viewport',
    (iconAlongLine || !linePlacement) && firstLayout?.get('icon-pitch-alignment') === 'map',
    !bucketLayer?._unevaluatedLayout.hasValue('icon-offset'),
    collision,
    iconAlongLine ? lineDataFor(bucket.icon.placedSymbolArray as unknown as LineDataView['placed'], firstLayout?.get('icon-keep-upright') === true) : undefined,
    iconOrdinals,
    iconPaint,
    !linePlacement && firstLayout?.get('icon-pitch-alignment') === 'map' ? firstLayout?.get('icon-rotation-alignment').constantOr('viewport') === 'map' ? 'map' : 'viewport' : undefined,
  );
  if (icon) {
    result.icon = icon;
  }
  // Pair the two halves per worker symbol instance (both ordinal lists are
  // ascending): the placement pass needs it for MapLibre's
  // text-optional/icon-optional combine step.
  if (text || icon) {
    const pairs: Array<{ text: number; icon: number }> = [];
    let ti = 0;
    let ii = 0;
    while (ti < textOrdinals.length || ii < iconOrdinals.length) {
      const t = ti < textOrdinals.length ? textOrdinals[ti] : Number.POSITIVE_INFINITY;
      const s = ii < iconOrdinals.length ? iconOrdinals[ii] : Number.POSITIVE_INFINITY;
      const ordinal = Math.min(t, s);
      const textIndex = t === ordinal ? ti++ : -1;
      const iconIndex = s === ordinal ? ii++ : -1;
      pairs.push({ text: textIndex, icon: iconIndex });
    }
    result.pairs = pairs;
  }
  byTile.set(key, result);
  return generationGeometry(result);
}
