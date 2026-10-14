#!/usr/bin/env node
/**
 * Ensure the pinned bge-small-zh-v1.5 ONNX embedding model is available as an
 * offline application resource. Downloads and extraction are staged outside
 * the live resource root, then installed only after full contract validation.
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const {
  EMBEDDING_MODEL_CONTRACT,
  verifyEmbeddingModelArchive,
  verifyEmbeddingModelRoot,
} = require('../bin/packaged-resource-gate.cjs');

const destDir = path.join(pcRoot, 'resources', 'embedding-model');
const MODEL = EMBEDDING_MODEL_CONTRACT.id;
const modelDir = path.join(destDir, MODEL);
const tarballUrl = EMBEDDING_MODEL_CONTRACT.source;
// China-network fallback: storage.googleapis.com is commonly unreachable, so
// when the archive fetch fails we re-fetch the pinned files individually from
// a mirror (default: hf-mirror.com fronting the same Qdrant/bge-small-zh-v1.5
// repo the archive was published from). Every file is verified against the
// contract's per-file sha256/bytes, so a mirror cannot serve different bytes.
const MIRROR_FILES_BASE_DEFAULT = 'https://hf-mirror.com/Qdrant/bge-small-zh-v1.5/resolve/main';
const mirrorFilesBase = process.env.ORKAS_EMBEDDING_MODEL_MIRROR || MIRROR_FILES_BASE_DEFAULT;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = require('node:crypto').createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Fetch the pinned files one by one into `extractionRoot` from the mirror,
 *  verifying each against EMBEDDING_MODEL_CONTRACT.files. Throws on any
 *  mismatch — the caller falls through to the original error. */
async function downloadFilesFromMirror(extractionRoot, log) {
  const files = EMBEDDING_MODEL_CONTRACT.files;
  // The archive extracts to <root>/<model-id>/<file> (verifyResourceContract
  // requires exactly that layout), so the mirror path mirrors it.
  const modelRoot = path.join(extractionRoot, EMBEDDING_MODEL_CONTRACT.id);
  fs.mkdirSync(modelRoot, { recursive: true });
  for (const file of files) {
    const url = `${mirrorFilesBase}/${file.name}`;
    const outPath = path.join(modelRoot, file.name);
    log(`[embedding-model] mirror fetch ${file.name} from ${mirrorFilesBase}`);
    await download(url, outPath, { expectedBytes: file.bytes, model: EMBEDDING_MODEL_CONTRACT.id });
    const digest = await sha256File(outPath);
    if (digest !== file.sha256) {
      throw new Error(`mirror file ${file.name} sha256 mismatch: got ${digest}`);
    }
    const bytes = fs.statSync(outPath).size;
    if (bytes !== file.bytes) {
      throw new Error(`mirror file ${file.name} size mismatch: got ${bytes}`);
    }
    log(`[embedding-model] mirror file ${file.name} verified`);
  }
}

export const EMBEDDING_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;
export const EMBEDDING_DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;
export const EMBEDDING_DOWNLOAD_MAX_REDIRECTS = 5;
export const EMBEDDING_EXTRACT_TIMEOUT_MS = 5 * 60_000;

function firstError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

export function download(url, outPath, {
  expectedBytes = EMBEDDING_MODEL_CONTRACT.archive.bytes,
  get = https.get,
  inactivityTimeoutMs = EMBEDDING_DOWNLOAD_INACTIVITY_TIMEOUT_MS,
  maxRedirects = EMBEDDING_DOWNLOAD_MAX_REDIRECTS,
  model = MODEL,
  totalTimeoutMs = EMBEDDING_DOWNLOAD_TOTAL_TIMEOUT_MS,
  writeProgress = (text) => process.stdout.write(text),
} = {}) {
  return new Promise((resolve, reject) => {
    let activeFile = null;
    let activeRequest = null;
    let cleanupRequested = false;
    let settled = false;

    const removePartial = () => {
      try {
        fs.rmSync(outPath, { force: true });
      } catch {
        // A closing Windows file handle can delay removal. The close handler
        // retries, and the caller's staging-root cleanup is the final guard.
      }
    };
    const totalTimer = setTimeout(() => {
      fail(new Error(`download exceeded ${totalTimeoutMs}ms`));
    }, totalTimeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanupRequested = true;
      clearTimeout(totalTimer);
      resolve();
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      activeRequest?.destroy();
      activeFile?.destroy();
      removePartial();
      reject(firstError(reason));
    };

    const request = (currentUrl, redirectsRemaining) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(currentUrl);
      } catch {
        fail(new Error(`invalid embedding model URL: ${currentUrl}`));
        return;
      }

      const req = get(parsedUrl, {
        headers: { 'User-Agent': 'orkas-postinstall' },
      }, (res) => {
        if (
          res.statusCode
          && res.statusCode >= 300
          && res.statusCode < 400
          && res.headers.location
        ) {
          res.resume();
          if (redirectsRemaining <= 0) {
            fail(new Error(`too many redirects fetching ${url}`));
            return;
          }
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, parsedUrl).toString();
          } catch {
            fail(new Error(`invalid redirect fetching ${currentUrl}`));
            return;
          }
          request(nextUrl, redirectsRemaining - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`HTTP ${res.statusCode} fetching ${currentUrl}`));
          return;
        }

        const contentLength = Number(res.headers['content-length'] || 0);
        if (expectedBytes && contentLength && contentLength !== expectedBytes) {
          res.resume();
          fail(new Error(
            `unexpected embedding archive size: expected ${expectedBytes}, got ${contentLength}`,
          ));
          return;
        }

        let done = 0;
        let lastPct = -1;
        const file = fs.createWriteStream(outPath);
        activeFile = file;
        file.on('close', () => {
          if (cleanupRequested) removePartial();
        });
        file.on('error', fail);
        res.on('aborted', () => fail(new Error('embedding archive response aborted')));
        res.on('error', fail);
        res.on('data', (chunk) => {
          done += chunk.length;
          if (expectedBytes && done > expectedBytes) {
            fail(new Error(`embedding archive exceeded ${expectedBytes} bytes`));
            return;
          }
          if (contentLength) {
            const pct = Math.floor((done / contentLength) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              writeProgress(
                `\r  ${model}: ${pct}% (${(done / 1024 / 1024).toFixed(1)}MB / ${(contentLength / 1024 / 1024).toFixed(1)}MB)`,
              );
              lastPct = pct;
            }
          }
        });
        file.on('finish', () => {
          file.close((err) => {
            if (err) {
              fail(err);
              return;
            }
            activeFile = null;
            if (expectedBytes && done !== expectedBytes) {
              fail(new Error(
                `incomplete embedding archive: expected ${expectedBytes}, got ${done}`,
              ));
              return;
            }
            writeProgress('\n');
            finish();
          });
        });
        res.pipe(file);
      });
      activeRequest = req;
      req.on('error', fail);
      req.setTimeout(inactivityTimeoutMs, () => {
        req.destroy(new Error(`download inactive for ${inactivityTimeoutMs}ms`));
      });
    };

    request(url, maxRedirects);
  });
}

export async function extract(tgzPath, dstDir, {
  spawn = null,
  timeoutMs = EMBEDDING_EXTRACT_TIMEOUT_MS,
} = {}) {
  // Use the npm tar package when installed; retain a bounded system fallback
  // for dependency-bootstrap environments.
  try {
    const tar = require('tar');
    await tar.x({ file: tgzPath, cwd: dstDir });
    return;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }

  const spawnSync = spawn || (await import('node:child_process')).spawnSync;
  const result = spawnSync(
    'tar',
    ['-xzf', tgzPath, '-C', dstDir],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`tar extraction failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
}

function modelPresent(root, verifyRoot) {
  try {
    verifyRoot(root);
    return true;
  } catch {
    return false;
  }
}

export function installVerifiedModel({
  destination,
  extractionRoot,
  model = MODEL,
  verifyRoot = verifyEmbeddingModelRoot,
}) {
  const stagedModel = path.join(extractionRoot, model);
  const targetModel = path.join(destination, model);
  const backupRoot = fs.mkdtempSync(
    path.join(path.dirname(destination), '.embedding-model-backup-'),
  );
  const backupModel = path.join(backupRoot, model);
  let hadTarget = false;
  let installed = false;

  try {
    if (fs.existsSync(targetModel)) {
      fs.renameSync(targetModel, backupModel);
      hadTarget = true;
    }
    fs.renameSync(stagedModel, targetModel);
    installed = true;
    verifyRoot(destination);
  } catch (err) {
    if (installed) fs.rmSync(targetModel, { recursive: true, force: true });
    if (hadTarget && !fs.existsSync(targetModel)) {
      fs.renameSync(backupModel, targetModel);
    }
    throw err;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

export async function ensureEmbeddingModel({
  destination = destDir,
  downloadArchive = download,
  extractArchive = extract,
  log = console.log,
  model = MODEL,
  sourceUrl = tarballUrl,
  verifyArchive = verifyEmbeddingModelArchive,
  verifyRoot = verifyEmbeddingModelRoot,
  warn = console.warn,
} = {}) {
  fs.mkdirSync(destination, { recursive: true });
  // Clean the only legacy partial location used by older versions. New
  // downloads are isolated in a unique staging root.
  fs.rmSync(path.join(destination, `${model}.tar.gz`), { force: true });

  if (modelPresent(destination, verifyRoot)) {
    log(`[embedding-model] already present at ${path.join(destination, model)}, skipping`);
    return;
  }

  const stagingRoot = fs.mkdtempSync(
    path.join(path.dirname(destination), '.embedding-model-fetch-'),
  );
  const archivePath = path.join(stagingRoot, `${model}.tar.gz`);
  const extractionRoot = path.join(stagingRoot, 'extract');
  fs.mkdirSync(extractionRoot);

  log(`[embedding-model] fetching ${sourceUrl}`);
  try {
    try {
      await downloadArchive(sourceUrl, archivePath);
      verifyArchive(archivePath);
      await extractArchive(archivePath, extractionRoot);
    } catch (archiveErr) {
      // Mirror fallback keeps the same trust contract: per-file sha256/bytes
      // are pinned, so mirror bytes must equal archive bytes.
      log(`[embedding-model] archive fetch failed (${firstError(archiveErr).message}); trying file mirror`);
      await downloadFilesFromMirror(extractionRoot, log);
    }
    verifyRoot(extractionRoot);

    // A concurrent installer may have completed while this process fetched.
    // Prefer that already verified payload instead of replacing it.
    if (!modelPresent(destination, verifyRoot)) {
      installVerifiedModel({
        destination,
        extractionRoot,
        model,
        verifyRoot,
      });
    }
    verifyRoot(destination);
    log(`[embedding-model] ready at ${path.join(destination, model)}`);
  } catch (err) {
    if (modelPresent(destination, verifyRoot)) {
      warn(`[embedding-model] fetch failed but files are present: ${firstError(err).message}`);
      return;
    }
    throw err;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureEmbeddingModel().catch((err) => {
    console.error(`[embedding-model] ERROR: ${firstError(err).message}`);
    process.exitCode = 1;
  });
}
