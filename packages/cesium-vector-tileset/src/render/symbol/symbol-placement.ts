import type { OverlapMode } from '../../style/style-layer/overlap-mode';
import type { SymbolPrimitiveGeometry } from './symbol-geometry';
import Point from '@mapbox/point-geometry';
import { clipLine } from '../../symbol/clip-line';
import { projectGlyphsAlongLine } from './symbol-geometry';
import { symbolGroundPosition, symbolMapPerspectiveRatio, symbolMercatorDelta, symbolMercatorPosition, symbolMetersPerPixel, symbolPerspectiveRatio, symbolViewportGroundAxes } from './symbol-perspective';

/**
 * Reserved live-draw validity value in a_dynamic.z. projectGlyphsAlongLine
 * produces atan2 [-PI, PI] plus at most 2*PI, hence [-PI, 3*PI]; point
 * geometries carry zero dynamic angle. 16 is exact Float32 and disjoint.
 */
export const INVALID_LINE_ANGLE = 16;

/**
 * The camera state the collision pass needs: the world-to-clip matrix, so an
 * ECEF anchor turns into the same pixel position the vertex shader produces.
 * The matrix maps FULL world coordinates (homogeneous w = 1): never subtract
 * the camera position first — the view matrix already carries the
 * world-to-eye translation, and subtracting it again collapses every anchor
 * onto one meaningless point (plus the untouched m[15]).
 */
export interface PlacementView {
  /** Column-major 4x4 world-to-clip, matching Cesium's Matrix4 layout. */
  viewProjection: ArrayLike<number>;
  /** Match Cesium's projected z,x,y world position in 2D / Columbus View. */
  projectPosition?: (x: number, y: number, z: number) => readonly [number, number, number] | undefined;
  /** Frozen-camera ellipsoid occlusion in 3D; absent in planar views. */
  isPointVisible?: (x: number, y: number, z: number) => boolean;
  /** Drawing buffer size in device pixels. */
  width: number;
  height: number;
  /** Active Cesium viewport in device pixels, with a bottom-left origin. */
  viewport?: { x: number; y: number; width: number; height: number };
  pixelRatio: number;
  /**
   * Live style zoom. Composite symbol sizes carry two zoom stops per vertex
   * and the collision box must use the same interpolated size the vertex
   * shader draws (`u_camera_zoom`).
   */
  cameraZoom: number;
  /** Focus distance and clip W share Native world units. */
  cameraToCenterDistance: number | undefined;
  orthographic: boolean;
  /** Actual scene projection, frozen with the camera rather than inferred from its position. */
  mercatorProjection: boolean;
}

/**
 * The size one symbol draws at, given its packed vertex fields. Mirrors the
 * vertex shader's `mix(sizeMin, sizeMax, zoomT)` exactly: the same clamp and
 * the same fallback when the vertex carries no zoom range.
 */
export function interpolatedSymbolSize(
  packed: number,
  sizeMax: number,
  zoomMin: number,
  zoomMax: number,
  cameraZoom: number,
): number {
  const sizeMin = Math.floor(packed / 4) / 128;
  if (!(zoomMax > zoomMin)) {
    return sizeMin;
  }
  const t = Math.min(1, Math.max(0, (cameraZoom - zoomMin) / (zoomMax - zoomMin)));
  const upper = Math.max(sizeMin, sizeMax / 128);
  return sizeMin + (upper - sizeMin) * t;
}

/**
 * projection * view, written into a column-major array the placement pass can
 * walk directly. Cesium's Matrix4 stores elements as column * 4 + row.
 */
export function symbolViewProjection(
  view: ArrayLike<number>,
  projection: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) {
        value += projection[k * 4 + row] * view[col * 4 + k];
      }
      out[col * 4 + row] = value;
    }
  }
  return out;
}

/**
 * Whether two matrices describe the same screen projection. Collision and
 * line placement consume clip X/Y/W; Cesium adjusts clip Z's near/far range
 * even with a stationary camera, so row 2 cannot invalidate those passes.
 * Keep the existing relative epsilon for native floating-point jitter. Callers
 * compare against a retained placement snapshot so small motion accumulates.
 */
export function sameViewProjection(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) {
    if (i % 4 === 2) {
      continue;
    }
    const scale = Math.max(1, Math.abs(a[i]), Math.abs(b[i]));
    if (Math.abs(a[i] - b[i]) > scale * 1e-5) {
      return false;
    }
  }
  return true;
}

/** Grid cell size in device pixels. */
const CELL_PX = 64;
const MAX_BOX_CELLS = 256;

interface Circle { x: number; y: number; radius: number }
interface Box {
  circles?: readonly Circle[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface PlacedBox {
  box: Box;
  overlapMode: OverlapMode;
}

/** MapLibre runtime circles use raw viewport perspective even for map-pitched text. */
function lineCollisionCircles(path: readonly { x: number; y: number }[], radius: number, width: number, height: number): Box | undefined {
  if (!Number.isFinite(radius) || radius <= 0 || path.length === 0)
    return undefined;
  const padding = 100;
  const points = path.map(point => new Point(point.x, point.y));
  const inside = points.every(point => point.x >= -padding && point.x <= width + padding && point.y >= -padding && point.y <= height + padding);
  const segments = inside ? [points] : clipLine([points], -padding, -padding, width + padding, height + padding);
  const circles: Circle[] = [];
  for (const segment of segments) {
    if (segment.length === 0)
      continue;
    const distances = [0];
    for (let index = 1; index < segment.length; index++)
      distances.push(distances[index - 1] + segment[index].dist(segment[index - 1]));
    const length = distances[distances.length - 1];
    const inset = Math.min(radius * 0.25, length * 0.5);
    const paddedLength = length - 2 * inset;
    const count = length <= 0.5 * radius ? 1 : Math.ceil(paddedLength / (radius * 2.5)) + 1;
    let leg = 1;
    for (let index = 0; index < count; index++) {
      const distance = inset + index / Math.max(count - 1, 1) * paddedLength;
      while (leg < segment.length - 1 && distances[leg] < distance)
        leg++;
      const before = segment[Math.max(0, leg - 1)];
      const after = segment[Math.min(leg, segment.length - 1)];
      const span = distances[Math.min(leg, segment.length - 1)] - distances[Math.max(0, leg - 1)];
      const t = span > 0 ? (distance - distances[leg - 1]) / span : 0;
      circles.push({ x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t, radius });
    }
  }
  if (circles.length === 0)
    return undefined;
  return {
    circles,
    x1: Math.min(...circles.map(circle => circle.x - circle.radius)),
    y1: Math.min(...circles.map(circle => circle.y - circle.radius)),
    x2: Math.max(...circles.map(circle => circle.x + circle.radius)),
    y2: Math.max(...circles.map(circle => circle.y + circle.radius)),
  };
}

function blocksOverlap(current: OverlapMode, previous: OverlapMode): boolean {
  return current === 'never' || (current === 'cooperative' && previous === 'never');
}

function boxesOverlap(a: Box, b: Box): boolean {
  if (!(a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1))
    return false;
  if (a.circles && b.circles)
    return a.circles.some(first => b.circles!.some(second => Math.hypot(first.x - second.x, first.y - second.y) < first.radius + second.radius));
  if (a.circles || b.circles) {
    const circles = a.circles ?? b.circles!;
    const box = a.circles ? b : a;
    return circles.some((circle) => {
      const x = Math.max(box.x1, Math.min(box.x2, circle.x));
      const y = Math.max(box.y1, Math.min(box.y2, circle.y));
      return Math.hypot(circle.x - x, circle.y - y) < circle.radius;
    });
  }
  return true;
}

function cellKey(cx: number, cy: number): number {
  return (cx + 4096) * 8192 + (cy + 4096);
}

function boxCells(box: Box): Box | undefined {
  const x1 = Math.floor(box.x1 / CELL_PX);
  const x2 = Math.floor(box.x2 / CELL_PX);
  const y1 = Math.floor(box.y1 / CELL_PX);
  const y2 = Math.floor(box.y2 / CELL_PX);
  // Perspective can make a finite box arbitrarily large near camera W=0.
  // Keep its exact collision shape without expanding every covered cell or
  // incrementing a coordinate beyond JavaScript's exact integer range.
  if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_BOX_CELLS
    || !Number.isSafeInteger(x1) || !Number.isSafeInteger(x2)
    || !Number.isSafeInteger(y1) || !Number.isSafeInteger(y2)
    || !Number.isSafeInteger(cellKey(x1, y1)) || !Number.isSafeInteger(cellKey(x2, y2))) {
    return undefined;
  }
  return { x1, x2, y1, y2 };
}

/**
 * Rotate a y-down screen offset by a tile-space segment angle, using the
 * rotation MapLibre effectively applies on screen (R_ydown):
 * x' = x*cos - y*sin, y' = x*sin + y*cos. This equals MapLibre's
 * R_down(-phi) with phi negated at the segment_angle = -a_projected_pos[2]
 * step, so glyph-east lands on the line direction without mirroring.
 * Exported for unit tests.
 */
export function rotateOffsetYDown(ox: number, oy: number, angle: number): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: ox * cos - oy * sin, y: ox * sin + oy * cos };
}

/**
 * Screen-space occupancy grid. Entries retain their overlap mode so a
 * cooperative symbol can distinguish earlier never and cooperative symbols.
 */
export class SymbolCollisionIndex {
  private _cells: Map<number, PlacedBox[]> = new Map();

  private readonly _boxes: PlacedBox[] = [];

  private readonly _largeBoxes: PlacedBox[] = [];

  clear(): void {
    this._cells.clear();
    this._boxes.length = 0;
    this._largeBoxes.length = 0;
  }

  /** Whether an earlier box blocks this symbol (pure check). */
  collides(box: Box, overlapMode: OverlapMode): boolean {
    if (overlapMode === 'always') {
      return false;
    }
    const cells = boxCells(box);
    const candidates = cells ? this._largeBoxes : this._boxes;
    for (const other of candidates) {
      if (blocksOverlap(overlapMode, other.overlapMode) && boxesOverlap(box, other.box))
        return true;
    }
    if (!cells)
      return false;
    for (let cx = cells.x1; cx <= cells.x2; cx++) {
      for (let cy = cells.y1; cy <= cells.y2; cy++) {
        const list = this._cells.get(cellKey(cx, cy));
        if (!list) {
          continue;
        }
        for (const other of list) {
          if (blocksOverlap(overlapMode, other.overlapMode) && boxesOverlap(box, other.box)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Reserve a placed symbol, including one allowed to overlap earlier boxes. */
  reserve(box: Box, overlapMode: OverlapMode): void {
    const placed = { box, overlapMode };
    this._boxes.push(placed);
    const cells = boxCells(box);
    if (!cells) {
      this._largeBoxes.push(placed);
      return;
    }
    for (let cx = cells.x1; cx <= cells.x2; cx++) {
      for (let cy = cells.y1; cy <= cells.y2; cy++) {
        const key = cellKey(cx, cy);
        let list = this._cells.get(key);
        if (!list) {
          list = [];
          this._cells.set(key, list);
        }
        list.push(placed);
      }
    }
  }
}

/** Optional halves and the worker's per-symbol text/icon pairing. */
export interface SymbolPlacementOptions {
  pairs: ReadonlyArray<{ text: number; icon: number }>;
  textOptional?: boolean;
  iconOptional?: boolean;
}

interface SymbolSelectionVisibility {
  text: Uint8Array;
  icon: Uint8Array;
}

/** A completed candidate set; camera filtering never promotes hidden halves. */
export class SymbolTileSelection {
  readonly view: PlacementView;

  private readonly _text: SymbolPrimitiveGeometry | undefined;

  private readonly _icon: SymbolPrimitiveGeometry | undefined;

  private readonly _visibility: SymbolSelectionVisibility;

  private readonly _pairs: SymbolPlacementOptions['pairs'];

  private readonly _textOptional: boolean;

  private readonly _iconOptional: boolean;

  private _placement: SymbolTilePlacement | undefined;

  constructor(text: SymbolPrimitiveGeometry | undefined, icon: SymbolPrimitiveGeometry | undefined, view: PlacementView, options: SymbolPlacementOptions, visibility: SymbolSelectionVisibility) {
    this._text = text;
    this._icon = icon;
    this.view = view;
    this._visibility = visibility;
    this._textOptional = options.textOptional === true;
    this._iconOptional = options.iconOptional === true;
    this._pairs = options.pairs.filter(pair => visibility.text[pair.text] || visibility.icon[pair.icon]);
  }

  /** Whether this frozen pass selected any recoverable text/icon pair. */
  get hasCandidates(): boolean {
    return this._pairs.length > 0;
  }

  /** Reuse the sparse baseline pairs, including temporarily filtered candidates. */
  * instanceIndices(part: 'text' | 'icon'): IterableIterator<number> {
    const visibility = this._visibility[part];
    for (const pair of this._pairs) {
      const index = pair[part];
      if (visibility[index]) {
        yield index;
      }
    }
  }

  matchesOptions(options: SymbolPlacementOptions): boolean {
    return this._textOptional === (options.textOptional === true) && this._iconOptional === (options.iconOptional === true);
  }

  /** Reuse the normal paired collision rules, visiting only baseline candidates. */
  filter(view: PlacementView, index: SymbolCollisionIndex, options: SymbolPlacementOptions, projections: SymbolProjectionContext): boolean {
    const selectedOptions = { ...options, pairs: this._pairs };
    if (!this._placement) {
      this._placement = new SymbolTilePlacement(this._text, this._icon, view, index, selectedOptions, this._visibility);
    }
    else {
      this._placement.reset(view, index, selectedOptions);
    }
    this._placement.advance(Number.POSITIVE_INFINITY, projections);
    return this._placement.commit();
  }
}

/**
 * One batch's collision decisions, staged independently of drawable opacity.
 * advance() bounds both box projection and collision queries by symbol count;
 * commit() publishes the completed decisions. Synchronous placement uses the
 * same implementation, so paired/optional semantics cannot drift.
 */
export class SymbolTilePlacement {
  private readonly _text: SymbolPrimitiveGeometry | undefined;

  private readonly _icon: SymbolPrimitiveGeometry | undefined;

  private _view: PlacementView;

  private _index: SymbolCollisionIndex;

  private _options: SymbolPlacementOptions;

  private readonly _eligibility: SymbolSelectionVisibility | undefined;

  private readonly _textVisibility: Uint8Array;

  private readonly _iconVisibility: Uint8Array;

  private _cursor = 0;

  private _done = false;

  private _selectedHalves = 0;

  private _selection: SymbolTileSelection | undefined;

  constructor(
    text: SymbolPrimitiveGeometry | undefined,
    icon: SymbolPrimitiveGeometry | undefined,
    view: PlacementView,
    index: SymbolCollisionIndex,
    options: SymbolPlacementOptions,
    eligibility?: SymbolSelectionVisibility,
  ) {
    this._text = text;
    this._icon = icon;
    this._view = view;
    this._index = index;
    this._options = options;
    this._eligibility = eligibility;
    this._textVisibility = new Uint8Array(text?.instances.length ?? 0);
    this._iconVisibility = new Uint8Array(icon?.instances.length ?? 0);
  }

  get done(): boolean {
    return this._done;
  }

  /** Pair-by-pair metadata, available without constructing the selection. */
  get hasCandidates(): boolean {
    return this._selectedHalves > 0;
  }

  get selection(): SymbolTileSelection {
    if (!this._done) {
      throw new Error('Cannot select unfinished symbol placement');
    }
    return this._selection ??= new SymbolTileSelection(this._text, this._icon, this._view, this._options, { text: this._textVisibility, icon: this._iconVisibility });
  }

  /** Restart only the reusable current-view filter, never a target generation. */
  reset(view: PlacementView, index: SymbolCollisionIndex, options: SymbolPlacementOptions): void {
    if (!this._eligibility) {
      throw new Error('Only selected symbol placement can be reset');
    }
    this._view = view;
    this._index = index;
    this._options = options;
    this._cursor = 0;
    this._done = false;
  }

  /** Advance at most maxInstances worker pairs. Missing halves use -1. */
  advance(maxInstances: number, projections: SymbolProjectionContext): number {
    const end = Math.min(this._cursor + maxInstances, this._options.pairs.length);
    const start = this._cursor;
    while (this._cursor < end) {
      this._placePair(this._options.pairs[this._cursor++], projections);
    }
    this._done = this._cursor === this._options.pairs.length;
    return this._cursor - start;
  }

  /**
   * @internal
   */
  private _placePair(pair: { text: number; icon: number }, projections: SymbolProjectionContext): void {
    const text = pair.text === -1 ? undefined : this._text!;
    const icon = pair.icon === -1 ? undefined : this._icon!;
    const textAlwaysShow = text?.overlapMode === 'always' && (icon?.overlapMode === 'always' || !icon || this._options.iconOptional === true);
    const iconAlwaysShow = icon?.overlapMode === 'always' && (text?.overlapMode === 'always' || !text || this._options.textOptional === true);
    const textBox = text && (!this._eligibility || this._eligibility.text[pair.text]) && symbolBox(text, this._view, pair.text, projections, textAlwaysShow);
    const iconBox = icon && (!this._eligibility || this._eligibility.icon[pair.icon]) && symbolBox(icon, this._view, pair.icon, projections, iconAlwaysShow);
    let placeText = !!textBox && !this._index.collides(textBox, text!.overlapMode);
    let placeIcon = !!iconBox && !this._index.collides(iconBox, icon!.overlapMode);
    const iconWithoutText = this._options.textOptional || !text;
    const textWithoutIcon = this._options.iconOptional || !icon;
    if (!iconWithoutText && !textWithoutIcon) {
      placeText = placeIcon = placeText && placeIcon;
    }
    else if (!textWithoutIcon) {
      placeText = placeIcon && placeText;
    }
    else if (!iconWithoutText) {
      placeIcon = placeText && placeIcon;
    }
    // Reserve only after BOTH verdicts, so a pair never blocks its own peer.
    if (text) {
      const visible = placeText ? 1 : 0;
      this._selectedHalves += visible - this._textVisibility[pair.text];
      this._textVisibility[pair.text] = visible;
      if (placeText && textBox && !text.ignorePlacement) {
        this._index.reserve(textBox, text.overlapMode);
      }
    }
    if (icon) {
      const visible = placeIcon ? 1 : 0;
      this._selectedHalves += visible - this._iconVisibility[pair.icon];
      this._iconVisibility[pair.icon] = visible;
      if (placeIcon && iconBox && !icon.ignorePlacement) {
        this._index.reserve(iconBox, icon.overlapMode);
      }
    }
  }

  /** Publish a completed batch into its CPU opacity arrays. */
  commit(): boolean {
    if (!this._done) {
      throw new Error('Cannot commit unfinished symbol placement');
    }
    if (this._eligibility) {
      let changed = false;
      for (const pair of this._options.pairs) {
        if (this._eligibility.text[pair.text]) {
          changed = commitInstanceVisibility(this._text!, pair.text, this._textVisibility[pair.text]) || changed;
        }
        if (this._eligibility.icon[pair.icon]) {
          changed = commitInstanceVisibility(this._icon!, pair.icon, this._iconVisibility[pair.icon]) || changed;
        }
      }
      return changed;
    }
    const textChanged = commitVisibility(this._text, this._textVisibility);
    const iconChanged = commitVisibility(this._icon, this._iconVisibility);
    return textChanged || iconChanged;
  }
}

function commitInstanceVisibility(geometry: SymbolPrimitiveGeometry, index: number, opacity: number): boolean {
  const instance = geometry.instances[index];
  if (geometry.opacities[instance.vertexStart] === opacity) {
    return false;
  }
  geometry.opacities.fill(opacity, instance.vertexStart, instance.vertexStart + instance.vertexCount);
  geometry.opacityDirty = true;
  return true;
}

function commitVisibility(geometry: SymbolPrimitiveGeometry | undefined, visibility: Uint8Array): boolean {
  if (!geometry) {
    return false;
  }
  let changed = false;
  for (let i = 0; i < geometry.instances.length; i++) {
    changed = commitInstanceVisibility(geometry, i, visibility[i]) || changed;
  }
  return changed;
}

/** Place and commit one batch synchronously through the resumable implementation. */
export function placeSymbolTile(
  text: SymbolPrimitiveGeometry | undefined,
  icon: SymbolPrimitiveGeometry | undefined,
  view: PlacementView,
  index: SymbolCollisionIndex,
  options: SymbolPlacementOptions,
): boolean {
  const placement = new SymbolTilePlacement(text, icon, view, index, options);
  placement.advance(Number.POSITIVE_INFINITY, new SymbolProjectionContext());
  return placement.commit();
}

/**
 * Screen-space boxes for every instance of one batch, without touching the
 * collision index. `undefined` marks frustum-culled instances.
 */
export function projectToScreen(
  viewProjection: ArrayLike<number>,
  width: number,
  height: number,
  wx: number,
  wy: number,
  wz: number,
  projectPosition?: PlacementView['projectPosition'],
  viewport?: PlacementView['viewport'],
): { sx: number; sy: number; clipW: number } | undefined {
  if (projectPosition) {
    const projected = projectPosition(wx, wy, wz);
    if (!projected) {
      return undefined;
    }
    [wx, wy, wz] = projected;
  }
  const clipW = viewProjection[3] * wx + viewProjection[7] * wy + viewProjection[11] * wz + viewProjection[15];
  if (clipW <= 0) {
    return undefined;
  }
  const clipX = viewProjection[0] * wx + viewProjection[4] * wy + viewProjection[8] * wz + viewProjection[12];
  const clipY = viewProjection[1] * wx + viewProjection[5] * wy + viewProjection[9] * wz + viewProjection[13];
  return {
    clipW,
    sx: (clipX / clipW * 0.5 + 0.5) * (viewport?.width ?? width) + (viewport?.x ?? 0),
    sy: height - ((clipY / clipW * 0.5 + 0.5) * (viewport?.height ?? height) + (viewport?.y ?? 0)),
  };
}

interface ProjectedLine {
  anchor: NonNullable<ReturnType<typeof projectToScreen>>;
  perspective: number;
  /** Original per-glyph positions, projected only when a consumer needs them. */
  baked: (glyph: number) => ReturnType<typeof projectToScreen>;
  points: Array<{ x: number; y: number }>;
  angles: number[];
  flipped: boolean;
  path: Array<{ x: number; y: number }>;
  /** Absolute Mercator ground metres; present only for map-pitched paths. */
  labelPoints?: Array<{ x: number; y: number }>;
}

const linePlanes = new WeakMap<NonNullable<SymbolPrimitiveGeometry['instances'][number]['line']>, { anchor: { x: number; y: number }; path: Array<{ x: number; y: number }> }>();
function linePlane(line: NonNullable<SymbolPrimitiveGeometry['instances'][number]['line']>) {
  let plane = linePlanes.get(line);
  if (!plane) {
    const anchor = symbolMercatorPosition(line.anchorECEF.x, line.anchorECEF.y, line.anchorECEF.z);
    if (!anchor)
      return undefined;
    const path: Array<{ x: number; y: number }> = [];
    for (let index = 0; index < line.pathECEF.length; index += 3) {
      const point = symbolMercatorPosition(line.pathECEF[index], line.pathECEF[index + 1], line.pathECEF[index + 2]);
      if (!point)
        return undefined;
      point.x = anchor.x + symbolMercatorDelta(point.x, anchor.x);
      path.push(point);
    }
    plane = { anchor, path };
    linePlanes.set(line, plane);
  }
  return plane;
}

/** Lazy line results shared only within one renderer operation. */
export class SymbolProjectionContext {
  private readonly _views = new WeakMap<PlacementView, WeakMap<SymbolPrimitiveGeometry, Map<number, ProjectedLine | undefined>>>();

  line(geometry: SymbolPrimitiveGeometry, instanceIndex: number, view: PlacementView): ProjectedLine | undefined {
    let geometries = this._views.get(view);
    if (!geometries) {
      geometries = new WeakMap();
      this._views.set(view, geometries);
    }
    let instances = geometries.get(geometry);
    if (!instances) {
      instances = new Map();
      geometries.set(geometry, instances);
    }
    if (!instances.has(instanceIndex))
      instances.set(instanceIndex, projectLineInstance(geometry, instanceIndex, view));
    return instances.get(instanceIndex);
  }
}

/** A frozen-view projection shared by collision and live line attributes. */
function projectLineInstance(geometry: SymbolPrimitiveGeometry, instanceIndex: number, view: PlacementView): ProjectedLine | undefined {
  const line = geometry.instances[instanceIndex].line!;
  if (line.pathECEF.length < 6 || (view.isPointVisible && !view.isPointVisible(line.anchorECEF.x, line.anchorECEF.y, line.anchorECEF.z)))
    return undefined;
  const anchor = projectToScreen(view.viewProjection, view.width, view.height, line.anchorECEF.x, line.anchorECEF.y, line.anchorECEF.z, view.projectPosition, view.viewport);
  if (!anchor)
    return undefined;
  const vertex = geometry.instances[instanceIndex].vertexStart;
  const size = interpolatedSymbolSize(geometry.sizes[vertex], geometry.sizesMax[vertex], geometry.sizeZooms[vertex * 2], geometry.sizeZooms[vertex * 2 + 1], view.cameraZoom);
  const ratio = geometry.viewportPerspective || geometry.mapPitch ? symbolPerspectiveRatio(view.cameraToCenterDistance, anchor.clipW, view.orthographic) : 1;
  if (ratio === undefined)
    return undefined;
  const plane = geometry.mapPitch ? linePlane(line) : undefined;
  const metresPerPixel = geometry.mapPitch ? symbolMetersPerPixel(view.cameraZoom) : 1;
  if ((geometry.mapPitch && !plane) || !Number.isFinite(metresPerPixel) || metresPerPixel <= 0)
    return undefined;
  const scale = size / 24 * (geometry.mapPitch ? metresPerPixel / ratio : view.pixelRatio * ratio);
  const length = line.pathECEF.length / 3;
  const projections = new Map<number, { x: number; y: number }>();
  const screenVertex = (index: number, previous: { x: number; y: number }, direction: 1 | -1, travelled: number, required: number): { x: number; y: number } | undefined => {
    const cached = projections.get(index);
    if (cached)
      return cached;
    if (index < 0 || index >= length)
      return undefined;
    const base = index * 3;
    const point = projectToScreen(view.viewProjection, view.width, view.height, line.pathECEF[base], line.pathECEF[base + 1], line.pathECEF[base + 2], view.projectPosition, view.viewport);
    if (point) {
      const projected = { x: point.sx, y: point.sy };
      projections.set(index, projected);
      return projected;
    }
    // MapLibre creates a synthetic label-plane vertex in the direction of
    // a camera-crossing leg, just beyond the remaining glyph distance.
    // A one-metre Mercator step away from that endpoint establishes this
    // direction using the actual Native world projection, without dividing
    // a behind-camera point or projecting unrelated road vertices.
    const previousIndex = index - direction;
    const from = travelled === 0 ? line.anchorECEF : { x: line.pathECEF[previousIndex * 3], y: line.pathECEF[previousIndex * 3 + 1], z: line.pathECEF[previousIndex * 3 + 2] };
    const fromPlane = symbolMercatorPosition(from.x, from.y, from.z);
    const toPlane = symbolMercatorPosition(line.pathECEF[base], line.pathECEF[base + 1], line.pathECEF[base + 2]);
    if (!fromPlane || !toPlane)
      return undefined;
    const dx = symbolMercatorDelta(fromPlane.x, toPlane.x);
    const dy = fromPlane.y - toPlane.y;
    const distance = Math.hypot(dx, dy);
    if (!(distance > 0))
      return undefined;
    const unit = symbolGroundPosition(fromPlane.x + dx / distance, fromPlane.y + dy / distance);
    const projected = projectToScreen(view.viewProjection, view.width, view.height, unit.x, unit.y, unit.z, view.projectPosition, view.viewport);
    if (!projected)
      return undefined;
    const sx = previous.x - projected.sx;
    const sy = previous.y - projected.sy;
    const screenDistance = Math.hypot(sx, sy);
    if (!(screenDistance > 0))
      return undefined;
    const minimumLength = required - travelled + 1;
    return { x: previous.x + sx * minimumLength / screenDistance, y: previous.y + sy * minimumLength / screenDistance };
  };
  const labelAnchor = plane?.anchor ?? { x: anchor.sx, y: anchor.sy };
  const walk = (flip: boolean) => projectGlyphsAlongLine(
    index => plane!.path[index].x,
    index => plane!.path[index].y,
    0,
    length,
    labelAnchor.x,
    labelAnchor.y,
    line.segment,
    Array.from(line.glyphOffsets, offset => offset * scale),
    line.lineOffsetX * scale,
    { flip, lineOffsetY: line.lineOffsetY * scale, rotateToLine: line.rotateToLine, project: geometry.mapPitch ? undefined : screenVertex },
  );
  const groundProjections = new WeakMap<{ x: number; y: number }, { x: number; y: number }>();
  const groundScreen = (point: { x: number; y: number }) => {
    const cached = groundProjections.get(point);
    if (cached)
      return cached;
    const world = symbolGroundPosition(point.x, point.y);
    if (view.isPointVisible && !view.isPointVisible(world.x, world.y, world.z))
      return undefined;
    const projected = projectToScreen(view.viewProjection, view.width, view.height, world.x, world.y, world.z, view.projectPosition, view.viewport);
    if (!projected)
      return undefined;
    const screen = { x: projected.sx, y: projected.sy };
    groundProjections.set(point, screen);
    return screen;
  };
  const toScreen = (point: { x: number; y: number }) => geometry.mapPitch ? groundScreen(point) : point;
  let placement = walk(false);
  if (!placement)
    return undefined;
  if (line.keepUpright) {
    const first = toScreen(placement.points[0]);
    let last = toScreen(placement.points[placement.points.length - 1]);
    if (placement.points.length === 1) {
      if (plane) {
        const end = plane.path[line.segment + 1];
        const dx = end.x - plane.anchor.x;
        const dy = end.y - plane.anchor.y;
        const distance = Math.hypot(dx, dy);
        if (!(distance > 0))
          return undefined;
        last = groundScreen({ x: plane.anchor.x + dx / distance * metresPerPixel, y: plane.anchor.y + dy / distance * metresPerPixel });
      }
      else {
        last = screenVertex(line.segment + 1, labelAnchor, 1, 0, 1);
      }
    }
    if (!first || !last)
      return undefined;
    // Primary orientation is determined after world projection, even for
    // map-pitched labels. Screen Y is opposite MapLibre's clip-space Y.
    if (line.writingMode === 2 ? first.y > last.y : first.x > last.x) {
      placement = walk(true);
      if (!placement)
        return undefined;
    }
  }
  let bakedProjections: Map<number, ReturnType<typeof projectToScreen>> | undefined;
  const baked = (glyph: number) => {
    bakedProjections ??= new Map();
    if (!bakedProjections.has(glyph)) {
      const source = (vertex + glyph * 4) * 3;
      bakedProjections.set(glyph, projectToScreen(view.viewProjection, view.width, view.height, geometry.positions[source], geometry.positions[source + 1], geometry.positions[source + 2], view.projectPosition, view.viewport));
    }
    return bakedProjections.get(glyph);
  };
  if (!geometry.mapPitch)
    return { ...placement, anchor, perspective: ratio, baked };
  const points = placement.points.map(groundScreen);
  const path = placement.path.map(groundScreen);
  if (points.some(point => !point) || path.some(point => !point))
    return undefined;
  return { ...placement, anchor, perspective: ratio, baked, points: points.filter((point): point is { x: number; y: number } => point !== undefined), path: path.filter((point): point is { x: number; y: number } => point !== undefined), labelPoints: placement.points };
}

/** Project selected line glyphs along the current screen path. */
export function updateLineSymbolGeometry(geometry: SymbolPrimitiveGeometry, view: PlacementView, instanceIndices: Iterable<number>, projections: SymbolProjectionContext): boolean {
  const { positions, dynamics } = geometry;
  let changed = false;
  for (const i of instanceIndices) {
    const instance = geometry.instances[i];
    const line = instance.line;
    if (!line) {
      continue;
    }
    const placement = projections.line(geometry, i, view);
    if (!placement) {
      changed = hideLineInstance(geometry, i) || changed;
      continue;
    }
    const vertex = instance.vertexStart;
    for (let glyph = 0; glyph < placement.points.length; glyph++) {
      const source = (vertex + glyph * 4) * 3;
      const baked = placement.baked(glyph);
      if (!baked) {
        changed = hideLineInstance(geometry, i) || changed;
        break;
      }
      const point = placement.points[glyph];
      // Compare at the precision actually stored/uploaded: comparing a double
      // with its Float32 rounding marked every unchanged line dirty forever.
      const labelPoint = placement.labelPoints?.[glyph];
      const labelBaked = labelPoint && symbolMercatorPosition(positions[source], positions[source + 1], positions[source + 2]);
      if (labelPoint && !labelBaked) {
        changed = hideLineInstance(geometry, i) || changed;
        break;
      }
      const dx = Math.fround(labelPoint ? symbolMercatorDelta(labelPoint.x, labelBaked!.x) : point.x - baked.sx);
      const dy = Math.fround(labelPoint ? labelPoint.y - labelBaked!.y : point.y - baked.sy);
      const angle = Math.fround(placement.angles[glyph]);
      for (let q = 0; q < 4; q++) {
        const offset = (vertex + glyph * 4 + q) * 3;
        if (dynamics[offset] !== dx || dynamics[offset + 1] !== dy || dynamics[offset + 2] !== angle) {
          dynamics[offset] = dx;
          dynamics[offset + 1] = dy;
          dynamics[offset + 2] = angle;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Live validity is independent of staged collision visibility. */
function hideLineInstance(geometry: SymbolPrimitiveGeometry, instanceIndex: number): boolean {
  const instance = geometry.instances[instanceIndex];
  let changed = false;
  for (let vertex = instance.vertexStart; vertex < instance.vertexStart + instance.vertexCount; vertex++) {
    const angle = vertex * 3 + 2;
    if (geometry.dynamics[angle] !== INVALID_LINE_ANGLE) {
      geometry.dynamics[angle] = INVALID_LINE_ANGLE;
      changed = true;
    }
  }
  return changed;
}

function symbolBox(
  geometry: SymbolPrimitiveGeometry,
  view: PlacementView,
  instanceIndex: number,
  projections: SymbolProjectionContext,
  alwaysShow: boolean,
): Box | undefined {
  const m = view.viewProjection;
  const { width, height, pixelRatio } = view;
  const { positions, offsets, pxoffsets, minfontscales, sizes, sizesMax, sizeZooms, dynamics, instances } = geometry;
  // a_size packs (size * 128) << 2 | isSdf << 1 | isText: text offsets are in
  // 24px-glyph-em pixels (scale size / 24) while icon offsets are already in
  // sprite pixels (scale size directly) — the same split the vertex shader
  // uses. A batch carries one kind, so the first vertex decides for all.
  const isText = instances.length > 0 && Math.floor(sizes[instances[0].vertexStart]) % 2 === 1;

  const project = (wx: number, wy: number, wz: number): { sx: number; sy: number } | undefined =>
    projectToScreen(m, width, height, wx, wy, wz, view.projectPosition, view.viewport);

  const instance = instances[instanceIndex];
  const anchorBase = instance.vertexStart * 3;
  if (view.isPointVisible && !view.isPointVisible(positions[anchorBase], positions[anchorBase + 1], positions[anchorBase + 2])) {
    return undefined;
  }
  const linePlacement = instance.line ? projections.line(geometry, instanceIndex, view) : undefined;
  if (instance.line && !linePlacement) {
    return undefined;
  }
  const packed = sizes[instance.vertexStart];
  // Composite sizes interpolate between the two packed zoom stops; every
  // other size kind stores one value twice and lands on the same size.
  const size = interpolatedSymbolSize(
    packed,
    sizesMax[instance.vertexStart],
    sizeZooms[instance.vertexStart * 2],
    sizeZooms[instance.vertexStart * 2 + 1],
    view.cameraZoom,
  );
  let ratio = 1;
  let rawRatio = 1;
  let pointAnchor: ReturnType<typeof projectToScreen>;
  if (geometry.viewportPerspective || geometry.mapPitch) {
    const anchor = linePlacement ? linePlacement.anchor : projectToScreen(m, width, height, positions[anchorBase], positions[anchorBase + 1], positions[anchorBase + 2], view.projectPosition, view.viewport);
    const perspective = linePlacement ? linePlacement.perspective : anchor && symbolPerspectiveRatio(view.cameraToCenterDistance, anchor.clipW, view.orthographic);
    if (perspective === undefined || (!alwaysShow && perspective < 0.6)) {
      return undefined;
    }
    rawRatio = perspective;
    ratio = geometry.mapPitch ? symbolMapPerspectiveRatio(view.cameraToCenterDistance, anchor!.clipW, view.orthographic)! : perspective;
    if (!instance.line && !geometry.mapPitch) {
      pointAnchor = anchor;
    }
  }
  if (instance.collisionCircles && linePlacement) {
    const metadata = instance.collisionCircles;
    const radius = (metadata.diameter * 0.5 * rawRatio + metadata.padding) * pixelRatio;
    return lineCollisionCircles(linePlacement.path, radius, width, height);
  }
  const collisionSize = size * ratio;
  const fontScale = isText ? collisionSize / 24 : collisionSize;
  // Combined quad corner in y-down screen pixels, matching the vertex
  // shader (offset * max(minFontScale, fontScale) + pxoffset) before its
  // y flip to NDC. Collision stays in y-down space (sy from the top), so
  // no flip here; rotation uses MapLibre's effective on-screen rotation
  // R_ydown, matching the vertex shader's flip + R_down-form composition.
  const combined = (vertex: number): { x: number; y: number } => {
    const offset = vertex * 2;
    const ex = Math.max(minfontscales[offset], fontScale);
    const ey = Math.max(minfontscales[offset + 1], fontScale);
    return {
      x: (offsets[offset] * ex + pxoffsets[offset]) * pixelRatio,
      y: (offsets[offset + 1] * ey + pxoffsets[offset + 1]) * pixelRatio,
    };
  };
  if (instance.line && instance.collisionBox) {
    const box = instance.collisionBox;
    const anchor = linePlacement!.anchor;
    const plane = linePlane(instance.line);
    if (!anchor || !plane)
      return undefined;
    const sizeScale = box.layoutSize > 0 ? size / box.layoutSize : 1;
    let angle = 0;
    if (!geometry.mapPitch) {
      const worldEast = symbolGroundPosition(plane.anchor.x + 1, plane.anchor.y);
      const east = project(worldEast.x, worldEast.y, worldEast.z);
      if (!east)
        return undefined;
      angle = Math.atan2(east.sy - anchor.sy, east.sx - anchor.sx);
    }
    const points: Array<{ sx: number; sy: number }> = [];
    for (const [x, y] of [[box.x1, box.y1], [box.x2, box.y1], [box.x1, box.y2], [box.x2, box.y2]]) {
      if (geometry.mapPitch) {
        const scale = sizeScale * ratio * symbolMetersPerPixel(view.cameraZoom);
        const world = symbolGroundPosition(plane.anchor.x + x * scale, plane.anchor.y + y * scale);
        const corner = project(world.x, world.y, world.z);
        if (!corner)
          return undefined;
        points.push(corner);
      }
      else {
        const corner = rotateOffsetYDown(x * sizeScale * ratio * pixelRatio, y * sizeScale * ratio * pixelRatio, angle);
        points.push({ sx: anchor.sx + corner.x, sy: anchor.sy + corner.y });
      }
    }
    return { x1: Math.min(...points.map(point => point.sx)), y1: Math.min(...points.map(point => point.sy)), x2: Math.max(...points.map(point => point.sx)), y2: Math.max(...points.map(point => point.sy)) };
  }
  if (geometry.mapPitch && !instance.line) {
    const anchor = symbolMercatorPosition(positions[anchorBase], positions[anchorBase + 1], positions[anchorBase + 2]);
    if (!anchor)
      return undefined;
    let axes = { east: { x: 1, y: 0 }, south: { x: 0, y: 1 } };
    if (geometry.pointMapRotation === 'viewport') {
      const world = symbolGroundPosition(anchor.x, anchor.y);
      const origin = view.projectPosition ? view.projectPosition(world.x, world.y, world.z) : [world.x, world.y, world.z];
      if (!origin)
        return undefined;
      const groundAxis = (x: number, y: number) => {
        const world = symbolGroundPosition(x, y);
        const point = view.projectPosition ? view.projectPosition(world.x, world.y, world.z) : [world.x, world.y, world.z];
        if (!point)
          return undefined;
        const dx = point[0] - origin[0];
        const dy = point[1] - origin[1];
        const dz = point[2] - origin[2];
        // Use undivided clip XY. Dividing by W would add the off-axis
        // perspective derivative, which is absent from the label plane.
        return {
          x: (m[0] * dx + m[4] * dy + m[8] * dz) * (view.viewport?.width ?? width),
          y: -(m[1] * dx + m[5] * dy + m[9] * dz) * (view.viewport?.height ?? height),
        };
      };
      const east = groundAxis(anchor.x + 1, anchor.y);
      const south = groundAxis(anchor.x, anchor.y + 1);
      if (!east || !south)
        return undefined;
      axes = symbolViewportGroundAxes(east, south);
    }
    const corners = instance.collisionBox
      ? (() => {
          const box = instance.collisionBox!;
          const scale = (box.layoutSize > 0 ? size / box.layoutSize : 1) * ratio;
          return [[box.x1, box.y1], [box.x2, box.y1], [box.x1, box.y2], [box.x2, box.y2]].map(([x, y]) => ({ x: x * scale, y: y * scale }));
        })()
      : Array.from({ length: instance.vertexCount }, (_, index) => {
          const vertex = instance.vertexStart + index;
          const point = combined(vertex);
          return rotateOffsetYDown(point.x / pixelRatio, point.y / pixelRatio, dynamics[vertex * 3 + 2]);
        });
    const scale = symbolMetersPerPixel(view.cameraZoom);
    const points: Array<{ sx: number; sy: number }> = [];
    for (const corner of corners) {
      const x = (axes.east.x * corner.x + axes.south.x * corner.y) * scale;
      const y = (axes.east.y * corner.x + axes.south.y * corner.y) * scale;
      const world = symbolGroundPosition(anchor.x + x, anchor.y + y);
      const point = project(world.x, world.y, world.z);
      if (!point)
        return undefined;
      points.push(point);
    }
    return points.length ? { x1: Math.min(...points.map(point => point.sx)), y1: Math.min(...points.map(point => point.sy)), x2: Math.max(...points.map(point => point.sx)), y2: Math.max(...points.map(point => point.sy)) } : undefined;
  }
  // Line-placed symbols rotate per quad: union the rotated quad boxes.
  // Point symbols share one anchor and zero angles (fast path).
  const rotated = !!instance.line || hasRotation(dynamics, instance.vertexStart, instance.vertexCount);
  if (!rotated) {
    const base = instance.vertexStart * 3;
    const projected = pointAnchor ?? project(positions[base], positions[base + 1], positions[base + 2]);
    if (!projected
      || projected.sx <= -CELL_PX * 4 || projected.sx >= width + CELL_PX * 4
      || projected.sy <= -CELL_PX * 4 || projected.sy >= height + CELL_PX * 4) {
      return undefined;
    }
    if (instance.collisionBox) {
      const box = instance.collisionBox;
      const scale = box.layoutSize > 0 ? size / box.layoutSize * pixelRatio * ratio : pixelRatio * ratio;
      return {
        x1: projected.sx + box.x1 * scale,
        y1: projected.sy + box.y1 * scale,
        x2: projected.sx + box.x2 * scale,
        y2: projected.sy + box.y2 * scale,
      };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < instance.vertexCount; v++) {
      const point = combined(instance.vertexStart + v);
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    return {
      x1: projected.sx + minX,
      y1: projected.sy + minY,
      x2: projected.sx + maxX,
      y2: projected.sy + maxY,
    };
  }
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let q = 0; q < instance.vertexCount; q += 4) {
    const anchorBase = (instance.vertexStart + q) * 3;
    const projected = linePlacement
      ? linePlacement.baked(q / 4)
      : project(
          positions[anchorBase],
          positions[anchorBase + 1],
          positions[anchorBase + 2],
        );
    if (!projected
      || projected.sx < -CELL_PX * 4 || projected.sx > width + CELL_PX * 4
      || projected.sy < -CELL_PX * 4 || projected.sy > height + CELL_PX * 4) {
      continue;
    }
    const dynamic = (instance.vertexStart + q) * 3;
    const glyph = q / 4;
    const angle = linePlacement ? linePlacement.angles[glyph] : dynamics[dynamic + 2];
    const centerX = linePlacement ? linePlacement.points[glyph].x : projected.sx + dynamics[dynamic];
    const centerY = linePlacement ? linePlacement.points[glyph].y : projected.sy + dynamics[dynamic + 1];
    for (let v = 0; v < 4; v++) {
      const point = combined(instance.vertexStart + q + v);
      // R_ydown (MapLibre's effective on-screen rotation): x' = x*cos - y*sin,
      // y' = x*sin + y*cos.
      const rotatedPoint = rotateOffsetYDown(point.x, point.y, angle);
      let sx = centerX + rotatedPoint.x;
      let sy = centerY + rotatedPoint.y;
      if (geometry.mapPitch && linePlacement?.labelPoints) {
        const label = linePlacement.labelPoints[glyph];
        const scale = symbolMetersPerPixel(view.cameraZoom) / pixelRatio;
        const world = symbolGroundPosition(label.x + rotatedPoint.x * scale, label.y + rotatedPoint.y * scale);
        const projectedCorner = project(world.x, world.y, world.z);
        if (!projectedCorner)
          return undefined;
        sx = projectedCorner.sx;
        sy = projectedCorner.sy;
      }
      x1 = Math.min(x1, sx);
      y1 = Math.min(y1, sy);
      x2 = Math.max(x2, sx);
      y2 = Math.max(y2, sy);
    }
  }
  return x1 === Infinity ? undefined : { x1, y1, x2, y2 };
}

function hasRotation(dynamics: Float32Array, start: number, count: number): boolean {
  for (let v = 0; v < count; v++) {
    if (dynamics[(start + v) * 3 + 2] !== 0) {
      return true;
    }
  }
  return false;
}
