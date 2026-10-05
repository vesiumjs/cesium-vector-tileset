import type { CircleStyleLayer } from './circle-style-layer';
import type { FillExtrusionStyleLayer } from './fill-extrusion-style-layer';
import type { FillStyleLayer } from './fill-style-layer';
import type { LineStyleLayer } from './line-style-layer';
import type { SymbolStyleLayer } from './symbol-style-layer';

export type TypedStyleLayer = CircleStyleLayer | FillStyleLayer | FillExtrusionStyleLayer | LineStyleLayer | SymbolStyleLayer;
