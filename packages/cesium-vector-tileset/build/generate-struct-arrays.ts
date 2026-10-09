/*
 * Generates the following:
 *  - data/array-types.js, which consists of:
 *    - StructArrayLayout_* subclasses, one for each underlying memory layout we need
 *    - Named exports mapping each conceptual array type (e.g., CircleLayoutArray) to its corresponding StructArrayLayout class
 *    - Particular, named StructArray subclasses, when fancy struct accessors are needed (e.g. CollisionBoxArray)
 */

'use strict';

import type { StructArrayLayout } from '../src/util/struct-array';
import * as fs from 'node:fs';
import { dashAttributes } from '../src/data/bucket/dash-attributes';
import { patternAttributes } from '../src/data/bucket/pattern-attributes';
// symbol layer specific arrays
import {
  collisionBox,
  glyphOffset,
  lineVertex,
  placement,
  symbolInstance,
  symbolLayoutAttributes,
  textAnchorOffset,
} from '../src/data/bucket/symbol-attributes';
import { createLayout, viewTypes } from '../src/util/struct-array';

const circleAttributes = createLayout([
  { name: 'a_pos', components: 2, type: 'Int16' },
], 4);
const fillAttributes = circleAttributes;
const fillExtrusionAttributes = createLayout([
  { name: 'a_pos', components: 2, type: 'Int16' },
  { name: 'a_normal_ed', components: 4, type: 'Int16' },
], 4);
const posAttributes = createLayout([
  { name: 'a_pos', type: 'Int16', components: 2 },
]);

const typeAbbreviations = {
  Int8: 'b',
  Uint8: 'ub',
  Int16: 'i',
  Uint16: 'ui',
  Int32: 'l',
  Uint32: 'ul',
  Float32: 'f',
};

const arraysWithStructAccessors = [];
const arrayTypeEntries = new Set();
const layoutCache = {};

function normalizeMembers(members, usedTypes) {
  return members.map((member) => {
    if (usedTypes && !usedTypes.has(member.type)) {
      usedTypes.add(member.type);
    }

    return Object.assign(member, {
      size: viewTypes[member.type].BYTES_PER_ELEMENT,
      view: member.type.toLowerCase(),
    });
  });
}

// - If necessary, write the StructArrayLayout_* class for the given layout
// - If `includeStructAccessors`, write the fancy subclass
// - Add an entry for `name` in the array type registry
function createStructArrayType(name: string, layout: StructArrayLayout, includeStructAccessors: boolean = false) {
  const hasAnchorPoint = layout.members.some(m => m.name === 'anchorPointX');

  // create the underlying StructArrayLayout class exists
  const layoutClass = createStructArrayLayoutType(layout);
  const arrayClass = `${camelize(name)}Array`;

  if (includeStructAccessors) {
    const usedTypes = new Set(['Uint8']);
    const members = normalizeMembers(layout.members, usedTypes);
    arraysWithStructAccessors.push({
      arrayClass,
      members,
      size: layout.size,
      usedTypes,
      hasAnchorPoint,
      layoutClass,
      includeStructAccessors,
    });
  }
  else {
    arrayTypeEntries.add(`export class ${arrayClass} extends ${layoutClass} {}`);
  }
}

function createStructArrayLayoutType({ members, size, alignment }) {
  const usedTypes = new Set(['Uint8']);
  members = normalizeMembers(members, usedTypes);

  // combine consecutive 'members' with same underlying type, summing their
  // component counts
  if (!alignment || alignment === 1) {
    members = members.reduce((memo, member) => {
      if (memo.length > 0 && memo[memo.length - 1].type === member.type) {
        const last = memo[memo.length - 1];
        return memo.slice(0, -1).concat(Object.assign({}, last, {
          components: last.components + member.components,
        }));
      }
      return memo.concat(member);
    }, []);
  }

  const key = `${members.map(m => `${m.components}${typeAbbreviations[m.type]}`).join('')}${size}`;
  const className = `StructArrayLayout${key}`;

  layoutCache[key] ||= {
    className,
    members,
    size,
    usedTypes,
  };

  return className;
}

function camelize(str) {
  return str.replace(/(?:^|[-_])(.)/g, (_, x) => {
    return /^\d$/.test(x) ? _ : x.toUpperCase();
  });
}

createStructArrayType('pos', posAttributes);

// layout vertex arrays
const layoutAttributes = {
  'circle': circleAttributes,
  'fill': fillAttributes,
  'fill-extrusion': fillExtrusionAttributes,
  'pattern': patternAttributes,
  'dash': dashAttributes,
};
for (const name in layoutAttributes) {
  createStructArrayType(`${name.replace(/-/g, '_')}_layout`, layoutAttributes[name]);
}

createStructArrayType('symbol_layout', symbolLayoutAttributes);
createStructArrayType('collision_box', collisionBox, true);
createStructArrayType('placed_symbol', placement, true);
createStructArrayType('symbol_instance', symbolInstance, true);
createStructArrayType('glyph_offset', glyphOffset, true);
createStructArrayType('symbol_line_vertex', lineVertex, true);
createStructArrayType('text_anchor_offset', textAnchorOffset, true);

// feature index array
createStructArrayType('feature_index', createLayout([
  // the index of the feature in the original vectortile
  { type: 'Uint32', name: 'featureIndex' },
  // the source layer the feature appears in
  { type: 'Uint16', name: 'sourceLayerIndex' },
  // the bucket the feature appears in
  { type: 'Uint16', name: 'bucketIndex' },
]), true);

// triangle index array
createStructArrayType('triangle_index', createLayout([
  { type: 'Uint16', name: 'vertices', components: 3 },
]));

// paint vertex arrays

// used by SourceBinder for float properties
createStructArrayLayoutType(createLayout([{
  name: 'dummy name (unused for StructArrayLayout)',
  type: 'Float32',
  components: 1,
}], 4));

// used by SourceBinder for color properties and CompositeBinder for float properties
createStructArrayLayoutType(createLayout([{
  name: 'dummy name (unused for StructArrayLayout)',
  type: 'Float32',
  components: 2,
}], 4));

// used by CompositeBinder for color properties
createStructArrayLayoutType(createLayout([{
  name: 'dummy name (unused for StructArrayLayout)',
  type: 'Float32',
  components: 4,
}], 4));

const layouts = Object.keys(layoutCache).map(k => layoutCache[k]);

function emitStructArrayLayout(locals) {
  const output = [];
  const {
    className,
    members,
    size,
    usedTypes,
  } = locals;
  const structArrayLayoutClass = className;

  output.push(
    `/**
 * Implementation of the StructArray layout:`,
  );

  for (const member of members) {
    output.push(
      ` * [${member.offset}] - ${member.type}[${member.components}]`,
    );
  }

  output.push(
    ` *
 * @internal
 */
class ${structArrayLayoutClass} extends StructArray {`,
  );

  for (const type of usedTypes) {
    output.push(
      `    declare ${type.toLowerCase()}: ${type}Array;`,
    );
  }

  output.push(`
    refreshViews(): void {`);

  for (const type of usedTypes) {
    output.push(
      `        this.${type.toLowerCase()} = new ${type}Array(this.arrayBuffer);`,
    );
  }

  output.push(
    '    }',
  );

  // prep for emplaceBack: collect type sizes and count the number of arguments
  // we'll need
  const bytesPerElement = size;
  const usedTypeSizes = [];
  const argNames = [];
  const argNamesTyped = [];

  for (const member of members) {
    if (!usedTypeSizes.includes(member.size)) {
      usedTypeSizes.push(member.size);
    }
    for (let c = 0; c < member.components; c++) {
      // arguments v0, v1, v2, ... are, in order, the components of
      // member 0, then the components of member 1, etc.
      const name = `v${argNames.length}`;
      argNames.push(name);
      argNamesTyped.push(`${name}: number`);
    }
  }

  output.push(
    `
    public emplaceBack(${argNamesTyped.join(', ')}): number {
        const i = this.length;
        this.resize(i + 1);
        return this.emplace(i, ${argNames.join(', ')});
    }

    public emplace(i: number, ${argNamesTyped.join(', ')}): number {`,
  );

  for (const size of usedTypeSizes) {
    output.push(
      `        const o${size.toFixed(0)} = i * ${(bytesPerElement / size).toFixed(0)};`,
    );
  }

  let argIndex = 0;
  for (const member of members) {
    for (let c = 0; c < member.components; c++) {
      // The index for `member` component `c` into the appropriate type array is:
      // this.{TYPE}[o{SIZE} + MEMBER_OFFSET + {c}] = v{X}
      // where MEMBER_OFFSET = ROUND(member.offset / size) is the per-element
      // offset of this member into the array
      const index = `o${member.size.toFixed(0)} + ${(member.offset / member.size + c).toFixed(0)}`;

      output.push(
        `        this.${member.view}[${index}] = v${argIndex++};`,
      );
    }
  }

  output.push(
    `        return i;
    }
}

${structArrayLayoutClass}.prototype.bytesPerElement = ${size};

`,
  );

  return output.join('\n');
}

function emitStructArray(locals) {
  const output = [];
  const {
    arrayClass,
    members,
    size,
    hasAnchorPoint,
    layoutClass,
    includeStructAccessors,
  } = locals;

  const structTypeClass = arrayClass.replace('Array', 'Struct');
  const structArrayClass = arrayClass;
  const structArrayLayoutClass = layoutClass;

  // collect components
  const components = [];
  for (const member of members) {
    for (let c = 0; c < member.components; c++) {
      let name = member.name;
      if (member.components > 1) {
        name += c;
      }
      components.push({ name, member, component: c });
    }
  }

  // exceptions for which we generate accessors on the array rather than a separate struct for performance
  const useComponentGetters = structArrayClass === 'GlyphOffsetArray' || structArrayClass === 'SymbolLineVertexArray';

  if (includeStructAccessors && !useComponentGetters) {
    output.push(
      `/** @internal */
class ${structTypeClass} extends Struct {
    declare _structArray: ${structArrayClass};`,
    );

    for (const { name, member, component } of components) {
      const elementOffset = `this._pos${member.size.toFixed(0)}`;
      const componentOffset = (member.offset / member.size + component).toFixed(0);
      const index = `${elementOffset} + ${componentOffset}`;
      const componentAccess = `this._structArray.${member.view}[${index}]`;

      output.push(
        `    get ${name}(): number { return ${componentAccess}; }`,
      );

      // generate setters for properties that are updated during runtime symbol placement; others are read-only
      if (name === 'crossTileID' || name === 'placedOrientation' || name === 'hidden') {
        output.push(
          `    set ${name}(x: number) { ${componentAccess} = x; }`,
        );
      }
    }

    // Special case used for the CollisionBoxArray type
    if (hasAnchorPoint) {
      output.push(
        '    get anchorPoint(): Point { return new Point(this.anchorPointX, this.anchorPointY); }',
      );
    }

    output.push(
      `}

${structTypeClass}.prototype.size = ${size};

export type ${structTypeClass.replace('Struct', '')} = ${structTypeClass};
`,
    );
  } // end 'if (includeStructAccessors)'

  output.push(
    `/** @internal */
export class ${structArrayClass} extends ${structArrayLayoutClass} {`,
  );

  if (useComponentGetters) {
    for (const member of members) {
      for (let c = 0; c < member.components; c++) {
        if (!includeStructAccessors)
          continue;
        let name = `get${member.name}`;
        if (member.components > 1) {
          name += c;
        }
        const componentOffset = (member.offset / member.size + c).toFixed(0);
        const componentStride = size / member.size;
        output.push(
          `    ${name}(index: number): number { return this.${member.view}[index * ${componentStride} + ${componentOffset}]; }`,
        );
      }
    }
  }
  else if (includeStructAccessors) { // get(i)
    output.push(
      `    /**
     * Return the ${structTypeClass} at the given location in the array.
     * @param index - The index of the element.
     */
    get(index: number): ${structTypeClass} {
        return new ${structTypeClass}(this, index);
    }`,
    );
  }
  output.push(
    `}


`,
  );

  return output.join('\n');
}

fs.writeFileSync(new URL('../src/data/array-types.g.ts', import.meta.url), `// This file is generated. Edit build/generate-struct-arrays.ts, then run \`npm run codegen\`.

import {Struct, StructArray} from '../util/struct-array';
import type {TransferRegistry} from '../worker/transfer-registry';
import Point from '@mapbox/point-geometry';

${layouts.map(emitStructArrayLayout).join('\n')}
${arraysWithStructAccessors.map(emitStructArray).join('\n')}
${[...arrayTypeEntries].join('\n')}
export function registerArrayTransfers(registry: TransferRegistry): void {
${layouts.map(layout => `    registry.register('${layout.className}', ${layout.className});`).join('\n')}
${arraysWithStructAccessors.map(array => `    registry.register('${array.arrayClass}', ${array.arrayClass});`).join('\n')}
}
export {
    ${layouts.map(layout => layout.className).join(',\n    ')}
};
`);
