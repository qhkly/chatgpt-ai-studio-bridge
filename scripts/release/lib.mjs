import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;
export const RELEASE_ZIP_NAME = 'chatgpt-ai-studio-bridge.zip';
export const VERSION_JSON_NAME = 'version.json';

/** Strip the leading `v` from a tag, throwing unless it is shaped v*.*.*. */
export const versionFromTag = (tag) => {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid release tag "${tag}": expected v*.*.* (e.g. v0.4.4)`);
  }
  return tag.slice(1);
};

/** A tag may only publish when it matches manifest.json exactly. */
export const assertTagMatchesManifest = (tag, manifest) => {
  const tagVersion = versionFromTag(tag);
  const manifestVersion = manifest?.version;
  if (manifestVersion !== tagVersion) {
    throw new Error(
      `Tag ${tag} (version ${tagVersion}) does not match manifest.json version ` +
      `${JSON.stringify(manifestVersion)}; bump manifest.json before tagging.`
    );
  }
  return tagVersion;
};

/** Every extension file the manifest itself points at. */
const manifestReferencedPaths = (manifest) => {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) paths.add(value);
  };

  Object.values(manifest.icons ?? {}).forEach(add);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  add(manifest.action?.default_popup);
  add(manifest.background?.service_worker);
  add(manifest.options_page ?? manifest.options_ui?.page);
  for (const script of manifest.content_scripts ?? []) {
    (script.js ?? []).forEach(add);
    (script.css ?? []).forEach(add);
  }
  return [...paths];
};

const IMPORT_PATTERNS = [
  /(?:^|[^\w$.])from\s*(['"])(\.[^'"]+)\1/g,
  /(?:^|[^\w$.])import\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
  /(?:^|[^\w$.])import\s+(['"])(\.[^'"]+)\1/g,
];

const collectLocalImports = (source) => {
  const specs = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      specs.add(match[2]);
    }
  }
  return [...specs];
};

const HTML_REF_PATTERN = /(?:src|href)\s*=\s*(['"])([^'"#:]+)\1/g;

const collectHtmlRefs = (source) => {
  const refs = new Set();
  for (const match of source.matchAll(HTML_REF_PATTERN)) {
    refs.add(match[2]);
  }
  return [...refs];
};

/**
 * Runtime files = manifest.json + everything the manifest references, then a
 * transitive walk: ESM imports from .js files (protocol.js is reached this
 * way) and src/href references from .html files (options.js, popup.css and
 * popup.js are reached this way).
 */
export const resolveRuntimeFiles = async (root, manifest) => {
  const files = new Set(['manifest.json', ...manifestReferencedPaths(manifest)]);
  const queue = [...files];

  while (queue.length > 0) {
    const file = queue.pop();
    const specs = file.endsWith('.js') || file.endsWith('.mjs')
      ? collectLocalImports
      : file.endsWith('.html')
        ? collectHtmlRefs
        : null;
    if (!specs) continue;

    const source = await readFile(path.join(root, file), 'utf8');
    for (const spec of specs(source)) {
      if (path.posix.isAbsolute(spec)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!files.has(resolved)) {
        files.add(resolved);
        queue.push(resolved);
      }
    }
  }

  return [...files].sort();
};

/** Copy the runtime files into a staging directory, preserving layout. */
export const stageRuntimeFiles = async (root, stagingDir, manifest) => {
  const files = await resolveRuntimeFiles(root, manifest);

  await mkdir(stagingDir, { recursive: true });
  for (const file of files) {
    const target = path.join(stagingDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, file), target);
  }

  return files;
};

/** Zip the staged files so that manifest.json sits at the ZIP root. */
export const createZip = async (stagingDir, zipPath, files) => {
  await mkdir(path.dirname(zipPath), { recursive: true });
  await execFileAsync('zip', ['-X', '-q', path.resolve(zipPath), ...files], {
    cwd: stagingDir,
  });
};

/** Flat entry list of a ZIP file (zipinfo -1), for verification. */
export const listZipEntries = async (zipPath) => {
  const { stdout } = await execFileAsync('zipinfo', ['-1', zipPath]);
  return stdout.split('\n').filter(Boolean).sort();
};

export const sha256File = async (filePath) => {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
};

export const buildDownloadUrl = (repository, tag) =>
  `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${RELEASE_ZIP_NAME}`;

export const buildVersionMetadata = ({ version, downloadUrl, sha256, tag }) => {
  if (typeof version !== 'string' || !version) throw new Error('version is required');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('sha256 must be a 64-char hex digest');
  }
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error(`tag is required and must match v*.*.*, got ${JSON.stringify(tag)}`);
  }

  return {
    version,
    downloadUrl,
    sha256,
    tag,
  };
};
