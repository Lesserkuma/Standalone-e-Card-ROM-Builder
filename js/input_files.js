(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderInputFiles = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

  function createFileServices(patcher, dotcode) {
    const fileByteReads = new WeakMap();
    const fileFingerprints = new WeakMap();
    const scanImageDimensions = new WeakMap();
    const decodedDotcodesByFile = new WeakMap();

    function extensionOf(filename) {
      const match = /\.([^.]+)$/.exec(filename);
      return match ? `.${match[1].toLocaleLowerCase("en-US")}` : "";
    }

    function fileKind(file) {
      const extension = extensionOf(file.name);
      if (extension === ".gba") {
        return "ROM";
      }
      if (extension === ".sav") {
        return "SAV";
      }
      if (extension === ".raw") {
        return "RAW";
      }
      if (extension === ".zip") {
        return "ZIP";
      }
      if (extension === ".svg") {
        return "SVG";
      }
      return IMAGE_EXTENSIONS.has(extension) ? "SCAN" : "";
    }

    function formatBytes(value) {
      if (value < 1024) {
        return `${value} B`;
      }
      if (value < 1024 * 1024) {
        const digits = value < 10 * 1024 ? 1 : 0;
        return `${(value / 1024).toFixed(digits)} KiB`;
      }
      const digits = value < 10 * 1024 * 1024 ? 1 : 0;
      return `${(value / (1024 * 1024)).toFixed(digits)} MiB`;
    }

    function fileSizeError(file) {
      const kind = fileKind(file);
      if (kind === "ROM" && file.size !== patcher.constants.ROM_SIZE) {
        return `ROM size is ${formatBytes(file.size)}; expected exactly 8 MiB.`;
      }
      if (kind === "SAV" && file.size !== patcher.constants.SAVE_SIZE) {
        return `Save size is ${formatBytes(file.size)}; expected exactly 128 KiB.`;
      }
      if (
        kind === "RAW"
        && file.size !== patcher.constants.RAW_LONG_SIZE
        && file.size !== patcher.constants.RAW_SHORT_SIZE
      ) {
        return `${file.name} is not a supported long or short RAW strip.`;
      }
      if ((kind === "SCAN" || kind === "SVG") && file.size > 32 * 1024 * 1024) {
        return `${file.name} exceeds the 32 MiB image limit.`;
      }
      return "";
    }

    function readFileBytes(file) {
      let read = fileByteReads.get(file);
      if (!read) {
        read = (async () => {
          try {
            return new Uint8Array(await file.arrayBuffer());
          } catch (error) {
            fileByteReads.delete(file);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${file.name} could not be read: ${message}`);
          }
        })();
        fileByteReads.set(file, read);
      }
      return read;
    }

    function rememberScanImageDimensions(file, bytes) {
      const dimensions = dotcode.inspectEncodedImageDimensions(bytes, file.name);
      scanImageDimensions.set(file, dimensions);
      return dimensions;
    }

    async function scanImageDimensionsForFile(file) {
      const known = scanImageDimensions.get(file);
      if (known) {
        return known;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return rememberScanImageDimensions(file, bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file.name} could not be inspected safely: ${message}`);
      }
    }

    function fileFingerprint(file) {
      let fingerprint = fileFingerprints.get(file);
      if (!fingerprint) {
        fingerprint = (async () => {
          try {
            // Scan bytes can be large and are decoded from the File itself, so
            // avoid retaining their fingerprint buffer. Binary inputs are kept
            // for validation/building and must not be read a second time.
            const kind = fileKind(file);
            const bytes = kind === "SCAN"
              ? new Uint8Array(await file.arrayBuffer())
              : await readFileBytes(file);
            if (kind === "SCAN") {
              rememberScanImageDimensions(file, bytes);
            }
            const digest = await patcher.sha256(bytes);
            return `${kind}:${file.size}:${digest}`;
          } catch (error) {
            fileFingerprints.delete(file);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${file.name} could not be fingerprinted: ${message}`);
          }
        })();
        fileFingerprints.set(file, fingerprint);
      }
      return fingerprint;
    }

    function dotcodeEntriesMatch(left, right) {
      if (
        left.metadata.setId !== right.metadata.setId
        || left.metadata.cardIndex !== right.metadata.cardIndex
      ) {
        return false;
      }
      const leftApplicationData = patcher.decodeRawDotcode(left.bytes, left.name);
      const rightApplicationData = patcher.decodeRawDotcode(right.bytes, right.name);
      return patcher.bytesEqual(leftApplicationData, rightApplicationData);
    }

    function allDecodedDotcodesRemain(files, retainedEntries) {
      const originalEntries = files
        .map((file) => decodedDotcodesByFile.get(file))
        .find((entries) => entries && entries.length > 0);
      return !originalEntries || originalEntries.every((originalEntry) => (
        retainedEntries.some((retainedEntry) => dotcodeEntriesMatch(originalEntry, retainedEntry))
      ));
    }

    async function filterDuplicateFiles(files, state) {
      const selected = [state.romFile, ...state.sourceFiles].filter(Boolean);
      const selectedByFingerprint = new Map();
      const knownFingerprints = new Set();
      const retainedDotcodeEntries = state.sourceFiles.flatMap(
        (file) => state.preparedDotcodes.get(file) || [],
      );
      for (const file of selected) {
        if (!fileSizeError(file)) {
          const fingerprint = await fileFingerprint(file);
          const matchingFiles = selectedByFingerprint.get(fingerprint) || [];
          matchingFiles.push(file);
          selectedByFingerprint.set(fingerprint, matchingFiles);
        }
      }
      for (const [fingerprint, matchingFiles] of selectedByFingerprint) {
        const kind = fileKind(matchingFiles[0]);
        if (
          (kind === "RAW" || kind === "SCAN" || kind === "SVG")
          && !allDecodedDotcodesRemain(matchingFiles, retainedDotcodeEntries)
        ) {
          continue;
        }
        knownFingerprints.add(fingerprint);
      }

      const accepted = [];
      const ignored = [];
      for (const file of files) {
        if (!fileKind(file) || fileSizeError(file)) {
          accepted.push(file);
          continue;
        }
        const fingerprint = await fileFingerprint(file);
        if (knownFingerprints.has(fingerprint)) {
          ignored.push(file);
        } else {
          knownFingerprints.add(fingerprint);
          accepted.push(file);
        }
      }
      return { accepted, ignored };
    }

    function safeFilename(title, fallback) {
      const cleaned = title
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim()
        .slice(0, 120);
      return cleaned || fallback;
    }

    function dotcodeDataFilename(entry, extension) {
      const title = entry.metadata.embeddedTitle || "Untitled";
      const baseName = safeFilename(String(title), "dot-code scan");
      return (
        `${baseName} - dot code ${entry.metadata.cardIndex}`
        + ` of ${entry.metadata.cardCount}.${extension}`
      );
    }

    function rememberDecodedDotcodes(file, entries) {
      decodedDotcodesByFile.set(file, entries);
    }

    return Object.freeze({
      dotcodeDataFilename,
      dotcodeEntriesMatch,
      fileKind,
      fileSizeError,
      filterDuplicateFiles,
      formatBytes,
      readFileBytes,
      rememberDecodedDotcodes,
      safeFilename,
      scanImageDimensionsForFile,
    });
  }

  return Object.freeze({ createFileServices });
});
