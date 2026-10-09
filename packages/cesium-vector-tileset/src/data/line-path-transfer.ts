export interface LinePath {
  featureIndex: number;
  points: Int16Array;
}

export interface PackedLinePaths {
  coordinates: Int16Array;
  offsets: Uint32Array;
  featureIndices: Uint32Array;
}

/** Pack raw tile coordinates without transferring the worker's path buffers. */
export function serializeLinePaths(paths: readonly LinePath[]): PackedLinePaths {
  let coordinateCount = 0;
  for (const path of paths) {
    coordinateCount += path.points.length;
  }

  const coordinates = new Int16Array(coordinateCount);
  const offsets = new Uint32Array(paths.length + 1);
  const featureIndices = new Uint32Array(paths.length);
  let offset = 0;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    coordinates.set(path.points, offset);
    offset += path.points.length;
    offsets[index + 1] = offset;
    featureIndices[index] = path.featureIndex;
  }
  return { coordinates, offsets, featureIndices };
}

/** Restore the existing path interface with views of one coordinate owner. */
export function restoreLinePaths(packed: PackedLinePaths): LinePath[] {
  return Array.from(packed.featureIndices, (featureIndex, index) => ({
    featureIndex,
    points: packed.coordinates.subarray(packed.offsets[index], packed.offsets[index + 1]),
  }));
}
