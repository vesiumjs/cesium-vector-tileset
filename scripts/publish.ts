import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../packages/cesium-vector-tileset/', import.meta.url));
const workspace = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../packages/cesium-vector-tileset/package.json', import.meta.url), 'utf8')) as { version: string };
const { version: workspaceVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
if (workspaceVersion !== version) {
  throw new Error(`Workspace version ${workspaceVersion} must match package version ${version}`);
}
if (process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Release tag must be v${version}, received ${process.env.GITHUB_REF_NAME}`);
}

const directory = mkdtempSync(join(tmpdir(), 'cesium-vector-tileset-publish-'));
const archive = join(directory, 'package.tgz');
const tag = version.includes('-') ? 'next' : 'latest';

try {
  execFileSync('pnpm', ['build:ci'], { cwd: workspace, stdio: 'inherit' });
  execFileSync('pnpm', ['pack', '--out', archive], { cwd, stdio: 'inherit' });
  execFileSync('npm', ['publish', archive, '--access', 'public', '--tag', tag, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
}
finally {
  rmSync(directory, { recursive: true, force: true });
}
