import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_ZIP_NAME,
  VERSION_JSON_NAME,
  assertTagMatchesManifest,
  buildDownloadUrl,
  buildVersionMetadata,
  createZip,
  listZipEntries,
  resolveRuntimeFiles,
  sha256File,
  stageRuntimeFiles,
  versionFromTag,
} from '../scripts/release/lib.mjs';

const execFileAsync = promisify(execFile);

const ROOT = path.join(import.meta.dirname, '..');
const MANIFEST = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));

const tmpDirs = [];
const makeTmpDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-release-test-'));
  tmpDirs.push(dir);
  return dir;
};

test.after(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('versionFromTag accepts v*.*.* and strips the v', () => {
  assert.equal(versionFromTag('v0.4.4'), '0.4.4');
  assert.equal(versionFromTag('v10.20.30'), '10.20.30');
});

test('versionFromTag rejects malformed tags', () => {
  for (const bad of ['0.4.4', 'v0.4', 'v0.4.4.4', 'v0.4.4-rc1', 'latest', '', undefined, null]) {
    assert.throws(() => versionFromTag(bad), /Invalid release tag/, `tag: ${bad}`);
  }
});

test('assertTagMatchesManifest enforces exact tag/version equality', () => {
  assert.equal(assertTagMatchesManifest('v0.4.3', { version: '0.4.3' }), '0.4.3');

  assert.throws(
    () => assertTagMatchesManifest('v0.4.4', { version: '0.4.3' }),
    /Tag v0\.4\.4 \(version 0\.4\.4\) does not match manifest\.json version "0\.4\.3"/
  );
  assert.throws(() => assertTagMatchesManifest('v0.4.3', {}), /does not match/);
});

test('resolveRuntimeFiles covers manifest references and walked imports', async () => {
  const files = await resolveRuntimeFiles(ROOT, MANIFEST);

  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('options.html'));
  assert.ok(files.includes('src/background.js'));
  assert.ok(files.includes('src/content.js'));
  assert.ok(files.includes('src/options.js'));
  // The popup is reached through action.default_popup → popup.html, whose
  // stylesheet/script refs and the script's imports are walked.
  assert.equal(MANIFEST.action.default_popup, 'popup.html');
  assert.ok(files.includes('popup.html'));
  assert.ok(files.includes('popup.css'));
  assert.ok(files.includes('src/popup.js'));
  assert.ok(files.includes('src/status.js'));
  // protocol.js is never listed in the manifest — it must come from the import walk.
  assert.ok(files.includes('src/protocol.js'));
  assert.deepEqual(
    files.filter((file) => file.startsWith('icons/')).sort(),
    ['icons/icon128.png', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png']
  );
  // No dev-only files sneak into the runtime set.
  assert.ok(!files.some((file) => file.startsWith('test/') || file.startsWith('scripts/')));
  assert.ok(!files.includes('package.json'));
});

test('packaged zip has manifest.json at its root and a matching sha256', async () => {
  const workDir = await makeTmpDir();
  const stagingDir = path.join(workDir, 'staging');
  const zipPath = path.join(workDir, RELEASE_ZIP_NAME);

  const files = await stageRuntimeFiles(ROOT, stagingDir, MANIFEST);
  await createZip(stagingDir, zipPath, files);

  const entries = await listZipEntries(zipPath);
  assert.ok(entries.includes('manifest.json'), 'manifest.json must be a root-level entry');
  assert.ok(!entries.some((entry) => entry.endsWith('/manifest.json')));
  assert.ok(entries.includes('src/protocol.js'));
  assert.ok(!entries.some((entry) => entry.startsWith('test/')));
  assert.ok(!entries.some((entry) => entry.startsWith('scripts/')));
  assert.ok(!entries.includes('package.json'));
  assert.ok(!entries.some((entry) => entry.includes('.staging')));

  // sha256File must match an independent shell recomputation.
  const direct = (await execFileAsync('shasum', ['-a', '256', zipPath])).stdout.split(' ')[0];
  assert.equal(await sha256File(zipPath), direct);
});

test('every local src/href/import of every packaged file is itself packaged', async () => {
  const workDir = await makeTmpDir();
  const stagingDir = path.join(workDir, 'staging');
  const zipPath = path.join(workDir, RELEASE_ZIP_NAME);

  const files = await stageRuntimeFiles(ROOT, stagingDir, MANIFEST);
  await createZip(stagingDir, zipPath, files);
  const entries = new Set(await listZipEntries(zipPath));

  assert.ok(entries.has(MANIFEST.action.default_popup), 'default_popup is in the ZIP');

  const refPattern = /(?:src|href)\s*=\s*(['"])([^'"#:]+)\1|from\s*(['"])(\.[^'"]+)\3/g;
  for (const file of files.filter((name) => /\.(html|js)$/.test(name))) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(refPattern)) {
      const ref = match[2] ?? match[4];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref));
      assert.ok(entries.has(resolved), `${file} references ${ref}, missing from ZIP`);
    }
  }
});

test('buildVersionMetadata and download URL shape', () => {
  const sha256 = 'a'.repeat(64);
  const url = buildDownloadUrl('qhkly/chatgpt-ai-studio-bridge', 'v0.4.4');
  assert.equal(url, 'https://github.com/qhkly/chatgpt-ai-studio-bridge/releases/download/v0.4.4/chatgpt-ai-studio-bridge.zip');

  const metadata = buildVersionMetadata({
    version: '0.4.4',
    downloadUrl: url,
    sha256,
    tag: 'v0.4.4',
  });
  // Minimal protocol: exactly these four fields, no commit tracking.
  assert.deepEqual(metadata, {
    version: '0.4.4',
    downloadUrl: url,
    sha256,
    tag: 'v0.4.4',
  });

  assert.throws(() => buildVersionMetadata({
    version: '0.4.4',
    downloadUrl: url,
    sha256: 'tooshort',
    tag: 'v0.4.4',
  }), /sha256/);
});

test('package.mjs end-to-end produces zip + version.json for a matching tag', async () => {
  const outDir = await makeTmpDir();
  const tag = `v${MANIFEST.version}`;

  const { stdout } = await execFileAsync(
    'node',
    [path.join(ROOT, 'scripts/release/package.mjs'),
      '--tag', tag,
      '--repo', 'qhkly/chatgpt-ai-studio-bridge',
      '--out', outDir],
    { cwd: ROOT }
  );
  assert.match(stdout, new RegExp(`Packaged ${tag}`));

  const metadata = JSON.parse(await readFile(path.join(outDir, VERSION_JSON_NAME), 'utf8'));
  assert.equal(metadata.version, MANIFEST.version);
  assert.equal(metadata.tag, tag);
  assert.deepEqual(Object.keys(metadata).sort(), ['downloadUrl', 'sha256', 'tag', 'version']);
  assert.equal(metadata.downloadUrl, `https://github.com/qhkly/chatgpt-ai-studio-bridge/releases/download/${tag}/${RELEASE_ZIP_NAME}`);
  assert.match(metadata.sha256, /^[0-9a-f]{64}$/);

  // version.json's sha256 must be the actual digest of the shipped zip.
  assert.equal(metadata.sha256, await sha256File(path.join(outDir, RELEASE_ZIP_NAME)));

  const entries = await listZipEntries(path.join(outDir, RELEASE_ZIP_NAME));
  assert.ok(entries.includes('manifest.json'));
});

test('package.mjs refuses to publish when tag does not match manifest', async () => {
  const outDir = await makeTmpDir();
  const wrongTag = `v${Number(MANIFEST.version.split('.')[2]) + 1000}.${MANIFEST.version.split('.')[1]}.${MANIFEST.version.split('.')[0]}`;

  await assert.rejects(
    execFileAsync('node',
      [path.join(ROOT, 'scripts/release/package.mjs'),
        '--tag', wrongTag,
        '--repo', 'qhkly/chatgpt-ai-studio-bridge',
        '--out', outDir], { cwd: ROOT }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /does not match manifest\.json version/);
      return true;
    }
  );

  // Nothing publishable may exist after the failure.
  await assert.rejects(readFile(path.join(outDir, RELEASE_ZIP_NAME)));
  await assert.rejects(readFile(path.join(outDir, VERSION_JSON_NAME)));
});
