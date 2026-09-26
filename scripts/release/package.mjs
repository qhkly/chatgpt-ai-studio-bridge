#!/usr/bin/env node
// Package the extension for a semantic-version tag release.
//
//   node scripts/release/package.mjs --tag v0.4.4 --repo qhkly/chatgpt-ai-studio-bridge [--out dist/release]
//
// Validates that the tag matches manifest.json, stages the runtime files,
// produces chatgpt-ai-studio-bridge.zip (manifest.json at the ZIP root) and
// version.json (version, downloadUrl, sha256, tag) in --out.
// Exits non-zero without writing anything usable when validation fails.

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RELEASE_ZIP_NAME,
  VERSION_JSON_NAME,
  assertTagMatchesManifest,
  buildDownloadUrl,
  buildVersionMetadata,
  createZip,
  sha256File,
  stageRuntimeFiles,
} from './lib.mjs';

const parseArgs = (argv) => {
  const args = { out: 'dist/release' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  if (!args.tag) throw new Error('--tag is required (e.g. v0.4.4)');
  if (!args.repo) throw new Error('--repo is required (e.g. qhkly/chatgpt-ai-studio-bridge)');
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

  // Fails the run before any artifact is produced when tag != manifest version.
  const version = assertTagMatchesManifest(args.tag, manifest);

  const outDir = path.resolve(root, args.out);
  const stagingDir = path.join(outDir, '.staging');
  const zipPath = path.join(outDir, RELEASE_ZIP_NAME);
  const versionJsonPath = path.join(outDir, VERSION_JSON_NAME);

  await rm(stagingDir, { recursive: true, force: true });
  const files = await stageRuntimeFiles(root, stagingDir, manifest);
  await createZip(stagingDir, zipPath, files);
  await rm(stagingDir, { recursive: true, force: true });

  const sha256 = await sha256File(zipPath);
  const metadata = buildVersionMetadata({
    version,
    downloadUrl: buildDownloadUrl(args.repo, args.tag),
    sha256,
    tag: args.tag,
  });
  await writeFile(versionJsonPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  console.log(`Packaged ${args.tag}:`);
  console.log(`  ${path.relative(root, zipPath)} (${files.length} files, sha256 ${sha256})`);
  console.log(`  ${path.relative(root, versionJsonPath)}`);
};

main().catch((error) => {
  console.error(`[package] ${error.message}`);
  process.exit(1);
});
