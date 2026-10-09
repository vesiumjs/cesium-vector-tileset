import type { BoundingSphere } from 'cesium';
import * as Cesium from 'cesium';

/** Cesium DrawCommand fields retained by Native shallowClone. */
export interface ReplayDrawCommand {
  boundingVolume?: BoundingSphere;
  orientedBoundingBox?: object;
  modelMatrix?: object;
  primitiveType?: number;
  vertexArray?: unknown;
  count?: number;
  offset?: number;
  instanceCount?: number;
  shaderProgram?: object;
  uniformMap?: Record<string, () => unknown>;
  renderState?: object;
  framebuffer?: object;
  pass?: number;
  owner?: object;
  debugOverlappingFrustums?: number;
  pickId?: string;
  snapId?: string;
  pickedMetadataInfo?: object;
  cull?: boolean;
  occlude?: boolean;
  executeInClosestFrustum?: boolean;
  debugShowBoundingVolume?: boolean;
  castShadows?: boolean;
  receiveShadows?: boolean;
  pickOnly?: boolean;
  depthForTranslucentClassification?: boolean;
  _pickMetadataAllowed?: boolean;
  dirty?: boolean;
}

const DrawCommand = (Cesium as unknown as {
  DrawCommand: { shallowClone: (source: ReplayDrawCommand) => ReplayDrawCommand };
}).DrawCommand;

/** A submitted command owns its final paint state; Native owns the source. */
export class DrawCommandReplay {
  readonly command: ReplayDrawCommand;

  private readonly _source: ReplayDrawCommand = {};

  constructor(source: ReplayDrawCommand) {
    this.command = DrawCommand.shallowClone(source);
  }

  update(source: ReplayDrawCommand, bounds: BoundingSphere): ReplayDrawCommand {
    // Compare Native's inputs, not the submitted command: final preparation
    // can replace its pass, depth state and uniforms without changing Native.
    // Static accesses keep Native's getters monomorphic on this per-command path.
    if (this._source.orientedBoundingBox !== source.orientedBoundingBox) {
      this._source.orientedBoundingBox = source.orientedBoundingBox;
      this.command.orientedBoundingBox = source.orientedBoundingBox;
    }
    if (this._source.modelMatrix !== source.modelMatrix) {
      this._source.modelMatrix = source.modelMatrix;
      this.command.modelMatrix = source.modelMatrix;
    }
    if (this._source.primitiveType !== source.primitiveType) {
      this._source.primitiveType = source.primitiveType;
      this.command.primitiveType = source.primitiveType;
    }
    if (this._source.vertexArray !== source.vertexArray) {
      this._source.vertexArray = source.vertexArray;
      this.command.vertexArray = source.vertexArray;
    }
    if (this._source.count !== source.count) {
      this._source.count = source.count;
      this.command.count = source.count;
    }
    if (this._source.offset !== source.offset) {
      this._source.offset = source.offset;
      this.command.offset = source.offset;
    }
    if (this._source.instanceCount !== source.instanceCount) {
      this._source.instanceCount = source.instanceCount;
      this.command.instanceCount = source.instanceCount;
    }
    if (this._source.shaderProgram !== source.shaderProgram) {
      this._source.shaderProgram = source.shaderProgram;
      this.command.shaderProgram = source.shaderProgram;
    }
    if (this._source.uniformMap !== source.uniformMap) {
      this._source.uniformMap = source.uniformMap;
      this.command.uniformMap = source.uniformMap;
    }
    if (this._source.renderState !== source.renderState) {
      this._source.renderState = source.renderState;
      this.command.renderState = source.renderState;
    }
    if (this._source.framebuffer !== source.framebuffer) {
      this._source.framebuffer = source.framebuffer;
      this.command.framebuffer = source.framebuffer;
    }
    if (this._source.pass !== source.pass) {
      this._source.pass = source.pass;
      this.command.pass = source.pass;
    }
    if (this._source.owner !== source.owner) {
      this._source.owner = source.owner;
      this.command.owner = source.owner;
    }
    if (this._source.debugOverlappingFrustums !== source.debugOverlappingFrustums) {
      this._source.debugOverlappingFrustums = source.debugOverlappingFrustums;
      this.command.debugOverlappingFrustums = source.debugOverlappingFrustums;
    }
    if (this._source.pickId !== source.pickId) {
      this._source.pickId = source.pickId;
      this.command.pickId = source.pickId;
    }
    if (this._source.snapId !== source.snapId) {
      this._source.snapId = source.snapId;
      this.command.snapId = source.snapId;
    }
    if (this._source.pickedMetadataInfo !== source.pickedMetadataInfo) {
      this._source.pickedMetadataInfo = source.pickedMetadataInfo;
      this.command.pickedMetadataInfo = source.pickedMetadataInfo;
    }
    if (this._source.cull !== source.cull) {
      this._source.cull = source.cull;
      this.command.cull = source.cull;
    }
    if (this._source.occlude !== source.occlude) {
      this._source.occlude = source.occlude;
      this.command.occlude = source.occlude;
    }
    if (this._source.executeInClosestFrustum !== source.executeInClosestFrustum) {
      this._source.executeInClosestFrustum = source.executeInClosestFrustum;
      this.command.executeInClosestFrustum = source.executeInClosestFrustum;
    }
    if (this._source.debugShowBoundingVolume !== source.debugShowBoundingVolume) {
      this._source.debugShowBoundingVolume = source.debugShowBoundingVolume;
      this.command.debugShowBoundingVolume = source.debugShowBoundingVolume;
    }
    if (this._source.castShadows !== source.castShadows) {
      this._source.castShadows = source.castShadows;
      this.command.castShadows = source.castShadows;
    }
    if (this._source.receiveShadows !== source.receiveShadows) {
      this._source.receiveShadows = source.receiveShadows;
      this.command.receiveShadows = source.receiveShadows;
    }
    if (this._source.pickOnly !== source.pickOnly) {
      this._source.pickOnly = source.pickOnly;
      this.command.pickOnly = source.pickOnly;
    }
    if (this._source.depthForTranslucentClassification !== source.depthForTranslucentClassification) {
      this._source.depthForTranslucentClassification = source.depthForTranslucentClassification;
      this.command.depthForTranslucentClassification = source.depthForTranslucentClassification;
    }
    if (this._source._pickMetadataAllowed !== source._pickMetadataAllowed) {
      this._source._pickMetadataAllowed = source._pickMetadataAllowed;
      this.command._pickMetadataAllowed = source._pickMetadataAllowed;
      this.command.dirty = true;
    }
    // The raw sphere never passes through the retained command after creation.
    // Stable expanded spheres remain live when their values change in place.
    this.command.boundingVolume = bounds;
    return this.command;
  }
}
