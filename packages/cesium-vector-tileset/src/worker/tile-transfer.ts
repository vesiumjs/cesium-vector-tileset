import { Color, CompoundExpression, EvaluationContext, expressions, ResolvedImage, StyleExpression, StylePropertyFunction, ZoomConstantExpression, ZoomDependentExpression } from '@maplibre/maplibre-gl-style-spec';
import { registerGlyphAtlasTransfers } from '../assets/glyph-atlas';
import { registerImageAtlasTransfers } from '../assets/image-atlas';
import { registerArrayTransfers } from '../data/array-types.g';
import { registerBucketTransfers } from '../data/bucket-runtime';
import { registerFeatureIndexTransfers } from '../data/feature-index';
import { registerFeatureSnapshotTransfers } from '../data/feature-snapshot';
import { registerProgramConfigurationTransfers } from '../data/program-configuration';
import { registerSegmentTransfers } from '../data/segment';
import { registerFormatSectionOverrideTransfers } from '../style/format-section-override';
import { registerPropertiesTransfers } from '../style/properties';
import { registerAnchorTransfers } from '../symbol/anchor';
import { registerTileIdTransfers } from '../tile/tile-id';
import { AJAXError } from '../util/ajax';
import { registerImageTransfers } from '../util/image';
import { TransferRegistry } from './transfer-registry';

/** The single bootstrap shared by scene and worker channels. */
export function createTileTransferRegistry(): TransferRegistry {
  const registry = new TransferRegistry();
  registry.register('Object', Object);
  registry.register('Color', Color);
  registry.register('Error', Error);
  registry.register('AJAXError', AJAXError);
  registry.register('ResolvedImage', ResolvedImage);
  registry.register('StylePropertyFunction', StylePropertyFunction);
  registry.register('StyleExpression', StyleExpression, {
    omit: ['_evaluator'],
    restore: (expression) => { expression._evaluator = new EvaluationContext(); },
  });
  registry.register('ZoomDependentExpression', ZoomDependentExpression);
  registry.register('ZoomConstantExpression', ZoomConstantExpression);
  registry.register('CompoundExpression', CompoundExpression, {
    omit: ['_evaluate'],
    serialize(expression) {
      const definition = CompoundExpression.definitions[expression.name];
      const overload = Array.isArray(definition)
        ? 0
        : definition.overloads.findIndex(([, evaluate]) => evaluate === expression._evaluate);
      return { ...expression, overload };
    },
    restore(expression) {
      const input = expression as CompoundExpression & { overload?: number };
      const definition = CompoundExpression.definitions[expression.name];
      expression._evaluate = Array.isArray(definition)
        ? definition[2]
        : definition.overloads[input.overload][1];
      delete input.overload;
    },
  });
  for (const [name, expression] of Object.entries(expressions)) {
    if (!registry.hasConstructor(expression)) {
      registry.register(`Expression_${name}`, expression);
    }
  }
  registerArrayTransfers(registry);
  registerBucketTransfers(registry);
  registerFeatureIndexTransfers(registry);
  registerFeatureSnapshotTransfers(registry);
  registerProgramConfigurationTransfers(registry);
  registerSegmentTransfers(registry);
  registerGlyphAtlasTransfers(registry);
  registerImageAtlasTransfers(registry);
  registerFormatSectionOverrideTransfers(registry);
  registerPropertiesTransfers(registry);
  registerAnchorTransfers(registry);
  registerTileIdTransfers(registry);
  registerImageTransfers(registry);
  return registry;
}
