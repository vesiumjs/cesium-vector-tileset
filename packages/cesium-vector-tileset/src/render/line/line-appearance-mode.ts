import type { Appearance } from 'cesium';
import { SceneMode } from 'cesium';

const appearances = new WeakMap<Appearance, Map<string, Appearance>>();

/** Variants retain the owner's texture uniforms and Material without mutation. */
export function lineAppearanceForMode(source: Appearance, mode: SceneMode): Appearance {
  if (mode === SceneMode.MORPHING)
    return source;
  const literal = mode === SceneMode.SCENE3D ? '1.0' : '0.0';
  let variants = appearances.get(source);
  if (!variants) {
    variants = new Map();
    appearances.set(source, variants);
  }
  let appearance = variants.get(literal);
  if (!appearance) {
    appearance = Object.create(Object.getPrototypeOf(source), {
      ...Object.getOwnPropertyDescriptors(source),
      vertexShaderSource: { value: source.vertexShaderSource.replaceAll('czm_morphTime', literal), configurable: true },
      fragmentShaderSource: { value: source.fragmentShaderSource.replaceAll('czm_morphTime', literal), configurable: true },
    }) as Appearance;
    variants.set(literal, appearance);
  }
  return appearance;
}
