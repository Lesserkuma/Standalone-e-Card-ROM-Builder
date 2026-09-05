"use strict";

importScripts(
  "processing_limits.js?3",
  "binary.js?3",
  "reed_solomon.js?3",
  "dotcode_layout.js?3",
  "raw_codec.js?3",
  "dotcode_math.js?3",
  "dotcode_sampling.js?5",
  "dotcode_recovery.js?5",
  "dotcode_scan.js?6",
);

self.onmessage = ({ data: pixels }) => {
  try {
    const qualities = [];
    const strips = self.EReaderDotcodeScan.decodeDotcodeImages(pixels, {
      onStripDecoded: (_raw, quality) => qualities.push(quality),
    });
    self.postMessage({ strips, qualities }, strips.map(raw => raw.buffer));
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
