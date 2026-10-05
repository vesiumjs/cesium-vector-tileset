// This file is generated. Edit build/generate-struct-arrays.ts, then run `npm run codegen`.

import type { TransferRegistry } from '../worker/transfer-registry';
import Point from '@mapbox/point-geometry';
import { Struct, StructArray } from '../util/struct-array';

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[2]
 *
 * @internal
 */
class StructArrayLayout2i4 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1);
  }

  public emplace(i: number, v0: number, v1: number): number {
    const o2 = i * 2;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    return i;
  }
}

StructArrayLayout2i4.prototype.bytesPerElement = 4;

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[2]
 * [4] - Int16[4]
 *
 * @internal
 */
class StructArrayLayout2i4i12 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number): number {
    const o2 = i * 6;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    this.int16[o2 + 2] = v2;
    this.int16[o2 + 3] = v3;
    this.int16[o2 + 4] = v4;
    this.int16[o2 + 5] = v5;
    return i;
  }
}

StructArrayLayout2i4i12.prototype.bytesPerElement = 12;

/**
 * Implementation of the StructArray layout:
 * [0] - Uint16[10]
 *
 * @internal
 */
class StructArrayLayout10ui20 extends StructArray {
  declare uint8: Uint8Array;
  declare uint16: Uint16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number): number {
    const o2 = i * 10;
    this.uint16[o2 + 0] = v0;
    this.uint16[o2 + 1] = v1;
    this.uint16[o2 + 2] = v2;
    this.uint16[o2 + 3] = v3;
    this.uint16[o2 + 4] = v4;
    this.uint16[o2 + 5] = v5;
    this.uint16[o2 + 6] = v6;
    this.uint16[o2 + 7] = v7;
    this.uint16[o2 + 8] = v8;
    this.uint16[o2 + 9] = v9;
    return i;
  }
}

StructArrayLayout10ui20.prototype.bytesPerElement = 20;

/**
 * Implementation of the StructArray layout:
 * [0] - Uint16[8]
 *
 * @internal
 */
class StructArrayLayout8ui16 extends StructArray {
  declare uint8: Uint8Array;
  declare uint16: Uint16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5, v6, v7);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number): number {
    const o2 = i * 8;
    this.uint16[o2 + 0] = v0;
    this.uint16[o2 + 1] = v1;
    this.uint16[o2 + 2] = v2;
    this.uint16[o2 + 3] = v3;
    this.uint16[o2 + 4] = v4;
    this.uint16[o2 + 5] = v5;
    this.uint16[o2 + 6] = v6;
    this.uint16[o2 + 7] = v7;
    return i;
  }
}

StructArrayLayout8ui16.prototype.bytesPerElement = 16;

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[4]
 * [8] - Uint16[4]
 * [16] - Int16[4]
 *
 * @internal
 */
class StructArrayLayout4i4ui4i24 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;
  declare uint16: Uint16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number, v10: number, v11: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number, v10: number, v11: number): number {
    const o2 = i * 12;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    this.int16[o2 + 2] = v2;
    this.int16[o2 + 3] = v3;
    this.uint16[o2 + 4] = v4;
    this.uint16[o2 + 5] = v5;
    this.uint16[o2 + 6] = v6;
    this.uint16[o2 + 7] = v7;
    this.int16[o2 + 8] = v8;
    this.int16[o2 + 9] = v9;
    this.int16[o2 + 10] = v10;
    this.int16[o2 + 11] = v11;
    return i;
  }
}

StructArrayLayout4i4ui4i24.prototype.bytesPerElement = 24;

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[6]
 * [12] - Uint32[1]
 * [16] - Uint16[2]
 *
 * @internal
 */
class StructArrayLayout6i1ul2ui20 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;
  declare uint32: Uint32Array;
  declare uint16: Uint16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
    this.uint32 = new Uint32Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5, v6, v7, v8);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number): number {
    const o2 = i * 10;
    const o4 = i * 5;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    this.int16[o2 + 2] = v2;
    this.int16[o2 + 3] = v3;
    this.int16[o2 + 4] = v4;
    this.int16[o2 + 5] = v5;
    this.uint32[o4 + 3] = v6;
    this.uint16[o2 + 8] = v7;
    this.uint16[o2 + 9] = v8;
    return i;
  }
}

StructArrayLayout6i1ul2ui20.prototype.bytesPerElement = 20;

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[2]
 * [4] - Uint16[2]
 * [8] - Uint32[3]
 * [20] - Uint16[3]
 * [28] - Float32[2]
 * [36] - Uint8[3]
 * [40] - Uint32[1]
 * [44] - Int16[1]
 *
 * @internal
 */
class StructArrayLayout2i2ui3ul3ui2f3ub1ul1i48 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;
  declare uint16: Uint16Array;
  declare uint32: Uint32Array;
  declare float32: Float32Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
    this.uint32 = new Uint32Array(this.arrayBuffer);
    this.float32 = new Float32Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number, v10: number, v11: number, v12: number, v13: number, v14: number, v15: number, v16: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number, v10: number, v11: number, v12: number, v13: number, v14: number, v15: number, v16: number): number {
    const o2 = i * 24;
    const o4 = i * 12;
    const o1 = i * 48;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    this.uint16[o2 + 2] = v2;
    this.uint16[o2 + 3] = v3;
    this.uint32[o4 + 2] = v4;
    this.uint32[o4 + 3] = v5;
    this.uint32[o4 + 4] = v6;
    this.uint16[o2 + 10] = v7;
    this.uint16[o2 + 11] = v8;
    this.uint16[o2 + 12] = v9;
    this.float32[o4 + 7] = v10;
    this.float32[o4 + 8] = v11;
    this.uint8[o1 + 36] = v12;
    this.uint8[o1 + 37] = v13;
    this.uint8[o1 + 38] = v14;
    this.uint32[o4 + 10] = v15;
    this.int16[o2 + 22] = v16;
    return i;
  }
}

StructArrayLayout2i2ui3ul3ui2f3ub1ul1i48.prototype.bytesPerElement = 48;

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[8]
 * [16] - Uint16[15]
 * [48] - Uint32[1]
 * [52] - Float32[2]
 * [60] - Uint16[2]
 *
 * @internal
 */
class StructArrayLayout8i15ui1ul2f2ui64 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;
  declare uint16: Uint16Array;
  declare uint32: Uint32Array;
  declare float32: Float32Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
    this.uint32 = new Uint32Array(this.arrayBuffer);
    this.float32 = new Float32Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number, v10: number, v11: number, v12: number, v13: number, v14: number, v15: number, v16: number, v17: number, v18: number, v19: number, v20: number, v21: number, v22: number, v23: number, v24: number, v25: number, v26: number, v27: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, v20, v21, v22, v23, v24, v25, v26, v27);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number, v10: number, v11: number, v12: number, v13: number, v14: number, v15: number, v16: number, v17: number, v18: number, v19: number, v20: number, v21: number, v22: number, v23: number, v24: number, v25: number, v26: number, v27: number): number {
    const o2 = i * 32;
    const o4 = i * 16;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    this.int16[o2 + 2] = v2;
    this.int16[o2 + 3] = v3;
    this.int16[o2 + 4] = v4;
    this.int16[o2 + 5] = v5;
    this.int16[o2 + 6] = v6;
    this.int16[o2 + 7] = v7;
    this.uint16[o2 + 8] = v8;
    this.uint16[o2 + 9] = v9;
    this.uint16[o2 + 10] = v10;
    this.uint16[o2 + 11] = v11;
    this.uint16[o2 + 12] = v12;
    this.uint16[o2 + 13] = v13;
    this.uint16[o2 + 14] = v14;
    this.uint16[o2 + 15] = v15;
    this.uint16[o2 + 16] = v16;
    this.uint16[o2 + 17] = v17;
    this.uint16[o2 + 18] = v18;
    this.uint16[o2 + 19] = v19;
    this.uint16[o2 + 20] = v20;
    this.uint16[o2 + 21] = v21;
    this.uint16[o2 + 22] = v22;
    this.uint32[o4 + 12] = v23;
    this.float32[o4 + 13] = v24;
    this.float32[o4 + 14] = v25;
    this.uint16[o2 + 30] = v26;
    this.uint16[o2 + 31] = v27;
    return i;
  }
}

StructArrayLayout8i15ui1ul2f2ui64.prototype.bytesPerElement = 64;

/**
 * Implementation of the StructArray layout:
 * [0] - Float32[1]
 *
 * @internal
 */
class StructArrayLayout1f4 extends StructArray {
  declare uint8: Uint8Array;
  declare float32: Float32Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.float32 = new Float32Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0);
  }

  public emplace(i: number, v0: number): number {
    const o4 = i * 1;
    this.float32[o4 + 0] = v0;
    return i;
  }
}

StructArrayLayout1f4.prototype.bytesPerElement = 4;

/**
 * Implementation of the StructArray layout:
 * [0] - Int16[3]
 *
 * @internal
 */
class StructArrayLayout3i6 extends StructArray {
  declare uint8: Uint8Array;
  declare int16: Int16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.int16 = new Int16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2);
  }

  public emplace(i: number, v0: number, v1: number, v2: number): number {
    const o2 = i * 3;
    this.int16[o2 + 0] = v0;
    this.int16[o2 + 1] = v1;
    this.int16[o2 + 2] = v2;
    return i;
  }
}

StructArrayLayout3i6.prototype.bytesPerElement = 6;

/**
 * Implementation of the StructArray layout:
 * [0] - Uint16[1]
 * [4] - Float32[2]
 *
 * @internal
 */
class StructArrayLayout1ui2f12 extends StructArray {
  declare uint8: Uint8Array;
  declare uint16: Uint16Array;
  declare float32: Float32Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
    this.float32 = new Float32Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2);
  }

  public emplace(i: number, v0: number, v1: number, v2: number): number {
    const o2 = i * 6;
    const o4 = i * 3;
    this.uint16[o2 + 0] = v0;
    this.float32[o4 + 1] = v1;
    this.float32[o4 + 2] = v2;
    return i;
  }
}

StructArrayLayout1ui2f12.prototype.bytesPerElement = 12;

/**
 * Implementation of the StructArray layout:
 * [0] - Uint32[1]
 * [4] - Uint16[2]
 *
 * @internal
 */
class StructArrayLayout1ul2ui8 extends StructArray {
  declare uint8: Uint8Array;
  declare uint32: Uint32Array;
  declare uint16: Uint16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.uint32 = new Uint32Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2);
  }

  public emplace(i: number, v0: number, v1: number, v2: number): number {
    const o4 = i * 2;
    const o2 = i * 4;
    this.uint32[o4 + 0] = v0;
    this.uint16[o2 + 2] = v1;
    this.uint16[o2 + 3] = v2;
    return i;
  }
}

StructArrayLayout1ul2ui8.prototype.bytesPerElement = 8;

/**
 * Implementation of the StructArray layout:
 * [0] - Uint16[3]
 *
 * @internal
 */
class StructArrayLayout3ui6 extends StructArray {
  declare uint8: Uint8Array;
  declare uint16: Uint16Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.uint16 = new Uint16Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2);
  }

  public emplace(i: number, v0: number, v1: number, v2: number): number {
    const o2 = i * 3;
    this.uint16[o2 + 0] = v0;
    this.uint16[o2 + 1] = v1;
    this.uint16[o2 + 2] = v2;
    return i;
  }
}

StructArrayLayout3ui6.prototype.bytesPerElement = 6;

/**
 * Implementation of the StructArray layout:
 * [0] - Float32[2]
 *
 * @internal
 */
class StructArrayLayout2f8 extends StructArray {
  declare uint8: Uint8Array;
  declare float32: Float32Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.float32 = new Float32Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1);
  }

  public emplace(i: number, v0: number, v1: number): number {
    const o4 = i * 2;
    this.float32[o4 + 0] = v0;
    this.float32[o4 + 1] = v1;
    return i;
  }
}

StructArrayLayout2f8.prototype.bytesPerElement = 8;

/**
 * Implementation of the StructArray layout:
 * [0] - Float32[4]
 *
 * @internal
 */
class StructArrayLayout4f16 extends StructArray {
  declare uint8: Uint8Array;
  declare float32: Float32Array;

  _refreshViews(): void {
    this.uint8 = new Uint8Array(this.arrayBuffer);
    this.float32 = new Float32Array(this.arrayBuffer);
  }

  public emplaceBack(v0: number, v1: number, v2: number, v3: number): number {
    const i = this.length;
    this.resize(i + 1);
    return this.emplace(i, v0, v1, v2, v3);
  }

  public emplace(i: number, v0: number, v1: number, v2: number, v3: number): number {
    const o4 = i * 4;
    this.float32[o4 + 0] = v0;
    this.float32[o4 + 1] = v1;
    this.float32[o4 + 2] = v2;
    this.float32[o4 + 3] = v3;
    return i;
  }
}

StructArrayLayout4f16.prototype.bytesPerElement = 16;

/** @internal */
class CollisionBoxStruct extends Struct {
  declare _structArray: CollisionBoxArray;
  get anchorPointX(): number { return this._structArray.int16[this._pos2 + 0]; }
  get anchorPointY(): number { return this._structArray.int16[this._pos2 + 1]; }
  get x1(): number { return this._structArray.int16[this._pos2 + 2]; }
  get y1(): number { return this._structArray.int16[this._pos2 + 3]; }
  get x2(): number { return this._structArray.int16[this._pos2 + 4]; }
  get y2(): number { return this._structArray.int16[this._pos2 + 5]; }
  get featureIndex(): number { return this._structArray.uint32[this._pos4 + 3]; }
  get sourceLayerIndex(): number { return this._structArray.uint16[this._pos2 + 8]; }
  get bucketIndex(): number { return this._structArray.uint16[this._pos2 + 9]; }
  get anchorPoint(): Point { return new Point(this.anchorPointX, this.anchorPointY); }
}

CollisionBoxStruct.prototype.size = 20;

export type CollisionBox = CollisionBoxStruct;

/** @internal */
export class CollisionBoxArray extends StructArrayLayout6i1ul2ui20 {
  /**
   * Return the CollisionBoxStruct at the given location in the array.
   * @param index - The index of the element.
   */
  get(index: number): CollisionBoxStruct {
    return new CollisionBoxStruct(this, index);
  }
}

/** @internal */
class PlacedSymbolStruct extends Struct {
  declare _structArray: PlacedSymbolArray;
  get anchorX(): number { return this._structArray.int16[this._pos2 + 0]; }
  get anchorY(): number { return this._structArray.int16[this._pos2 + 1]; }
  get glyphStartIndex(): number { return this._structArray.uint16[this._pos2 + 2]; }
  get numGlyphs(): number { return this._structArray.uint16[this._pos2 + 3]; }
  get vertexStartIndex(): number { return this._structArray.uint32[this._pos4 + 2]; }
  get lineStartIndex(): number { return this._structArray.uint32[this._pos4 + 3]; }
  get lineLength(): number { return this._structArray.uint32[this._pos4 + 4]; }
  get segment(): number { return this._structArray.uint16[this._pos2 + 10]; }
  get lowerSize(): number { return this._structArray.uint16[this._pos2 + 11]; }
  get upperSize(): number { return this._structArray.uint16[this._pos2 + 12]; }
  get lineOffsetX(): number { return this._structArray.float32[this._pos4 + 7]; }
  get lineOffsetY(): number { return this._structArray.float32[this._pos4 + 8]; }
  get writingMode(): number { return this._structArray.uint8[this._pos1 + 36]; }
  get placedOrientation(): number { return this._structArray.uint8[this._pos1 + 37]; }
  set placedOrientation(x: number) { this._structArray.uint8[this._pos1 + 37] = x; }
  get hidden(): number { return this._structArray.uint8[this._pos1 + 38]; }
  set hidden(x: number) { this._structArray.uint8[this._pos1 + 38] = x; }
  get crossTileID(): number { return this._structArray.uint32[this._pos4 + 10]; }
  set crossTileID(x: number) { this._structArray.uint32[this._pos4 + 10] = x; }
  get associatedIconIndex(): number { return this._structArray.int16[this._pos2 + 22]; }
}

PlacedSymbolStruct.prototype.size = 48;

export type PlacedSymbol = PlacedSymbolStruct;

/** @internal */
export class PlacedSymbolArray extends StructArrayLayout2i2ui3ul3ui2f3ub1ul1i48 {
  /**
   * Return the PlacedSymbolStruct at the given location in the array.
   * @param index - The index of the element.
   */
  get(index: number): PlacedSymbolStruct {
    return new PlacedSymbolStruct(this, index);
  }
}

/** @internal */
class SymbolInstanceStruct extends Struct {
  declare _structArray: SymbolInstanceArray;
  get anchorX(): number { return this._structArray.int16[this._pos2 + 0]; }
  get anchorY(): number { return this._structArray.int16[this._pos2 + 1]; }
  get rightJustifiedTextSymbolIndex(): number { return this._structArray.int16[this._pos2 + 2]; }
  get centerJustifiedTextSymbolIndex(): number { return this._structArray.int16[this._pos2 + 3]; }
  get leftJustifiedTextSymbolIndex(): number { return this._structArray.int16[this._pos2 + 4]; }
  get verticalPlacedTextSymbolIndex(): number { return this._structArray.int16[this._pos2 + 5]; }
  get placedIconSymbolIndex(): number { return this._structArray.int16[this._pos2 + 6]; }
  get verticalPlacedIconSymbolIndex(): number { return this._structArray.int16[this._pos2 + 7]; }
  get key(): number { return this._structArray.uint16[this._pos2 + 8]; }
  get textBoxStartIndex(): number { return this._structArray.uint16[this._pos2 + 9]; }
  get textBoxEndIndex(): number { return this._structArray.uint16[this._pos2 + 10]; }
  get verticalTextBoxStartIndex(): number { return this._structArray.uint16[this._pos2 + 11]; }
  get verticalTextBoxEndIndex(): number { return this._structArray.uint16[this._pos2 + 12]; }
  get iconBoxStartIndex(): number { return this._structArray.uint16[this._pos2 + 13]; }
  get iconBoxEndIndex(): number { return this._structArray.uint16[this._pos2 + 14]; }
  get verticalIconBoxStartIndex(): number { return this._structArray.uint16[this._pos2 + 15]; }
  get verticalIconBoxEndIndex(): number { return this._structArray.uint16[this._pos2 + 16]; }
  get featureIndex(): number { return this._structArray.uint16[this._pos2 + 17]; }
  get numHorizontalGlyphVertices(): number { return this._structArray.uint16[this._pos2 + 18]; }
  get numVerticalGlyphVertices(): number { return this._structArray.uint16[this._pos2 + 19]; }
  get numIconVertices(): number { return this._structArray.uint16[this._pos2 + 20]; }
  get numVerticalIconVertices(): number { return this._structArray.uint16[this._pos2 + 21]; }
  get useRuntimeCollisionCircles(): number { return this._structArray.uint16[this._pos2 + 22]; }
  get crossTileID(): number { return this._structArray.uint32[this._pos4 + 12]; }
  set crossTileID(x: number) { this._structArray.uint32[this._pos4 + 12] = x; }
  get textBoxScale(): number { return this._structArray.float32[this._pos4 + 13]; }
  get collisionCircleDiameter(): number { return this._structArray.float32[this._pos4 + 14]; }
  get textAnchorOffsetStartIndex(): number { return this._structArray.uint16[this._pos2 + 30]; }
  get textAnchorOffsetEndIndex(): number { return this._structArray.uint16[this._pos2 + 31]; }
}

SymbolInstanceStruct.prototype.size = 64;

export type SymbolInstance = SymbolInstanceStruct;

/** @internal */
export class SymbolInstanceArray extends StructArrayLayout8i15ui1ul2f2ui64 {
  /**
   * Return the SymbolInstanceStruct at the given location in the array.
   * @param index - The index of the element.
   */
  get(index: number): SymbolInstanceStruct {
    return new SymbolInstanceStruct(this, index);
  }
}

/** @internal */
export class GlyphOffsetArray extends StructArrayLayout1f4 {
  getoffsetX(index: number): number { return this.float32[index * 1 + 0]; }
}

/** @internal */
export class SymbolLineVertexArray extends StructArrayLayout3i6 {
  getx(index: number): number { return this.int16[index * 3 + 0]; }
  gety(index: number): number { return this.int16[index * 3 + 1]; }
  gettileUnitDistanceFromAnchor(index: number): number { return this.int16[index * 3 + 2]; }
}

/** @internal */
class TextAnchorOffsetStruct extends Struct {
  declare _structArray: TextAnchorOffsetArray;
  get textAnchor(): number { return this._structArray.uint16[this._pos2 + 0]; }
  get textOffset0(): number { return this._structArray.float32[this._pos4 + 1]; }
  get textOffset1(): number { return this._structArray.float32[this._pos4 + 2]; }
}

TextAnchorOffsetStruct.prototype.size = 12;

export type TextAnchorOffset = TextAnchorOffsetStruct;

/** @internal */
export class TextAnchorOffsetArray extends StructArrayLayout1ui2f12 {
  /**
   * Return the TextAnchorOffsetStruct at the given location in the array.
   * @param index - The index of the element.
   */
  get(index: number): TextAnchorOffsetStruct {
    return new TextAnchorOffsetStruct(this, index);
  }
}

/** @internal */
class FeatureIndexStruct extends Struct {
  declare _structArray: FeatureIndexArray;
  get featureIndex(): number { return this._structArray.uint32[this._pos4 + 0]; }
  get sourceLayerIndex(): number { return this._structArray.uint16[this._pos2 + 2]; }
  get bucketIndex(): number { return this._structArray.uint16[this._pos2 + 3]; }
}

FeatureIndexStruct.prototype.size = 8;

export type FeatureIndex = FeatureIndexStruct;

/** @internal */
export class FeatureIndexArray extends StructArrayLayout1ul2ui8 {
  /**
   * Return the FeatureIndexStruct at the given location in the array.
   * @param index - The index of the element.
   */
  get(index: number): FeatureIndexStruct {
    return new FeatureIndexStruct(this, index);
  }
}

export class PosArray extends StructArrayLayout2i4 {}
export class CircleLayoutArray extends StructArrayLayout2i4 {}
export class FillLayoutArray extends StructArrayLayout2i4 {}
export class FillExtrusionLayoutArray extends StructArrayLayout2i4i12 {}
export class PatternLayoutArray extends StructArrayLayout10ui20 {}
export class DashLayoutArray extends StructArrayLayout8ui16 {}
export class SymbolLayoutArray extends StructArrayLayout4i4ui4i24 {}
export class TriangleIndexArray extends StructArrayLayout3ui6 {}
export function registerArrayTransfers(registry: TransferRegistry): void {
  registry.register('StructArrayLayout2i4', StructArrayLayout2i4);
  registry.register('StructArrayLayout2i4i12', StructArrayLayout2i4i12);
  registry.register('StructArrayLayout10ui20', StructArrayLayout10ui20);
  registry.register('StructArrayLayout8ui16', StructArrayLayout8ui16);
  registry.register('StructArrayLayout4i4ui4i24', StructArrayLayout4i4ui4i24);
  registry.register('StructArrayLayout6i1ul2ui20', StructArrayLayout6i1ul2ui20);
  registry.register('StructArrayLayout2i2ui3ul3ui2f3ub1ul1i48', StructArrayLayout2i2ui3ul3ui2f3ub1ul1i48);
  registry.register('StructArrayLayout8i15ui1ul2f2ui64', StructArrayLayout8i15ui1ul2f2ui64);
  registry.register('StructArrayLayout1f4', StructArrayLayout1f4);
  registry.register('StructArrayLayout3i6', StructArrayLayout3i6);
  registry.register('StructArrayLayout1ui2f12', StructArrayLayout1ui2f12);
  registry.register('StructArrayLayout1ul2ui8', StructArrayLayout1ul2ui8);
  registry.register('StructArrayLayout3ui6', StructArrayLayout3ui6);
  registry.register('StructArrayLayout2f8', StructArrayLayout2f8);
  registry.register('StructArrayLayout4f16', StructArrayLayout4f16);
  registry.register('CollisionBoxArray', CollisionBoxArray);
  registry.register('PlacedSymbolArray', PlacedSymbolArray);
  registry.register('SymbolInstanceArray', SymbolInstanceArray);
  registry.register('GlyphOffsetArray', GlyphOffsetArray);
  registry.register('SymbolLineVertexArray', SymbolLineVertexArray);
  registry.register('TextAnchorOffsetArray', TextAnchorOffsetArray);
  registry.register('FeatureIndexArray', FeatureIndexArray);
}
export {
  StructArrayLayout1f4,
  StructArrayLayout1ui2f12,
  StructArrayLayout1ul2ui8,
  StructArrayLayout2f8,
  StructArrayLayout2i2ui3ul3ui2f3ub1ul1i48,
  StructArrayLayout2i4,
  StructArrayLayout2i4i12,
  StructArrayLayout3i6,
  StructArrayLayout3ui6,
  StructArrayLayout4f16,
  StructArrayLayout4i4ui4i24,
  StructArrayLayout6i1ul2ui20,
  StructArrayLayout8i15ui1ul2f2ui64,
  StructArrayLayout8ui16,
  StructArrayLayout10ui20,
};
