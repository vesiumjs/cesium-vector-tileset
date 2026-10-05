import type { AlphaImage } from '../util/image';

/**
 * Some metices related to a glyph
 */
export interface GlyphMetrics {
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
  /**
   * isDoubleResolution = true for 48px textures
   */
  isDoubleResolution?: boolean;
}

/**
 * A style glyph type
 */
export interface StyleGlyph {
  id: number;
  bitmap: AlphaImage;
  metrics: GlyphMetrics;
}
