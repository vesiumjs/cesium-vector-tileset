import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function preparePackage(): void {
  const packageRequire = createRequire(import.meta.url);

  for (const name of ['README.md', 'README.zh-CN.md']) {
    const readme = readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
    writeFileSync(new URL(`../${name}`, import.meta.url), readme);
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
  ];

  const notices = licenses.map(([name, file]) => `${name}\n\n${readFileSync(new URL(file, import.meta.url), 'utf8').trim()}`);

  // The Worker modules bundle Cesium's CPU runtime. Its complete upstream
  // licenses include notices for the third-party Core algorithms it contains.
  let runtimeRequire = packageRequire;
  for (const name of ['cesium', '@cesium/engine', '@cesium/core']) {
    const entry = runtimeRequire.resolve(name);
    const license = new URL('./LICENSE.md', pathToFileURL(entry));
    notices.push(`${name} (geometry Worker runtime and upstream notices)\n\n${readFileSync(license, 'utf8').trim()}`);
    runtimeRequire = createRequire(entry);
  }

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
}
