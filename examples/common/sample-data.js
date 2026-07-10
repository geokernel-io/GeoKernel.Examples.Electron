"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");

const AdmZip = require("adm-zip");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SAMPLE_DATA_ROOT = process.env.GEOKERNEL_EXAMPLES_DATA_DIR
  ? path.resolve(process.env.GEOKERNEL_EXAMPLES_DATA_DIR)
  : path.join(PROJECT_ROOT, "outputs", "data");

function exists(filePath) {
  return fs.existsSync(filePath);
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function downloadFile(url, destination, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;

      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        const redirectedUrl = new URL(location, url).toString();
        downloadFile(redirectedUrl, destination, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${statusCode}: ${url}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
      file.on("error", reject);
    });

    request.on("error", reject);
  });
}

async function ensureArchive(url, archiveName) {
  const downloadsDir = path.join(SAMPLE_DATA_ROOT, "downloads");
  await ensureDir(downloadsDir);

  const archivePath = path.join(downloadsDir, archiveName);
  if (exists(archivePath)) {
    return archivePath;
  }

  const tempPath = `${archivePath}.download`;
  await fs.promises.rm(tempPath, { force: true });
  console.log(`Downloading sample data: ${archiveName}`);
  await downloadFile(url, tempPath);
  await fs.promises.rename(tempPath, archivePath);
  return archivePath;
}

async function extractArchive(archivePath, extractDir) {
  await ensureDir(extractDir);
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(extractDir, true);
}

async function ensureSampleFile(url, archiveName, extractName, targetRelativePath) {
  const extractDir = path.join(SAMPLE_DATA_ROOT, extractName);
  const targetPath = path.join(extractDir, targetRelativePath);
  if (exists(targetPath)) {
    return targetPath;
  }

  const archivePath = await ensureArchive(url, archiveName);
  console.log(`Extracting sample data: ${archiveName}`);
  await extractArchive(archivePath, extractDir);

  if (!exists(targetPath)) {
    throw new Error(`Sample data file was not found after extract: ${targetPath}`);
  }

  return targetPath;
}

module.exports = {
  ensureSampleFile,
  SAMPLE_DATA_ROOT,
};
