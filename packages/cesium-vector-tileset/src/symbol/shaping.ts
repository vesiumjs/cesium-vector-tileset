import type { Formatted, VerticalAlign } from '@maplibre/maplibre-gl-style-spec';
import type { GlyphPosition, Rect } from '../assets/glyph-atlas';
import type { ImagePosition } from '../assets/image-atlas';
import type { GlyphMetrics, StyleGlyph } from '../style/style-glyph';

import type { ImageSectionOptions, TextSectionOptions } from './tagged-string';
import { IMAGE_PADDING } from '../assets/image-atlas';
import { GLYPH_PBF_BORDER } from '../style/parse-glyph-pbf';
import { TextFit } from '../style/style-image';
import {
  codePointHasUprightVerticalOrientation,
} from '../util/unicode-properties.g';
import { processStyledBidirectionalText } from './bidi';
import ONE_EM from './one-em';
import {
  charInComplexShapingScript,
  charIsWhitespace,
} from './script-detection';
import { TaggedString } from './tagged-string';

export const WritingMode = {
  none: 0,
  horizontal: 1,
  vertical: 2,
  horizontalOnly: 3,
} as const;
export type WritingMode = (typeof WritingMode)[keyof typeof WritingMode];

const SHAPING_DEFAULT_OFFSET = -17;

// The position of a glyph relative to the text's anchor point.
export interface PositionedGlyph {
  glyph: number;
  imageName: string | null;
  x: number;
  y: number;
  vertical: boolean;
  scale: number;
  fontStack: string;
  sectionIndex: number;
  metrics: GlyphMetrics;
  rect: Rect | null;
}

export interface PositionedLine {
  positionedGlyphs: PositionedGlyph[];
  lineOffset: number;
}

// A collection of positioned glyphs and some metadata
export interface Shaping {
  positionedLines: PositionedLine[];
  top: number;
  bottom: number;
  left: number;
  right: number;
  writingMode: typeof WritingMode.horizontal | typeof WritingMode.vertical;
  text: string;
  iconsInText: boolean;
  verticalizable: boolean;
}

interface ShapingSectionAttributes {
  rect: Rect | null;
  metrics: GlyphMetrics;
  baselineOffset: number;
  imageOffset?: number;
}

interface LineShapingSize {
  verticalLineContentWidth: number;
  horizontalLineContentHeight: number;
}

function isEmpty(positionedLines: PositionedLine[]) {
  for (const line of positionedLines) {
    if (line.positionedGlyphs.length !== 0) {
      return false;
    }
  }
  return true;
}

export type SymbolAnchor = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type TextJustify = 'left' | 'center' | 'right';

function shapeText(
  text: Formatted,
  glyphMap: {
    [_: string]: {
      [_: number]: StyleGlyph;
    };
  },
  glyphPositions: {
    [_: string]: {
      [_: number]: GlyphPosition;
    };
  },
  imagePositions: { [_: string]: ImagePosition },
  defaultFontStack: string,
  maxWidth: number,
  lineHeight: number,
  textAnchor: SymbolAnchor,
  textJustify: TextJustify,
  spacing: number,
  translate: [number, number],
  writingMode: typeof WritingMode.horizontal | typeof WritingMode.vertical,
  allowVerticalPlacement: boolean,
  layoutTextSize: number,
  layoutTextSizeThisZoom: number,
): Shaping | false {
  const logicalInput = TaggedString.fromFeature(text, defaultFontStack);

  if (writingMode === WritingMode.vertical) {
    logicalInput.verticalizePunctuation();
  }

  // The bidi algorithm uses UTF-16 offsets; TaggedString tracks Unicode code points.
  const lineBreaks = logicalInput.determineLineBreaks(spacing, maxWidth, glyphMap, imagePositions, layoutTextSize)
    .map(index => logicalInput.toCodeUnitIndex(index));
  const styleIndices: number[] = [];
  let index = 0;
  for (const char of logicalInput.text) {
    for (let offset = 0; offset < char.length; offset++) {
      styleIndices.push(logicalInput.sectionIndex[index]);
    }
    index++;
  }
  const lines = processStyledBidirectionalText(logicalInput.text, styleIndices, lineBreaks)
    .map(([text, styles]) => {
      const sectionIndex: number[] = [];
      let offset = 0;
      for (const char of text) {
        sectionIndex.push(styles[offset]);
        offset += char.length;
      }
      return new TaggedString(text, logicalInput.sections, sectionIndex);
    });

  const positionedLines: PositionedLine[] = [];
  const shaping: Shaping = {
    positionedLines,
    text: logicalInput.toString(),
    top: translate[1],
    bottom: translate[1],
    left: translate[0],
    right: translate[0],
    writingMode,
    iconsInText: false,
    verticalizable: false,
  };

  shapeLines(shaping, glyphMap, glyphPositions, imagePositions, lines, lineHeight, textAnchor, textJustify, writingMode, spacing, allowVerticalPlacement, layoutTextSizeThisZoom);
  if (isEmpty(positionedLines))
    return false;

  return shaping;
}

function getAnchorAlignment(anchor: SymbolAnchor): { horizontalAlign: number; verticalAlign: number } {
  let horizontalAlign = 0.5;
  let verticalAlign = 0.5;

  switch (anchor) {
    case 'right':
    case 'top-right':
    case 'bottom-right':
      horizontalAlign = 1;
      break;
    case 'left':
    case 'top-left':
    case 'bottom-left':
      horizontalAlign = 0;
      break;
  }

  switch (anchor) {
    case 'bottom':
    case 'bottom-right':
    case 'bottom-left':
      verticalAlign = 1;
      break;
    case 'top':
    case 'top-right':
    case 'top-left':
      verticalAlign = 0;
      break;
  }

  return { horizontalAlign, verticalAlign };
}

function calculateLineContentSize(
  imagePositions: { [_: string]: ImagePosition },
  line: TaggedString,
  layoutTextSizeFactor: number,
): LineShapingSize {
  const maxGlyphSize = line.getMaxScale() * ONE_EM;
  const { maxImageWidth, maxImageHeight } = line.getMaxImageSize(imagePositions);

  const horizontalLineContentHeight = Math.max(maxGlyphSize, maxImageHeight * layoutTextSizeFactor);
  const verticalLineContentWidth = Math.max(maxGlyphSize, maxImageWidth * layoutTextSizeFactor);

  return { verticalLineContentWidth, horizontalLineContentHeight };
}

function getVerticalAlignFactor(
  verticalAlign: VerticalAlign,
) {
  switch (verticalAlign) {
    case 'top':
      return 0;
    case 'center':
      return 0.5;
    default:
      return 1;
  }
}

function getRectAndMetrics(
  glyphPosition: GlyphPosition | undefined,
  glyphMap: {
    [_: string]: {
      [_: number]: StyleGlyph;
    };
  },
  section: TextSectionOptions,
  codePoint: number,
): Pick<PositionedGlyph, 'rect' | 'metrics'> | null {
  if (glyphPosition?.rect) {
    return glyphPosition;
  }

  const glyphs = glyphMap[section.fontStack];
  const glyph = glyphs?.[codePoint];
  if (!glyph)
    return null;

  const metrics = glyph.metrics;
  return { rect: null, metrics };
}

function isLineVertical(
  writingMode: typeof WritingMode.horizontal | typeof WritingMode.vertical,
  allowVerticalPlacement: boolean,
  codePoint: number,
): boolean {
  return !(writingMode === WritingMode.horizontal
  // Don't verticalize glyphs that have no upright orientation if vertical placement is disabled.
    || (!allowVerticalPlacement && !codePointHasUprightVerticalOrientation(codePoint))
  // If vertical placement is enabled, don't verticalize glyphs that
  // are from complex text layout script, or whitespaces.
    || (allowVerticalPlacement && (charIsWhitespace(codePoint) || charInComplexShapingScript(codePoint))));
}

function shapeLines(shaping: Shaping, glyphMap: {
  [_: string]: {
    [_: number]: StyleGlyph;
  };
}, glyphPositions: {
  [_: string]: {
    [_: number]: GlyphPosition;
  };
}, imagePositions: { [_: string]: ImagePosition }, lines: TaggedString[], lineHeight: number, textAnchor: SymbolAnchor, textJustify: TextJustify, writingMode: typeof WritingMode.horizontal | typeof WritingMode.vertical, spacing: number, allowVerticalPlacement: boolean, layoutTextSizeThisZoom: number) {
  let x = 0;
  let y = 0;

  let maxLineLength = 0;
  let maxLineHeight = 0;

  const justify
    = textJustify === 'right'
      ? 1
      : textJustify === 'left' ? 0 : 0.5;
  const layoutTextSizeFactor = ONE_EM / layoutTextSizeThisZoom;

  let lineIndex = 0;
  for (const line of lines) {
    line.trim();

    const lineMaxScale = line.getMaxScale();
    const positionedLine: PositionedLine = { positionedGlyphs: [], lineOffset: 0 };
    shaping.positionedLines[lineIndex] = positionedLine;
    const positionedGlyphs = positionedLine.positionedGlyphs;
    let imageOffset = 0.0;

    if (!line.length()) {
      y += lineHeight; // Still need a line feed after empty line
      ++lineIndex;
      continue;
    }

    const lineShapingSize = calculateLineContentSize(imagePositions, line, layoutTextSizeFactor);

    let i = 0;
    for (const char of line.text) {
      const section = line.getSection(i);
      // String iteration yields a nonempty Unicode code point.
      const codePoint = char.codePointAt(0)!;
      const vertical = isLineVertical(writingMode, allowVerticalPlacement, codePoint);
      const sectionIndex = line.getSectionIndex(i);
      i++;
      let imageName: string | null = null;
      let fontStack = '';
      let sectionAttributes: ShapingSectionAttributes;
      if ('fontStack' in section) {
        const attributes = shapeTextSection(section, codePoint, vertical, lineShapingSize, glyphMap, glyphPositions);
        if (!attributes)
          continue;
        sectionAttributes = attributes;
        fontStack = section.fontStack;
      }
      else {
        shaping.iconsInText = true;
        // Image sections use the current text-size factor in glyph units.
        section.scale *= layoutTextSizeFactor;
        const attributes = shapeImageSection(section, vertical, lineMaxScale, lineShapingSize, imagePositions);
        if (!attributes)
          continue;
        sectionAttributes = attributes;
        imageOffset = Math.max(imageOffset, attributes.imageOffset);
        imageName = section.imageName;
      }

      const { rect, metrics, baselineOffset } = sectionAttributes;
      positionedGlyphs.push({
        glyph: codePoint,
        imageName,
        x,
        y: y + SHAPING_DEFAULT_OFFSET + baselineOffset,
        vertical,
        scale: section.scale,
        fontStack,
        sectionIndex,
        metrics,
        rect,
      });

      if (!vertical) {
        x += metrics.advance * section.scale + spacing;
      }
      else {
        shaping.verticalizable = true;
        const verticalAdvance = 'imageName' in section ? metrics.advance : ONE_EM;
        x += verticalAdvance * section.scale + spacing;
      }
    }

    // Only justify if we placed at least one glyph
    if (positionedGlyphs.length !== 0) {
      const lineLength = x - spacing;
      maxLineLength = Math.max(lineLength, maxLineLength);
      justifyLine(positionedGlyphs, 0, positionedGlyphs.length - 1, justify);
    }

    x = 0;
    const maxLineOffset = (lineMaxScale - 1) * ONE_EM;
    positionedLine.lineOffset = Math.max(imageOffset, maxLineOffset);
    const currentLineHeight = lineHeight * lineMaxScale + imageOffset;
    y += currentLineHeight;
    maxLineHeight = Math.max(currentLineHeight, maxLineHeight);
    ++lineIndex;
  }

  // Calculate the bounding box and justify / align text block.
  const { horizontalAlign, verticalAlign } = getAnchorAlignment(textAnchor);
  align(shaping.positionedLines, justify, horizontalAlign, verticalAlign, maxLineLength, maxLineHeight, lineHeight, y, lines.length);

  // Calculate the bounding box
  // shaping.top & shaping.left already include text offset (text-radial-offset or text-offset)
  shaping.top += -verticalAlign * y;
  shaping.bottom = shaping.top + y;
  shaping.left += -horizontalAlign * maxLineLength;
  shaping.right = shaping.left + maxLineLength;
}

function shapeTextSection(
  section: TextSectionOptions,
  codePoint: number,
  vertical: boolean,
  lineShapingSize: LineShapingSize,
  glyphMap: {
    [_: string]: {
      [_: number]: StyleGlyph;
    };
  },
  glyphPositions: {
    [_: string]: {
      [_: number]: GlyphPosition;
    };
  },
): ShapingSectionAttributes | null {
  const positions = glyphPositions[section.fontStack];
  const glyphPosition = positions?.[codePoint];

  const rectAndMetrics = getRectAndMetrics(glyphPosition, glyphMap, section, codePoint);

  if (rectAndMetrics === null)
    return null;

  let baselineOffset: number;
  if (vertical) {
    baselineOffset = lineShapingSize.verticalLineContentWidth - section.scale * ONE_EM;
  }
  else {
    const verticalAlignFactor = getVerticalAlignFactor(section.verticalAlign);
    baselineOffset = (lineShapingSize.horizontalLineContentHeight - section.scale * ONE_EM) * verticalAlignFactor;
  }

  return {
    rect: rectAndMetrics.rect,
    metrics: rectAndMetrics.metrics,
    baselineOffset,
  };
}

function shapeImageSection(
  section: ImageSectionOptions,
  vertical: boolean,
  lineMaxScale: number,
  lineShapingSize: LineShapingSize,
  imagePositions: { [_: string]: ImagePosition },
): (ShapingSectionAttributes & { imageOffset: number }) | null {
  const imagePosition = imagePositions[section.imageName];
  if (!imagePosition)
    return null;
  const rect = imagePosition.paddedRect;
  const size = imagePosition.displaySize;

  const metrics = { width: size[0], height: size[1], left: IMAGE_PADDING, top: -GLYPH_PBF_BORDER, advance: vertical ? size[1] : size[0] };

  let baselineOffset: number;
  if (vertical) {
    baselineOffset = lineShapingSize.verticalLineContentWidth - size[1] * section.scale;
  }
  else {
    const verticalAlignFactor = getVerticalAlignFactor(section.verticalAlign);
    baselineOffset = (lineShapingSize.horizontalLineContentHeight - size[1] * section.scale) * verticalAlignFactor;
  }

  // Difference between height of an image and one EM at max line scale.
  // Pushes current line down if an image size is over 1 EM at max line scale.
  const imageOffset = (vertical ? size[0] : size[1]) * section.scale - ONE_EM * lineMaxScale;

  return { rect, metrics, baselineOffset, imageOffset };
}

// justify right = 1, left = 0, center = 0.5
function justifyLine(positionedGlyphs: PositionedGlyph[], start: number, end: number, justify: 1 | 0 | 0.5) {
  if (justify === 0)
    return;

  const lastPositionedGlyph = positionedGlyphs[end];
  const lastAdvance = lastPositionedGlyph.metrics.advance * lastPositionedGlyph.scale;
  const lineIndent = (positionedGlyphs[end].x + lastAdvance) * justify;

  for (let j = start; j <= end; j++) {
    positionedGlyphs[j].x -= lineIndent;
  }
}

/**
 * Aligns the lines based on horizontal and vertical alignment.
 */
function align(positionedLines: PositionedLine[], justify: number, horizontalAlign: number, verticalAlign: number, maxLineLength: number, maxLineHeight: number, lineHeight: number, blockHeight: number, lineCount: number) {
  const shiftX = (justify - horizontalAlign) * maxLineLength;
  let shiftY = 0;

  if (maxLineHeight !== lineHeight) {
    shiftY = -blockHeight * verticalAlign - SHAPING_DEFAULT_OFFSET;
  }
  else {
    shiftY = -verticalAlign * lineCount * lineHeight + 0.5 * lineHeight;
  }

  for (const line of positionedLines) {
    for (const positionedGlyph of line.positionedGlyphs) {
      positionedGlyph.x += shiftX;
      positionedGlyph.y += shiftY;
    }
  }
}

export interface PositionedIcon {
  image: ImagePosition;
  top: number;
  bottom: number;
  left: number;
  right: number;
  collisionPadding?: [number, number, number, number];
}

function shapeIcon(
  image: ImagePosition,
  iconOffset: [number, number],
  iconAnchor: SymbolAnchor,
): PositionedIcon {
  const { horizontalAlign, verticalAlign } = getAnchorAlignment(iconAnchor);
  const dx = iconOffset[0];
  const dy = iconOffset[1];
  const x1 = dx - image.displaySize[0] * horizontalAlign;
  const x2 = x1 + image.displaySize[0];
  const y1 = dy - image.displaySize[1] * verticalAlign;
  const y2 = y1 + image.displaySize[1];
  return { image, top: y1, bottom: y2, left: x1, right: x2 };
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Called after a PositionedIcon has already been run through fitIconToText,
 * but needs further adjustment to apply textFitWidth and textFitHeight.
 * @param shapedIcon - The icon that will be adjusted.
 * @returns Extents of the shapedIcon with text fit adjustments if necessary.
 */
function applyTextFit(shapedIcon: PositionedIcon): Box {
  const content = shapedIcon.image.content;
  if (!content)
    throw new Error('Icon text-fit adjustment requires an image content rectangle');
  // Size of the icon after it was adjusted using stretchX and Y
  let iconLeft = shapedIcon.left;
  let iconTop = shapedIcon.top;
  let iconWidth = shapedIcon.right - iconLeft;
  let iconHeight = shapedIcon.bottom - iconTop;
  // Size of the original content area
  const contentWidth = content[2] - content[0];
  const contentHeight = content[3] - content[1];
  const textFitWidth = shapedIcon.image.textFitWidth ?? TextFit.stretchOrShrink;
  const textFitHeight = shapedIcon.image.textFitHeight ?? TextFit.stretchOrShrink;
  const contentAspectRatio = contentWidth / contentHeight;
  // Scale to the proportional axis first note that height takes precedence if
  // both axes are set to proportional.
  if (textFitHeight === TextFit.proportional) {
    if ((textFitWidth === TextFit.stretchOnly && iconWidth / iconHeight < contentAspectRatio) || textFitWidth === TextFit.proportional) {
      // Push the width of the icon back out to match the content aspect ratio
      const newIconWidth = Math.ceil(iconHeight * contentAspectRatio);
      iconLeft *= newIconWidth / iconWidth;
      iconWidth = newIconWidth;
    }
  }
  else if (textFitWidth === TextFit.proportional) {
    if (textFitHeight === TextFit.stretchOnly && contentAspectRatio !== 0 && iconWidth / iconHeight > contentAspectRatio) {
      // Push the height of the icon back out to match the content aspect ratio
      const newIconHeight = Math.ceil(iconWidth / contentAspectRatio);
      iconTop *= newIconHeight / iconHeight;
      iconHeight = newIconHeight;
    }
  }
  else {
    // If neither textFitHeight nor textFitWidth are proportional then
    // there is no effect since the content rectangle should be precisely
    // matched to the content
  }
  return { x1: iconLeft, y1: iconTop, x2: iconLeft + iconWidth, y2: iconTop + iconHeight };
}

function fitIconToText(
  shapedIcon: PositionedIcon,
  shapedText: Shaping,
  textFit: string,
  padding: [number, number, number, number],
  iconOffset: [number, number],
  fontScale: number,
): PositionedIcon {
  const image = shapedIcon.image;

  let collisionPadding: PositionedIcon['collisionPadding'];
  if (image.content) {
    const content = image.content;
    const pixelRatio = image.pixelRatio || 1;
    collisionPadding = [
      content[0] / pixelRatio,
      content[1] / pixelRatio,
      image.displaySize[0] - content[2] / pixelRatio,
      image.displaySize[1] - content[3] / pixelRatio,
    ];
  }

  // We don't respect the icon-anchor, because icon-text-fit is set. Instead,
  // the icon will be centered on the text, then stretched in the given
  // dimensions.

  const textLeft = shapedText.left * fontScale;
  const textRight = shapedText.right * fontScale;

  let top, right, bottom, left;
  if (textFit === 'width' || textFit === 'both') {
    // Stretched horizontally to the text width
    left = iconOffset[0] + textLeft - padding[3];
    right = iconOffset[0] + textRight + padding[1];
  }
  else {
    // Centered on the text
    left = iconOffset[0] + (textLeft + textRight - image.displaySize[0]) / 2;
    right = left + image.displaySize[0];
  }

  const textTop = shapedText.top * fontScale;
  const textBottom = shapedText.bottom * fontScale;
  if (textFit === 'height' || textFit === 'both') {
    // Stretched vertically to the text height
    top = iconOffset[1] + textTop - padding[0];
    bottom = iconOffset[1] + textBottom + padding[2];
  }
  else {
    // Centered on the text
    top = iconOffset[1] + (textTop + textBottom - image.displaySize[1]) / 2;
    bottom = top + image.displaySize[1];
  }

  return { image, top, right, bottom, left, collisionPadding };
}

export { applyTextFit, fitIconToText, getAnchorAlignment, shapeIcon, shapeText, SHAPING_DEFAULT_OFFSET };
