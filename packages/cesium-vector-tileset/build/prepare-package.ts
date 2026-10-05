import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

for (const name of ['README.md', 'README.zh-CN.md']) {
  copyFileSync(
    new URL(`../../../${name}`, import.meta.url),
    new URL(`../${name}`, import.meta.url),
  );
}

// These dependencies are bundled into the main and Worker modules. Keep their
// original notices alongside the derived MapLibre code, even after minification.
const licenses = [
  ['MapLibre GL JS (including its upstream notices)', '../../../node_modules/maplibre-gl/LICENSE.txt'],
  ['@mapbox/point-geometry', '../node_modules/@mapbox/point-geometry/LICENSE'],
  ['@mapbox/tiny-sdf', '../node_modules/@mapbox/tiny-sdf/LICENSE.txt'],
  ['@mapbox/vector-tile', '../node_modules/@mapbox/vector-tile/LICENSE.txt'],
  ['@maplibre/geojson-vt', '../node_modules/@maplibre/geojson-vt/LICENSE'],
  ['@maplibre/maplibre-gl-style-spec', '../node_modules/@maplibre/maplibre-gl-style-spec/LICENSE.txt'],
  ['@maplibre/mlt', '../node_modules/@maplibre/mlt/LICENSE.txt'],
  ['@maplibre/vt-pbf', '../node_modules/@maplibre/vt-pbf/LICENSE'],
  ['earcut', '../node_modules/earcut/LICENSE'],
  ['gl-matrix', '../node_modules/gl-matrix/LICENSE.md'],
  ['pbf', '../node_modules/pbf/LICENSE'],
  ['potpack', '../node_modules/potpack/LICENSE'],
  ['tinyqueue', '../node_modules/tinyqueue/LICENSE'],
  // Preserve the upstream ISC notice inherited through MapLibre's tile URL helper.
  ['MapLibre GL JS tile URL bounding box calculation (upstream ISC notice)', './whoots-license.txt'],
];

const notices = licenses.map(([name, file]) => `${name}\n\n${readFileSync(new URL(file, import.meta.url), 'utf8').trim()}`);

// murmurhash-js publishes its complete MIT license only in the README.
const murmurReadme = readFileSync(new URL('../node_modules/murmurhash-js/README.md', import.meta.url), 'utf8');
const licenseHeading = '## License (MIT)';
const licenseStart = murmurReadme.indexOf(licenseHeading);
if (licenseStart < 0) {
  throw new Error('murmurhash-js README must contain its MIT license');
}
notices.push(`murmurhash-js\n\n${murmurReadme.slice(licenseStart + licenseHeading.length).trim()}`);

writeFileSync(
  new URL('../dist/THIRD_PARTY_NOTICES.txt', import.meta.url),
  `Third-party notices for code included in cesium-vector-tileset.\n\n${notices.join('\n\n-------------------------------------------------------------------------------\n\n')}\n`,
);
