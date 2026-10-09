import type { Geometry } from 'cesium';
import { ComponentDatatype, GeometryAttribute } from 'cesium';

const HIGH_SCALE = 65536;

/** Native combine has already projected and encoded every position in the Worker. */
export function packExtrusionAttributes(geometry: Geometry): void {
  const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
  for (const mode of ['3D', '2D']) {
    const highName = `position${mode}High`;
    const lowName = `position${mode}Low`;
    if (mode === '2D' && !attributes[highName] && !attributes[lowName])
      continue;
    const low = attributes[lowName];
    if (!low || low.componentDatatype !== ComponentDatatype.FLOAT || low.componentsPerAttribute !== 3)
      throw new TypeError(`Extrusion ${lowName} requires Native FLOAT3 encoding`);
    attributes[`a_extrusionHigh${mode}`] = packShort(attributes[highName], HIGH_SCALE, highName);
    // Keep the FLOAT Low allocation and its exact bit patterns.
    attributes[`a_extrusionLow${mode}`] = low;
    delete attributes[highName];
    delete attributes[lowName];
  }
  attributes.a_extrusionNormal = packShort(attributes.a_extrusionNormal, 1, 'a_extrusionNormal');
}

function packShort(attribute: GeometryAttribute, scale: number, name: string): GeometryAttribute {
  if (!attribute || attribute.componentDatatype !== ComponentDatatype.FLOAT || attribute.componentsPerAttribute !== 3 || attribute.normalize)
    throw new TypeError(`Extrusion ${name} requires unnormalized FLOAT3 encoding`);
  const values = new Int16Array(attribute.values.length);
  for (let index = 0; index < values.length; index++) {
    const value = attribute.values[index] / scale;
    if (!Number.isInteger(value) || value < -32768 || value > 32767)
      throw new RangeError(`Extrusion ${name} is not exactly representable as SHORT`);
    values[index] = value;
  }
  return new GeometryAttribute({ componentDatatype: ComponentDatatype.SHORT, componentsPerAttribute: 3, values });
}
