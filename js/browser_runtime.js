(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderBrowserRuntime = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_DOTCODE_IMAGE_PIXELS = 60_000_000;
  const MAX_CANVAS_DIMENSION = 32_767;

  function wireDropZone(zone, input, onFiles, isBusy) {
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    for (const eventName of ["dragenter", "dragover"]) {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (!isBusy()) {
          zone.dataset.drag = "true";
        }
      });
    }
    for (const eventName of ["dragleave", "dragend"]) {
      zone.addEventListener(eventName, () => {
        delete zone.dataset.drag;
      });
    }
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      delete zone.dataset.drag;
      if (!isBusy()) {
        void onFiles(event.dataTransfer.files);
      }
    });
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      void onFiles(files);
    });
  }

  async function loadImagePixels(file, inspectDimensions) {
    const encodedDimensions = await inspectDimensions(file);
    let bitmap;
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (_error) {
        bitmap = await createImageBitmap(file);
      }
    } else {
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        await image.decode();
        bitmap = image;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const pixelCount = bitmap.width * bitmap.height;
    if (
      !Number.isSafeInteger(pixelCount)
      || pixelCount <= 0
      || pixelCount > MAX_DOTCODE_IMAGE_PIXELS
      || bitmap.width > MAX_CANVAS_DIMENSION
      || bitmap.height > MAX_CANVAS_DIMENSION
    ) {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
      throw new Error(
        `The dot-code image dimensions (${bitmap.width} x ${bitmap.height}) are too large to decode safely.`,
      );
    }
    const decodedDimensionsMatch = (
      bitmap.width === encodedDimensions.width
      && bitmap.height === encodedDimensions.height
    ) || (
      bitmap.width === encodedDimensions.height
      && bitmap.height === encodedDimensions.width
    );
    if (!decodedDimensionsMatch) {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
      throw new Error(
        `The decoded dimensions of ${file.name} do not match its PNG/JPEG header.`,
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
      throw new Error("This browser cannot create a 2D canvas for the dot-code scan.");
    }
    try {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  }

  function downloadBytes(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return Object.freeze({ downloadBytes, loadImagePixels, wireDropZone });
});
