import type { NativeCommand, NativeContext } from './browser-types';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';

export interface SymbolVertexFeedback {
  clip: number[][];
  indices: number[];
  viewport: number[];
}

/** Observe the bound Native symbol vertex shader, without reproducing its math. */
export function captureSymbolVertices(context: NativeContext, layerId: string) {
  const gl = context._gl;
  const originalDraw = context.draw;
  const originalElements = gl.drawElements;
  const originalArrays = gl.drawArrays;
  let command: NativeCommand | undefined;
  let result: SymbolVertexFeedback | undefined;
  let error: string | undefined;
  let removed = false;
  const uninstall = () => {
    if (removed)
      return;
    removed = true;
    context.draw = originalDraw;
    gl.drawElements = originalElements;
  };
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Symbol feedback compilation: ${message}`);
    }
    return shader;
  };
  function capture(count: number, type: number, offset: number): SymbolVertexFeedback {
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const feedbackBinding = gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING) as WebGLTransformFeedback | null;
    const bufferBinding = gl.getParameter(gl.TRANSFORM_FEEDBACK_BUFFER_BINDING) as WebGLBuffer | null;
    const discard = gl.isEnabled(gl.RASTERIZER_DISCARD);
    if (gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE))
      throw new Error('Symbol feedback cannot nest transform feedback');
    const shaders = gl.getAttachedShaders(program)!;
    const source = gl.getShaderSource(shaders.find(shader => gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.VERTEX_SHADER)!)!;
    const fragmentSource = gl.getShaderSource(shaders.find(shader => gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER)!)!;
    const observed = gl.createProgram()!;
    const buffer = gl.createBuffer()!;
    const feedback = gl.createTransformFeedback()!;
    let active = false;
    try {
      const main = /void\s+main\s*\(\s*(?:void\s*)?\)/g;
      if ([...source.matchAll(main)].length !== 1)
        throw new Error('Actual symbol vertex shader must have one main');
      const vertex = compile(gl.VERTEX_SHADER, `${source.replace(main, 'void observed_main()')}\nout highp vec4 observed_clip;\nvoid main() { observed_main(); observed_clip = gl_Position; }`);
      gl.attachShader(observed, vertex);
      gl.deleteShader(vertex);
      const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      gl.attachShader(observed, fragment);
      gl.deleteShader(fragment);
      for (let index = 0; index < gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES); index++) {
        const attribute = gl.getActiveAttrib(program, index)!;
        gl.bindAttribLocation(observed, gl.getAttribLocation(program, attribute.name), attribute.name);
      }
      gl.transformFeedbackVaryings(observed, ['observed_clip'], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(observed);
      if (!gl.getProgramParameter(observed, gl.LINK_STATUS))
        throw new Error(`Symbol feedback link: ${gl.getProgramInfoLog(observed)}`);
      gl.useProgram(observed);
      for (let index = 0; index < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); index++) {
        const uniform = gl.getActiveUniform(program, index)!;
        if (uniform.size !== 1)
          throw new Error(`Unexpected symbol uniform array ${uniform.name}`);
        const target = gl.getUniformLocation(observed, uniform.name);
        if (!target)
          continue;
        const value = gl.getUniform(program, gl.getUniformLocation(program, uniform.name)!);
        switch (uniform.type) {
          case gl.FLOAT: gl.uniform1f(target, value as number);
            break;
          case gl.FLOAT_VEC2: gl.uniform2fv(target, value as Float32Array);
            break;
          case gl.FLOAT_VEC3: gl.uniform3fv(target, value as Float32Array);
            break;
          case gl.FLOAT_VEC4: gl.uniform4fv(target, value as Float32Array);
            break;
          case gl.BOOL: case gl.SAMPLER_2D: gl.uniform1i(target, Number(value));
            break;
          case gl.FLOAT_MAT3: gl.uniformMatrix3fv(target, false, value as Float32Array);
            break;
          case gl.FLOAT_MAT4: gl.uniformMatrix4fv(target, false, value as Float32Array);
            break;
          default: throw new Error(`Unexpected symbol uniform ${uniform.name}: ${uniform.type}`);
        }
      }
      if (type !== gl.UNSIGNED_SHORT && type !== gl.UNSIGNED_INT)
        throw new Error(`Unexpected symbol index type ${type}`);
      const indices = type === gl.UNSIGNED_SHORT ? new Uint16Array(count) : new Uint32Array(count);
      gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, indices);
      const vertexCount = command!.vertexArray.numberOfVertices;
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
      gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, vertexCount * 16, gl.STREAM_READ);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      active = true;
      originalArrays.call(gl, gl.POINTS, 0, vertexCount);
      gl.endTransformFeedback();
      active = false;
      const positions = new Float32Array(vertexCount * 4);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, positions);
      const captureError = gl.getError();
      if (captureError !== gl.NO_ERROR)
        throw new Error(`Symbol feedback GL error ${captureError}`);
      return {
        clip: Array.from({ length: vertexCount }, (_, index) => Array.from(positions.subarray(index * 4, index * 4 + 4))),
        indices: Array.from(indices),
        viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
      };
    }
    finally {
      if (active)
        gl.endTransformFeedback();
      if (!discard)
        gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedbackBinding);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, bufferBinding);
      gl.useProgram(program);
      gl.deleteTransformFeedback(feedback);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(observed);
    }
  }
  context.draw = function (current, ...args) {
    const previous = command;
    command = current;
    try {
      return originalDraw.call(this, current, ...args);
    }
    finally {
      command = previous;
    }
  };
  gl.drawElements = function (mode, count, type, offset) {
    if (command && drawBatchForOwner(command.owner)?.layerId === layerId) {
      try {
        result = capture(count, type, offset);
      }
      catch (caught) {
        error = String(caught);
      }
      finally {
        uninstall();
      }
    }
    return originalElements.call(this, mode, count, type, offset);
  };
  return {
    get result() {
      return result;
    },
    get error() {
      return error;
    },
    uninstall,
  };
}
