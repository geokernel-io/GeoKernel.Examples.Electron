"use strict";

const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");
const { pipeline } = require("stream/promises");

// Lazy ZIP64 reader: never buffer a multi-GB SAM3 archive or an entire model file.
function extractZip(archive, staging, check, progress) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let failed = false;
      const fail = value => { if (!failed) { failed = true; zip.close(); reject(value); } };
      zip.on("error", fail);
      zip.on("end", () => { if (!failed) resolve(); });
      zip.on("entry", entry => {
        void (async () => {
          check();
          const target = path.resolve(staging, entry.fileName);
          const relative = path.relative(staging, target);
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep) ||
              entry.fileName.includes(":") || type === 0xa000) throw new Error("Unsafe ZIP entry.");
          progress(0, `Extracting ${entry.fileName}…`);
          if (entry.fileName.endsWith("/")) await fs.promises.mkdir(target, { recursive: true });
          else {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const input = await new Promise((yes, no) => zip.openReadStream(entry, (e, stream) => e ? no(e) : yes(stream)));
            let interrupted;
            const watch = setInterval(() => {
              try { check(); } catch (e) { interrupted = e; input.destroy(e); }
            }, 100);
            try {
              await pipeline(input, fs.createWriteStream(target, { flags: "wx" }));
              if (interrupted) throw interrupted;
            } finally { clearInterval(watch); }
          }
          check();
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

module.exports = { extractZip };
