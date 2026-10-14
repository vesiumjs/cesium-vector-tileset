# Shared Latin glyphs

`0-255.pbf` is a fixed subset of Latin letters, digits and space rasterized from the browser's actual sans-serif font with TinySDF 2.2.0 (24px, buffer 3, radius 8, cutoff 0.25). It uses the standard glyph PBF schema, measured glyph bounds and advance, and `top = glyphTop - 8`.

Both renderers load these same bytes through their normal glyph request, parser, atlas and Worker paths. CJK characters still use the same browser's local ideograph font. The fixture isolates layout and orientation errors without substituting test quads or changing production glyphs.
