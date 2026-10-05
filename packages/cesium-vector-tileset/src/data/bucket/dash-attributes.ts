import type { StructArrayLayout } from '../../util/struct-array';
import { createLayout } from '../../util/struct-array';

export const dashAttributes: StructArrayLayout = createLayout([
  // [0, y, height, width]
  { name: 'a_dasharray_from', components: 4, type: 'Uint16' },
  { name: 'a_dasharray_to', components: 4, type: 'Uint16' },
]);
