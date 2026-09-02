(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderDotcodeScan = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LONG_BLOCK_COUNT = 28;
  const SHORT_BLOCK_COUNT = 18;
  const BYTES_PER_BLOCK = 104;
  const BITS_PER_BLOCK = 1040;
  const RS_CODEWORD_SIZE = 64;
  const RS_DATA_SIZE = 48;
  const RS_PARITY_SIZE = RS_CODEWORD_SIZE - RS_DATA_SIZE;
  const GF_POLYNOMIAL = 0x187;
  const GF_FIRST_ROOT = 0x78;
  const GF_SIZE = 255;
  const MAX_IMAGE_PIXELS = 60_000_000;
  const MAX_IMAGE_DIMENSION = 32_767;
  const LOCATOR_MAX_DIMENSION = 1_600;
  const MAX_NORMALIZED_PIXELS = 20_000_000;
  // Twelve long strips contribute 696 real sync markers before any noise.
  const MAX_COARSE_MARKER_CANDIDATES = 768;
  const MAX_PRECISE_MARKER_CANDIDATES_PER_ROW = 80;
  const MAX_DIRECTIONAL_MARKER_ROWS_PER_LENGTH = 128;
  const MAX_MARKER_GRIDS_PER_THRESHOLD = 96;
  const MAX_LOCATED_MARKER_GRIDS = 64;
  const JPEG_START_OF_FRAME_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ]);

  // Each nibble is stored as a five-bit symbol (the e-Reader's 8-to-10
  // modulation). Keeping the encoder table here makes the soft decoder both
  // simpler and more tolerant than thresholding each dot independently.
  const MODULATION_TABLE = Object.freeze([
    0x00, 0x01, 0x02, 0x12,
    0x04, 0x05, 0x06, 0x16,
    0x08, 0x09, 0x0a, 0x14,
    0x0c, 0x0d, 0x11, 0x10,
  ]);

  const GF_ALPHA = new Uint8Array(GF_SIZE + 1);
  const GF_INDEX = new Uint8Array(GF_SIZE + 1);

  (function initializeGaloisField() {
    let mask = 1;
    GF_ALPHA[GF_SIZE] = 0;
    GF_INDEX[0] = GF_SIZE;
    for (let index = 0; index < GF_SIZE; index += 1) {
      GF_ALPHA[index] = mask;
      GF_INDEX[mask] = index;
      mask <<= 1;
      if (mask >= 0x100) {
        mask ^= GF_POLYNOMIAL;
      }
    }
  })();

  class DotcodeScanError extends Error {
    constructor(message) {
      super(message);
      this.name = "DotcodeScanError";
    }
  }

  function asByteArray(value, label) {
    if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError(`${label} must be a byte array`);
  }

  function checkedEncodedImageDimensions(width, height, format, label) {
    const pixelCount = width * height;
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || width > MAX_IMAGE_DIMENSION
      || height > MAX_IMAGE_DIMENSION
      || !Number.isSafeInteger(pixelCount)
      || pixelCount > MAX_IMAGE_PIXELS
    ) {
      throw new DotcodeScanError(
        `${label} dimensions (${width} x ${height}) are too large to decode safely`,
      );
    }
    return Object.freeze({ format, width, height });
  }

  function inspectEncodedImageDimensions(input, label = "Dotcode image") {
    const bytes = asByteArray(input, label);
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      bytes.length >= 24
      && pngSignature.every((value, index) => bytes[index] === value)
      && bytes[12] === 0x49
      && bytes[13] === 0x48
      && bytes[14] === 0x44
      && bytes[15] === 0x52
    ) {
      const width = (
        ((bytes[16] * 0x100 + bytes[17]) * 0x100 + bytes[18]) * 0x100
        + bytes[19]
      );
      const height = (
        ((bytes[20] * 0x100 + bytes[21]) * 0x100 + bytes[22]) * 0x100
        + bytes[23]
      );
      return checkedEncodedImageDimensions(width, height, "PNG", label);
    }

    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          throw new DotcodeScanError(`${label} has an invalid JPEG marker stream`);
        }
        while (offset < bytes.length && bytes[offset] === 0xff) {
          offset += 1;
        }
        if (offset >= bytes.length) {
          break;
        }
        const marker = bytes[offset];
        offset += 1;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) {
          break;
        }
        if (offset + 2 > bytes.length) {
          break;
        }
        const segmentLength = bytes[offset] * 0x100 + bytes[offset + 1];
        if (segmentLength < 2 || offset + segmentLength > bytes.length) {
          throw new DotcodeScanError(`${label} has an invalid JPEG segment length`);
        }
        if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
          if (segmentLength < 7) {
            throw new DotcodeScanError(`${label} has a truncated JPEG frame header`);
          }
          const height = bytes[offset + 3] * 0x100 + bytes[offset + 4];
          const width = bytes[offset + 5] * 0x100 + bytes[offset + 6];
          return checkedEncodedImageDimensions(width, height, "JPEG", label);
        }
        offset += segmentLength;
      }
      throw new DotcodeScanError(`${label} has no JPEG frame dimensions`);
    }
    throw new DotcodeScanError(`${label} is not a supported PNG or JPEG image`);
  }

  function asRgbaImage(image) {
    if (!image || typeof image !== "object") {
      throw new TypeError("Dotcode image must be an object with width, height, and RGBA data");
    }

    const width = image.width;
    const height = image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new TypeError("Dotcode image width and height must be positive integers");
    }
    if (Math.max(width, height) < 200 || Math.min(width, height) < 40) {
      throw new DotcodeScanError("The image is too small to contain an e-Reader dotcode strip");
    }

    const pixelCount = width * height;
    if (
      width > MAX_IMAGE_DIMENSION
      || height > MAX_IMAGE_DIMENSION
      || !Number.isSafeInteger(pixelCount)
      || pixelCount > MAX_IMAGE_PIXELS
    ) {
      throw new DotcodeScanError("The image dimensions are too large to decode safely");
    }

    const data = asByteArray(image.data, "Dotcode image data");
    const requiredLength = pixelCount * 4;
    if (data.byteLength !== requiredLength) {
      throw new TypeError(
        `Dotcode image needs exactly ${requiredLength} RGBA bytes, but ${data.byteLength} were supplied`,
      );
    }
    return { width, height, data };
  }

  function redAt(image, pixelIndex) {
    return image.redOnly ? image.data[pixelIndex] : image.data[pixelIndex * 4];
  }

  function redHistogram(image) {
    const histogram = new Uint32Array(256);
    const pixelCount = image.width * image.height;
    for (let index = 0; index < pixelCount; index += 1) {
      histogram[redAt(image, index)] += 1;
    }
    return histogram;
  }

  function histogramQuantile(histogram, pixelCount, fraction) {
    const target = Math.max(1, Math.floor(pixelCount * fraction));
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) {
        return value;
      }
    }
    return 255;
  }

  function locatorImage(image) {
    const maximumDimension = Math.max(image.width, image.height);
    if (maximumDimension <= LOCATOR_MAX_DIMENSION) {
      return { image, scaleX: 1, scaleY: 1 };
    }
    const previewScale = LOCATOR_MAX_DIMENSION / maximumDimension;
    const width = Math.max(1, Math.round(image.width * previewScale));
    const height = Math.max(1, Math.round(image.height * previewScale));
    const scaleX = image.width / width;
    const scaleY = image.height / height;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const sourceTop = Math.floor(y * scaleY);
      const sourceBottom = Math.min(image.height, Math.ceil((y + 1) * scaleY));
      for (let x = 0; x < width; x += 1) {
        const sourceLeft = Math.floor(x * scaleX);
        const sourceRight = Math.min(image.width, Math.ceil((x + 1) * scaleX));
        let sum = 0;
        let count = 0;
        for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
          for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
            sum += redAt(image, sourceY * image.width + sourceX);
            count += 1;
          }
        }
        data[y * width + x] = Math.round(sum / count);
      }
    }
    return {
      image: { width, height, data, redOnly: true },
      scaleX,
      scaleY,
    };
  }

  function* darkComponents(image, threshold) {
    const { width, height } = image;
    const pixelCount = width * height;
    const visited = new Uint8Array(pixelCount);
    let stack = new Int32Array(Math.min(pixelCount, 1024));
    let stackSize = 0;
    const pushPixel = (pixel) => {
      if (stackSize === stack.length) {
        const grown = new Int32Array(Math.min(pixelCount, stack.length * 2));
        grown.set(stack);
        stack = grown;
      }
      stack[stackSize] = pixel;
      stackSize += 1;
    };

    for (let seed = 0; seed < pixelCount; seed += 1) {
      if (visited[seed] || redAt(image, seed) > threshold) {
        continue;
      }

      stackSize = 0;
      pushPixel(seed);
      visited[seed] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;

      while (stackSize > 0) {
        stackSize -= 1;
        const pixel = stack[stackSize];
        const y = Math.floor(pixel / width);
        const x = pixel - y * width;

        area += 1;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);

        const yStart = Math.max(0, y - 1);
        const yEnd = Math.min(height - 1, y + 1);
        const xStart = Math.max(0, x - 1);
        const xEnd = Math.min(width - 1, x + 1);
        for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
          let neighbor = neighborY * width + xStart;
          for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1, neighbor += 1) {
            if (
              !visited[neighbor]
              && redAt(image, neighbor) <= threshold
            ) {
              visited[neighbor] = 1;
              pushPixel(neighbor);
            }
          }
        }
      }

      if (area < 4) {
        continue;
      }
      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      const aspect = componentWidth / componentHeight;
      const fill = area / (componentWidth * componentHeight);
      if (
        componentWidth >= 2
        && componentHeight >= 2
        && aspect >= 0.45
        && aspect <= 2.2
        && fill >= 0.2
        && componentWidth <= height * 0.3
        && componentHeight <= height * 0.3
      ) {
        yield {
          x: sumX / area,
          y: sumY / area,
          area,
          width: componentWidth,
          height: componentHeight,
        };
      }
    }
  }

  function compareMarkerComponentPriority(left, right) {
    return (
      left.area - right.area
      || Math.abs(right.width - right.height) - Math.abs(left.width - left.height)
      || right.y - left.y
      || right.x - left.x
    );
  }

  function retainMarkerComponent(heap, candidate, limit) {
    if (limit <= 0) {
      return;
    }
    if (heap.length < limit) {
      heap.push(candidate);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (compareMarkerComponentPriority(heap[index], heap[parent]) >= 0) {
          break;
        }
        [heap[index], heap[parent]] = [heap[parent], heap[index]];
        index = parent;
      }
      return;
    }
    if (compareMarkerComponentPriority(candidate, heap[0]) <= 0) {
      return;
    }
    heap[0] = candidate;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) {
        break;
      }
      const right = left + 1;
      let worse = left;
      if (
        right < heap.length
        && compareMarkerComponentPriority(heap[right], heap[left]) < 0
      ) {
        worse = right;
      }
      if (compareMarkerComponentPriority(heap[worse], heap[index]) >= 0) {
        break;
      }
      [heap[index], heap[worse]] = [heap[worse], heap[index]];
      index = worse;
    }
  }

  function retainedMarkerComponents(heap) {
    return heap.slice().sort((left, right) => (
      compareMarkerComponentPriority(right, left)
    ));
  }

  function lowerBoundByX(points, x) {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (points[middle].x < x) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  function assessMarkerRow(points, imageWidth, imageHeight) {
    if (points.length < 2) {
      return null;
    }
    const ordered = points.slice().sort((left, right) => left.x - right.x);
    const span = ordered[ordered.length - 1].x - ordered[0].x;
    if (span < imageWidth * 0.5) {
      return null;
    }

    const expectedSpacing = span / (ordered.length - 1);
    let score = 0;
    let largestSpacingError = 0;
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const yTolerance = Math.max(4, imageHeight * 0.045);

    for (let index = 0; index < ordered.length; index += 1) {
      const expectedX = first.x + expectedSpacing * index;
      const expectedY = first.y + ((last.y - first.y) * index) / (ordered.length - 1);
      const spacingError = Math.abs(ordered[index].x - expectedX) / expectedSpacing;
      const yError = Math.abs(ordered[index].y - expectedY) / yTolerance;
      largestSpacingError = Math.max(largestSpacingError, spacingError);
      score += spacingError * spacingError + yError * yError * 0.05;
    }
    if (largestSpacingError > 0.18) {
      return null;
    }
    return { points: ordered, score: score / ordered.length };
  }

  function findMarkerRow(candidates, count, imageWidth, imageHeight) {
    if (candidates.length < count) {
      return null;
    }

    // Sync markers are substantially larger than ordinary data dots. Keeping
    // a modest surplus handles dust and JPEG islands without making the
    // regular-grid search expensive.
    const pool = candidates
      .slice()
      .sort((left, right) => right.area - left.area)
      .slice(0, Math.min(candidates.length, count + 24))
      .sort((left, right) => left.x - right.x);

    const largestOnly = pool
      .slice()
      .sort((left, right) => right.area - left.area)
      .slice(0, count);
    const direct = assessMarkerRow(largestOnly, imageWidth, imageHeight);
    if (direct) {
      return direct;
    }

    let best = null;
    for (let firstIndex = 0; firstIndex < pool.length - 1; firstIndex += 1) {
      const first = pool[firstIndex];
      for (let lastIndex = firstIndex + 1; lastIndex < pool.length; lastIndex += 1) {
        const last = pool[lastIndex];
        const span = last.x - first.x;
        if (span < imageWidth * 0.5) {
          continue;
        }
        const spacing = span / (count - 1);
        const markerDiameter = (Math.sqrt(first.area) + Math.sqrt(last.area)) / 2;
        if (spacing < Math.max(4, markerDiameter * 3)) {
          continue;
        }

        const selected = [];
        let searchFailed = false;
        let fitScore = 0;
        for (let markerIndex = 0; markerIndex < count; markerIndex += 1) {
          const expectedX = first.x + spacing * markerIndex;
          const expectedY = first.y + ((last.y - first.y) * markerIndex) / (count - 1);
          const xTolerance = spacing * 0.2;
          const yTolerance = Math.max(imageHeight * 0.055, markerDiameter * 1.75);
          const begin = lowerBoundByX(pool, expectedX - xTolerance);
          let closest = null;
          let closestScore = Number.POSITIVE_INFINITY;
          for (let index = begin; index < pool.length; index += 1) {
            const point = pool[index];
            if (point.x > expectedX + xTolerance) {
              break;
            }
            const yDistance = Math.abs(point.y - expectedY);
            if (yDistance > yTolerance) {
              continue;
            }
            const pointScore =
              Math.abs(point.x - expectedX) / spacing
              + (yDistance / yTolerance) * 0.1;
            if (pointScore < closestScore) {
              closest = point;
              closestScore = pointScore;
            }
          }
          if (!closest || selected.includes(closest)) {
            searchFailed = true;
            break;
          }
          selected.push(closest);
          fitScore += closestScore;
        }
        if (searchFailed) {
          continue;
        }

        const assessed = assessMarkerRow(selected, imageWidth, imageHeight);
        if (!assessed) {
          continue;
        }
        assessed.score += fitScore / count;
        if (!best || assessed.score < best.score) {
          best = assessed;
        }
      }
    }
    return best;
  }

  function locateSyncMarkers(image) {
    // A low quantile isolates the large, dark sync disks even in a gray or
    // unevenly lit scan. Several passes cover both high-contrast exports and
    // softer JPEG scans.
    const quantiles = [0.03, 0.05, 0.02, 0.08, 0.0125];
    const histogram = redHistogram(image);
    const pixelCount = image.width * image.height;
    const thresholds = Array.from(new Set(quantiles.map((quantile) => (
      Math.min(190, histogramQuantile(histogram, pixelCount, quantile))
    ))));
    let best = null;
    let lastCounts = { top: 0, bottom: 0 };

    for (const threshold of thresholds) {
      const topHeap = [];
      const bottomHeap = [];
      let topCount = 0;
      let bottomCount = 0;
      for (const component of darkComponents(image, threshold)) {
        if (component.y < image.height * 0.45) {
          topCount += 1;
          retainMarkerComponent(
            topHeap,
            component,
            MAX_PRECISE_MARKER_CANDIDATES_PER_ROW,
          );
        }
        if (component.y > image.height * 0.55) {
          bottomCount += 1;
          retainMarkerComponent(
            bottomHeap,
            component,
            MAX_PRECISE_MARKER_CANDIDATES_PER_ROW,
          );
        }
      }
      const topCandidates = retainedMarkerComponents(topHeap);
      const bottomCandidates = retainedMarkerComponents(bottomHeap);
      lastCounts = { top: topCount, bottom: bottomCount };

      for (const markerCount of [29, 19]) {
        const top = findMarkerRow(topCandidates, markerCount, image.width, image.height);
        const bottom = findMarkerRow(bottomCandidates, markerCount, image.width, image.height);
        if (!top || !bottom) {
          continue;
        }
        const score = top.score + bottom.score;
        if (!best || score < best.score) {
          best = {
            blockCount: markerCount - 1,
            top: top.points,
            bottom: bottom.points,
            score,
          };
        }
      }
      if (best && best.score < 0.02) {
        break;
      }
    }

    if (!best) {
      throw new DotcodeScanError(
        `Could not find 19 or 29 aligned sync markers in both rows `
        + `(found ${lastCounts.top} upper and ${lastCounts.bottom} lower candidates)`,
      );
    }
    return best;
  }

  function markerRowSpacing(row) {
    const points = row.points;
    return Math.hypot(
      points[points.length - 1].x - points[0].x,
      points[points.length - 1].y - points[0].y,
    ) / (points.length - 1);
  }

  function lowerBoundNumbers(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle] < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  function upperBoundNumbers(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle] <= target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  function retainBestScored(items, candidate, limit) {
    if (items.length < limit) {
      items.push(candidate);
      return;
    }
    let worstIndex = 0;
    for (let index = 1; index < items.length; index += 1) {
      if (items[index].score > items[worstIndex].score) {
        worstIndex = index;
      }
    }
    if (candidate.score < items[worstIndex].score) {
      items[worstIndex] = candidate;
    }
  }

  function findDirectionalMarkerRows(candidates) {
    const rowsByLength = new Map([[19, []], [29, []]]);
    const signatureIndicesByLength = new Map([[19, new Map()], [29, new Map()]]);
    const indexed = candidates.map((point, id) => ({ id, point }));
    const orderedX = indexed.slice().sort((left, right) => left.point.x - right.point.x);
    const orderedY = indexed.slice().sort((left, right) => left.point.y - right.point.y);
    const coordinatesX = orderedX.map((item) => item.point.x);
    const coordinatesY = orderedY.map((item) => item.point.y);

    // Endpoint RANSAC operates only on the coarse preview. A major-axis index
    // keeps every predicted-marker lookup local and avoids a third full scan
    // through the component candidates.
    for (let firstId = 0; firstId < candidates.length - 1; firstId += 1) {
      const first = candidates[firstId];
      for (let secondId = firstId + 1; secondId < candidates.length; secondId += 1) {
        const second = candidates[secondId];
        let deltaX = second.x - first.x;
        let deltaY = second.y - first.y;
        const extent = Math.hypot(deltaX, deltaY);
        if (extent <= 0) {
          continue;
        }

        const useX = Math.abs(deltaX) >= Math.abs(deltaY);
        let startId = firstId;
        let endId = secondId;
        let start = first;
        let end = second;
        if ((useX && deltaX < 0) || (!useX && deltaY < 0)) {
          startId = secondId;
          endId = firstId;
          start = second;
          end = first;
          deltaX = -deltaX;
          deltaY = -deltaY;
        }
        const ordered = useX ? orderedX : orderedY;
        const majorCoordinates = useX ? coordinatesX : coordinatesY;

        for (const markerCount of [29, 19]) {
          const step = extent / (markerCount - 1);
          const endpointSize = Math.max(
            start.width,
            start.height,
            end.width,
            end.height,
          );
          if (step < Math.max(5, endpointSize * 2.8)) {
            continue;
          }

          const tolerance = Math.max(1.75, step * 0.13);
          const selected = [{ x: start.x, y: start.y }];
          const usedIds = new Set([startId, endId]);
          let fitScore = 0;
          for (let index = 1; index < markerCount - 1; index += 1) {
            const fraction = index / (markerCount - 1);
            const expectedX = start.x + deltaX * fraction;
            const expectedY = start.y + deltaY * fraction;
            const expectedMajor = useX ? expectedX : expectedY;
            const expectedSize = (
              Math.max(start.width, start.height) * (1 - fraction)
              + Math.max(end.width, end.height) * fraction
            );
            const begin = lowerBoundNumbers(majorCoordinates, expectedMajor - tolerance);
            const finish = upperBoundNumbers(majorCoordinates, expectedMajor + tolerance);
            let closest = null;
            for (let candidateIndex = begin; candidateIndex < finish; candidateIndex += 1) {
              const item = ordered[candidateIndex];
              if (usedIds.has(item.id)) {
                continue;
              }
              const distance = Math.hypot(
                item.point.x - expectedX,
                item.point.y - expectedY,
              );
              if (distance > tolerance) {
                continue;
              }
              const candidateSize = Math.max(item.point.width, item.point.height);
              const sizeRatio = candidateSize / Math.max(1, expectedSize);
              if (sizeRatio < 0.45 || sizeRatio > 2.2) {
                continue;
              }
              const score = (
                (distance / tolerance) ** 2
                + 0.08 * (sizeRatio - 1) ** 2
              );
              if (!closest || score < closest.score) {
                closest = { score, item };
              }
            }
            if (!closest) {
              break;
            }
            usedIds.add(closest.item.id);
            selected.push({ x: closest.item.point.x, y: closest.item.point.y });
            fitScore += closest.score;
          }
          if (selected.length !== markerCount - 1) {
            continue;
          }
          selected.push({ x: end.x, y: end.y });

          const steps = [];
          for (let index = 0; index < markerCount - 1; index += 1) {
            steps.push(Math.hypot(
              selected[index + 1].x - selected[index].x,
              selected[index + 1].y - selected[index].y,
            ));
          }
          const averageStep = steps.reduce((sum, value) => sum + value, 0) / steps.length;
          if (steps.some((value) => value / averageStep < 0.85 || value / averageStep > 1.15)) {
            continue;
          }
          const signature = selected
            .map((point) => `${Math.round(point.x * 2)},${Math.round(point.y * 2)}`)
            .join(";");
          const candidate = {
            points: selected,
            score: fitScore / markerCount,
            signature,
          };
          const rows = rowsByLength.get(markerCount);
          const signatureIndices = signatureIndicesByLength.get(markerCount);
          const existingIndex = signatureIndices.get(signature);
          if (existingIndex !== undefined) {
            if (candidate.score < rows[existingIndex].score) {
              rows[existingIndex] = candidate;
            }
            continue;
          }
          if (rows.length < MAX_DIRECTIONAL_MARKER_ROWS_PER_LENGTH) {
            signatureIndices.set(signature, rows.length);
            rows.push(candidate);
            continue;
          }
          let worstIndex = 0;
          for (let index = 1; index < rows.length; index += 1) {
            if (rows[index].score > rows[worstIndex].score) {
              worstIndex = index;
            }
          }
          if (candidate.score < rows[worstIndex].score) {
            signatureIndices.delete(rows[worstIndex].signature);
            rows[worstIndex] = candidate;
            signatureIndices.set(signature, worstIndex);
          }
        }
      }
    }
    // A 29-marker row also produces several mathematically regular 19-marker
    // windows. Suppress only exact point-corresponding subsets; mere bounding
    // box containment is deliberately insufficient because an unrelated long
    // graphic must not hide a genuine short dotcode.
    const rows = [...rowsByLength.get(29), ...rowsByLength.get(19)];
    return rows
      .filter((row) => (
        row.points.length !== 19
        || !rows.some((longer) => (
          longer.points.length === 29
          && row.points.every((point) => longer.points.some((other) => (
            Math.hypot(point.x - other.x, point.y - other.y) <= 1.5
          )))
        ))
      ))
      .sort((left, right) => left.score - right.score);
  }

  function assessDirectionalMarkerPair(first, second) {
    if (first.points.length !== second.points.length) {
      return null;
    }

    const rowGeometry = (points) => {
      const extent = {
        x: points[points.length - 1].x - points[0].x,
        y: points[points.length - 1].y - points[0].y,
      };
      const length = Math.hypot(extent.x, extent.y);
      return {
        extent,
        length,
        unit: length > 0
          ? { x: extent.x / length, y: extent.y / length }
          : { x: 0, y: 0 },
      };
    };

    const firstPoints = first.points;
    let secondPoints = second.points;
    const firstGeometry = rowGeometry(firstPoints);
    let secondGeometry = rowGeometry(secondPoints);
    if (firstGeometry.length <= 0 || secondGeometry.length <= 0) {
      return null;
    }

    const firstUnit = firstGeometry.unit;
    let directionAlignment = (
      firstUnit.x * secondGeometry.unit.x + firstUnit.y * secondGeometry.unit.y
    );
    // Around the 45-degree major-axis boundary, two physically parallel rows
    // can receive opposite canonical directions. Align their marker order
    // before testing parallelism and point-for-point offsets.
    if (directionAlignment < 0) {
      secondPoints = secondPoints.slice().reverse();
      secondGeometry = rowGeometry(secondPoints);
      directionAlignment = (
        firstUnit.x * secondGeometry.unit.x + firstUnit.y * secondGeometry.unit.y
      );
    }
    if (directionAlignment < 0.995) {
      return null;
    }

    const steps = [];
    for (const row of [firstPoints, secondPoints]) {
      for (let index = 0; index < row.length - 1; index += 1) {
        steps.push(Math.hypot(
          row[index + 1].x - row[index].x,
          row[index + 1].y - row[index].y,
        ));
      }
    }
    const averageStep = steps.reduce((sum, value) => sum + value, 0) / steps.length;
    if (steps.some((value) => value / averageStep < 0.85 || value / averageStep > 1.15)) {
      return null;
    }

    const along = [];
    const across = [];
    for (let index = 0; index < firstPoints.length; index += 1) {
      const offsetX = secondPoints[index].x - firstPoints[index].x;
      const offsetY = secondPoints[index].y - firstPoints[index].y;
      along.push(offsetX * firstUnit.x + offsetY * firstUnit.y);
      across.push(firstUnit.x * offsetY - firstUnit.y * offsetX);
    }
    if (along.some((value) => Math.abs(value) > averageStep * 0.15)) {
      return null;
    }
    if (across.some((value) => (
      Math.abs(value) / averageStep < 0.78
      || Math.abs(value) / averageStep > 1.22
    ))) {
      return null;
    }
    if (Math.min(...across) < 0 && Math.max(...across) > 0) {
      return null;
    }

    const firstRow = { points: firstPoints, score: first.score };
    const secondRow = { points: secondPoints, score: second.score };
    const [top, bottom] = across.reduce((sum, value) => sum + value, 0) > 0
      ? [firstRow, secondRow]
      : [secondRow, firstRow];
    const stepVariation = Math.max(...steps.map((value) => Math.abs(value / averageStep - 1)));
    const alongError = along.reduce((sum, value) => sum + Math.abs(value), 0)
      / (along.length * averageStep);
    const acrossError = across.reduce(
      (sum, value) => sum + Math.abs(Math.abs(value) / averageStep - 1),
      0,
    ) / across.length;
    return {
      blockCount: top.points.length - 1,
      top: top.points,
      bottom: bottom.points,
      score:
        top.score
        + bottom.score
        + (1 - directionAlignment)
        + stepVariation
        + alongError
        + acrossError,
    };
  }

  function sameMarkerGrid(left, right) {
    if (left.blockCount !== right.blockCount) {
      return false;
    }
    const leftSpacing = (
      markerRowSpacing({ points: left.top })
      + markerRowSpacing({ points: left.bottom })
    ) / 2;
    const rightSpacing = (
      markerRowSpacing({ points: right.top })
      + markerRowSpacing({ points: right.bottom })
    ) / 2;
    if (
      !Number.isFinite(leftSpacing)
      || !Number.isFinite(rightSpacing)
      || leftSpacing <= 0
      || rightSpacing <= 0
      || leftSpacing / rightSpacing < 0.8
      || leftSpacing / rightSpacing > 1.25
    ) {
      return false;
    }

    const spacing = (leftSpacing + rightSpacing) / 2;
    const matchesOrientation = (swapRows, reverseRows) => {
      let totalDistance = 0;
      let maximumDistance = 0;
      let pointCount = 0;
      const rightRows = swapRows
        ? [right.bottom, right.top]
        : [right.top, right.bottom];
      for (const [leftRow, rightRow] of [
        [left.top, rightRows[0]],
        [left.bottom, rightRows[1]],
      ]) {
        for (let index = 0; index < leftRow.length; index += 1) {
          const rightIndex = reverseRows ? rightRow.length - 1 - index : index;
          const distance = Math.hypot(
            leftRow[index].x - rightRow[rightIndex].x,
            leftRow[index].y - rightRow[rightIndex].y,
          ) / spacing;
          totalDistance += distance;
          maximumDistance = Math.max(maximumDistance, distance);
          pointCount += 1;
        }
      }
      return maximumDistance <= 0.45 && totalDistance / pointCount <= 0.2;
    };

    // Reversing a row direction also reverses its local normal, which can
    // swap the grid's top/bottom labels. Treat all equivalent orientations as
    // one geometry so threshold jitter near 45 degrees cannot duplicate it.
    return (
      matchesOrientation(false, false)
      || matchesOrientation(false, true)
      || matchesOrientation(true, false)
      || matchesOrientation(true, true)
    );
  }

  function deduplicateMarkerGrids(grids) {
    const unique = [];
    for (const grid of grids) {
      const existingIndex = unique.findIndex((existing) => sameMarkerGrid(existing, grid));
      if (existingIndex === -1) {
        unique.push(grid);
        continue;
      }
      const existing = unique[existingIndex];
      if (grid.score < existing.score) {
        unique[existingIndex] = grid;
      }
    }
    return unique;
  }

  function scaleMarkerGrid(grid, scaleX, scaleY) {
    if (scaleX === 1 && scaleY === 1) {
      return grid;
    }
    const scalePoints = (points) => points.map((point) => ({
      x: point.x * scaleX,
      y: point.y * scaleY,
    }));
    return {
      blockCount: grid.blockCount,
      top: scalePoints(grid.top),
      bottom: scalePoints(grid.bottom),
      score: grid.score,
    };
  }

  function sampleRedOrWhite(image, x, y) {
    if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) {
      return 255;
    }
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const xFraction = x - x0;
    const yFraction = y - y0;
    const topLeft = redAt(image, y0 * image.width + x0);
    const topRight = redAt(image, y0 * image.width + x1);
    const bottomLeft = redAt(image, y1 * image.width + x0);
    const bottomRight = redAt(image, y1 * image.width + x1);
    return Math.round(
      topLeft * (1 - xFraction) * (1 - yFraction)
      + topRight * xFraction * (1 - yFraction)
      + bottomLeft * (1 - xFraction) * yFraction
      + bottomRight * xFraction * yFraction,
    );
  }

  function cubicWeight(distance) {
    const value = Math.abs(distance);
    if (value < 1) {
      return ((1.5 * value - 2.5) * value) * value + 1;
    }
    if (value < 2) {
      return ((-0.5 * value + 2.5) * value - 4) * value + 2;
    }
    return 0;
  }

  function sampleRedBicubicOrWhite(image, x, y) {
    const baseX = Math.floor(x);
    const baseY = Math.floor(y);
    let weighted = 0;
    let totalWeight = 0;
    for (let sampleY = baseY - 1; sampleY <= baseY + 2; sampleY += 1) {
      const yWeight = cubicWeight(y - sampleY);
      for (let sampleX = baseX - 1; sampleX <= baseX + 2; sampleX += 1) {
        const weight = cubicWeight(x - sampleX) * yWeight;
        const value = (
          sampleX < 0
          || sampleY < 0
          || sampleX >= image.width
          || sampleY >= image.height
        )
          ? 255
          : redAt(image, sampleY * image.width + sampleX);
        weighted += value * weight;
        totalWeight += weight;
      }
    }
    return Math.round(Math.max(0, Math.min(255, weighted / totalWeight)));
  }

  function normalizeMarkerGrid(image, coarseGrid) {
    const directionX = (
      coarseGrid.top[coarseGrid.blockCount].x - coarseGrid.top[0].x
      + coarseGrid.bottom[coarseGrid.blockCount].x - coarseGrid.bottom[0].x
    ) / 2;
    const directionY = (
      coarseGrid.top[coarseGrid.blockCount].y - coarseGrid.top[0].y
      + coarseGrid.bottom[coarseGrid.blockCount].y - coarseGrid.bottom[0].y
    ) / 2;
    const directionLength = Math.hypot(directionX, directionY);
    if (directionLength <= 0) {
      throw new DotcodeScanError("The dot-code marker grid has no usable direction");
    }
    const unitX = directionX / directionLength;
    const unitY = directionY / directionLength;
    const normalX = -unitY;
    const normalY = unitX;

    const steps = [];
    for (const row of [coarseGrid.top, coarseGrid.bottom]) {
      for (let index = 0; index < row.length - 1; index += 1) {
        steps.push(Math.hypot(
          row[index + 1].x - row[index].x,
          row[index + 1].y - row[index].y,
        ));
      }
    }
    const averageStep = steps.reduce((sum, value) => sum + value, 0) / steps.length;
    const origin = coarseGrid.top[0];
    const points = [...coarseGrid.top, ...coarseGrid.bottom];
    const along = points.map((point) => (
      (point.x - origin.x) * unitX + (point.y - origin.y) * unitY
    ));
    const across = points.map((point) => (
      (point.x - origin.x) * normalX + (point.y - origin.y) * normalY
    ));
    const marginAlong = averageStep * 0.6;
    const marginAcross = averageStep * 0.4;
    const minimumAlong = Math.min(...along) - marginAlong;
    const minimumAcross = Math.min(...across) - marginAcross;
    const roiWidth = Math.max(
      35,
      Math.ceil(Math.max(...along) - Math.min(...along) + 2 * marginAlong),
    );
    const roiHeight = Math.max(
      35,
      Math.ceil(Math.max(...across) - Math.min(...across) + 2 * marginAcross),
    );
    const roiPixelCount = roiWidth * roiHeight;
    if (!Number.isSafeInteger(roiPixelCount) || roiPixelCount > MAX_NORMALIZED_PIXELS) {
      throw new DotcodeScanError("The normalized dot-code region is too large to decode safely");
    }

    const sourceOriginX = (
      origin.x + minimumAlong * unitX + minimumAcross * normalX
    );
    const sourceOriginY = (
      origin.y + minimumAlong * unitY + minimumAcross * normalY
    );
    const data = new Uint8Array(roiPixelCount);
    for (let y = 0; y < roiHeight; y += 1) {
      const rowSourceX = sourceOriginX + y * normalX;
      const rowSourceY = sourceOriginY + y * normalY;
      for (let x = 0; x < roiWidth; x += 1) {
        // Bicubic affine sampling keeps small dot centers distinct from paper
        // texture; bilinear sampling can turn a light cell into a false dot.
        data[y * roiWidth + x] = sampleRedBicubicOrWhite(
          image,
          rowSourceX + x * unitX,
          rowSourceY + x * unitY,
        );
      }
    }
    const normalizedImage = { width: roiWidth, height: roiHeight, data, redOnly: true };
    const toNormalizedPoints = (markerPoints) => markerPoints.map((point) => ({
      x: (point.x - origin.x) * unitX + (point.y - origin.y) * unitY - minimumAlong,
      y: (point.x - origin.x) * normalX + (point.y - origin.y) * normalY - minimumAcross,
    }));
    const coarseNormalized = {
      blockCount: coarseGrid.blockCount,
      top: toNormalizedPoints(coarseGrid.top),
      bottom: toNormalizedPoints(coarseGrid.bottom),
      score: coarseGrid.score,
    };

    try {
      const refined = locateSyncMarkers(normalizedImage);
      if (refined.blockCount !== coarseGrid.blockCount) {
        throw new DotcodeScanError("The precise marker count differs from the coarse grid");
      }
      return {
        image: normalizedImage,
        markers: refined,
        coarseFallback: coarseNormalized,
        center: markerGridCenter(coarseGrid),
      };
    } catch (error) {
      if (!(error instanceof DotcodeScanError)) {
        throw error;
      }
      return {
        image: normalizedImage,
        markers: coarseNormalized,
        center: markerGridCenter(coarseGrid),
      };
    }
  }

  function upscaleNormalizedCandidate(candidate) {
    const scale = 2;
    const width = candidate.image.width * scale;
    const height = candidate.image.height * scale;
    const pixelCount = width * height;
    if (
      width > MAX_IMAGE_DIMENSION
      || height > MAX_IMAGE_DIMENSION
      || !Number.isSafeInteger(pixelCount)
      || pixelCount > MAX_NORMALIZED_PIXELS
    ) {
      return null;
    }

    const data = new Uint8Array(pixelCount);
    for (let y = 0; y < height; y += 1) {
      const sourceY = (y + 0.5) / scale - 0.5;
      for (let x = 0; x < width; x += 1) {
        const sourceX = (x + 0.5) / scale - 0.5;
        data[y * width + x] = sampleRedOrWhite(candidate.image, sourceX, sourceY);
      }
    }
    const image = { width, height, data, redOnly: true };
    const scaleGrid = (grid) => {
      if (!grid) {
        return null;
      }
      const scalePoints = (points) => points.map((point) => ({
        x: (point.x + 0.5) * scale - 0.5,
        y: (point.y + 0.5) * scale - 0.5,
      }));
      return {
        blockCount: grid.blockCount,
        top: scalePoints(grid.top),
        bottom: scalePoints(grid.bottom),
        score: grid.score,
      };
    };
    const scaledMarkers = scaleGrid(candidate.markers);
    let markers = scaledMarkers;
    try {
      const refined = locateSyncMarkers(image);
      if (refined.blockCount === candidate.markers.blockCount) {
        markers = refined;
      }
    } catch (error) {
      if (!(error instanceof DotcodeScanError)) {
        throw error;
      }
    }
    return {
      image,
      markers,
      coarseFallback: markers === scaledMarkers
        ? scaleGrid(candidate.coarseFallback)
        : scaledMarkers,
      center: candidate.center,
    };
  }

  function fullScanMarkerThresholds(image) {
    const histogram = redHistogram(image);
    const pixelCount = image.width * image.height;
    const dark = histogramQuantile(histogram, pixelCount, 0.005);
    const light = histogramQuantile(histogram, pixelCount, 0.9);
    if (light - dark < 40) {
      throw new DotcodeScanError("The dot-code image has insufficient contrast");
    }
    return Array.from(new Set([0.28, 0.34, 0.22, 0.4, 0.16, 0.46].map(
      (ratio) => Math.round(dark + (light - dark) * ratio),
    )));
  }

  function markerGridCenter(grid) {
    const points = [...grid.top, ...grid.bottom];
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }

  function locateSyncMarkerGrids(image) {
    const grids = [];
    const thresholds = fullScanMarkerThresholds(image);
    const scale = Math.min(image.width, image.height);
    const minimumMarkerDimension = Math.max(3, Math.round(scale * 0.002));
    const maximumMarkerDimension = Math.min(80, Math.max(7, Math.round(scale * 0.03)));

    for (const threshold of thresholds) {
      const candidateHeap = [];
      for (const component of darkComponents(image, threshold)) {
        if (
          component.width >= minimumMarkerDimension
          && component.height >= minimumMarkerDimension
          && component.width <= maximumMarkerDimension
          && component.height <= maximumMarkerDimension
          && component.width / component.height >= 0.65
          && component.width / component.height <= 1.55
          && component.area / (component.width * component.height) >= 0.45
        ) {
          // Sync disks rank among the larger compact components. Retaining a
          // bounded heap avoids materializing and sorting every speckle while
          // also bounding the quadratic endpoint search.
          retainMarkerComponent(
            candidateHeap,
            component,
            MAX_COARSE_MARKER_CANDIDATES,
          );
        }
      }
      const candidates = retainedMarkerComponents(candidateHeap);

      const rows = findDirectionalMarkerRows(candidates);
      const thresholdGrids = [];
      for (let firstIndex = 0; firstIndex < rows.length - 1; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < rows.length; secondIndex += 1) {
          const assessed = assessDirectionalMarkerPair(rows[firstIndex], rows[secondIndex]);
          if (assessed) {
            retainBestScored(
              thresholdGrids,
              assessed,
              MAX_MARKER_GRIDS_PER_THRESHOLD,
            );
          }
        }
      }
      grids.push(...thresholdGrids);
    }

    const unique = deduplicateMarkerGrids(grids);
    if (unique.length > MAX_LOCATED_MARKER_GRIDS) {
      unique.sort((left, right) => left.score - right.score);
      unique.length = MAX_LOCATED_MARKER_GRIDS;
    }
    return unique.sort((left, right) => {
      const leftCenter = markerGridCenter(left);
      const rightCenter = markerGridCenter(right);
      return leftCenter.y - rightCenter.y || leftCenter.x - rightCenter.x;
    });
  }

  function gridPosition(top, bottom, block, logicalX, logicalY) {
    const horizontal = (logicalX - 4) / 35;
    const vertical = (logicalY - 4) / 35;
    const topX = top[block].x * (1 - horizontal) + top[block + 1].x * horizontal;
    const topY = top[block].y * (1 - horizontal) + top[block + 1].y * horizontal;
    const bottomX = bottom[block].x * (1 - horizontal) + bottom[block + 1].x * horizontal;
    const bottomY = bottom[block].y * (1 - horizontal) + bottom[block + 1].y * horizontal;
    return {
      x: topX * (1 - vertical) + bottomX * vertical,
      y: topY * (1 - vertical) + bottomY * vertical,
    };
  }

  function nearestRed(image, x, y) {
    const pixelX = Math.max(0, Math.min(image.width - 1, Math.round(x)));
    const pixelY = Math.max(0, Math.min(image.height - 1, Math.round(y)));
    return redAt(image, pixelY * image.width + pixelX);
  }

  function sampleDataDots(image, top, bottom, blockCount) {
    const samples = [];
    const allValues = [];
    for (let block = 0; block < blockCount; block += 1) {
      const blockValues = new Float64Array(BITS_PER_BLOCK);
      let offset = 0;
      const sampleRow = (logicalY, startX, count) => {
        for (let logicalX = startX; logicalX < startX + count; logicalX += 1) {
          const position = gridPosition(top, bottom, block, logicalX, logicalY);
          const value = nearestRed(image, position.x, position.y);
          blockValues[offset] = value;
          allValues.push(value);
          offset += 1;
        }
      };

      for (let y = 6; y < 9; y += 1) {
        sampleRow(y, 9, 26);
      }
      for (let y = 9; y < 35; y += 1) {
        sampleRow(y, 5, 34);
      }
      for (let y = 35; y < 38; y += 1) {
        sampleRow(y, 9, 26);
      }
      samples.push(blockValues);
    }
    return { blocks: samples, values: allValues };
  }

  function estimateDotLevels(values) {
    const ordered = values.slice().sort((left, right) => left - right);
    let dark = ordered[Math.floor(ordered.length * 0.2)];
    let light = ordered[Math.floor(ordered.length * 0.8)];

    for (let iteration = 0; iteration < 20; iteration += 1) {
      let darkSum = 0;
      let darkCount = 0;
      let lightSum = 0;
      let lightCount = 0;
      for (const value of values) {
        if (Math.abs(value - dark) <= Math.abs(value - light)) {
          darkSum += value;
          darkCount += 1;
        } else {
          lightSum += value;
          lightCount += 1;
        }
      }
      if (darkCount === 0 || lightCount === 0) {
        break;
      }
      const nextDark = darkSum / darkCount;
      const nextLight = lightSum / lightCount;
      if (Math.abs(nextDark - dark) + Math.abs(nextLight - light) < 0.01) {
        dark = nextDark;
        light = nextLight;
        break;
      }
      dark = nextDark;
      light = nextLight;
    }

    if (!Number.isFinite(dark) || !Number.isFinite(light) || light - dark < 18) {
      throw new DotcodeScanError("The dotcode scan does not have enough contrast to distinguish dots");
    }
    return { dark, light };
  }

  function estimateDemodulationThresholds(image) {
    const histogram = redHistogram(image);
    const pixelCount = image.width * image.height;
    const dark = histogramQuantile(histogram, pixelCount, 0.005);
    const light = histogramQuantile(histogram, pixelCount, 0.9);
    if (light <= dark) {
      return [];
    }
    return Array.from(new Set([0.52, 0.58, 0.64, 0.70, 0.76, 0.82].map(
      (ratio) => Math.round(dark + (light - dark) * ratio),
    )));
  }

  function thresholdDemodulate(blockSamples, threshold) {
    const raw = new Uint8Array(blockSamples.length * BYTES_PER_BLOCK);
    let rawOffset = 0;

    for (const samples of blockSamples) {
      const nibbles = new Uint8Array(208);
      for (let symbolIndex = 0; symbolIndex < nibbles.length; symbolIndex += 1) {
        const sampleOffset = symbolIndex * 5;
        let bestNibble = 0;
        let bestCost = Number.POSITIVE_INFINITY;
        for (let nibble = 0; nibble < MODULATION_TABLE.length; nibble += 1) {
          const symbol = MODULATION_TABLE[nibble];
          let cost = 0;
          for (let bit = 0; bit < 5; bit += 1) {
            const value = samples[sampleOffset + bit] - threshold;
            cost += (symbol >>> (4 - bit)) & 1 ? value : -value;
          }
          if (cost < bestCost) {
            bestCost = cost;
            bestNibble = nibble;
          }
        }
        nibbles[symbolIndex] = bestNibble;
      }
      for (let index = 0; index < nibbles.length; index += 2) {
        raw[rawOffset] = (nibbles[index] << 4) | nibbles[index + 1];
        rawOffset += 1;
      }
    }
    return raw;
  }

  function softDemodulate(blockSamples, dark, light) {
    const raw = new Uint8Array(blockSamples.length * BYTES_PER_BLOCK);
    let rawOffset = 0;

    for (const samples of blockSamples) {
      const nibbles = new Uint8Array(208);
      for (let symbolIndex = 0; symbolIndex < nibbles.length; symbolIndex += 1) {
        const sampleOffset = symbolIndex * 5;
        let bestNibble = 0;
        let bestCost = Number.POSITIVE_INFINITY;
        for (let nibble = 0; nibble < MODULATION_TABLE.length; nibble += 1) {
          const symbol = MODULATION_TABLE[nibble];
          let cost = 0;
          for (let bit = 0; bit < 5; bit += 1) {
            const expected = (symbol >>> (4 - bit)) & 1 ? dark : light;
            const difference = samples[sampleOffset + bit] - expected;
            cost += difference * difference;
          }
          if (cost < bestCost) {
            bestCost = cost;
            bestNibble = nibble;
          }
        }
        nibbles[symbolIndex] = bestNibble;
      }
      for (let index = 0; index < nibbles.length; index += 2) {
        raw[rawOffset] = (nibbles[index] << 4) | nibbles[index + 1];
        rawOffset += 1;
      }
    }
    return raw;
  }

  function gfMultiply(left, right) {
    if (left === 0 || right === 0) {
      return 0;
    }
    return GF_ALPHA[(GF_INDEX[left] + GF_INDEX[right]) % GF_SIZE];
  }

  function verifyStoredCodeword(codeword, paritySize) {
    const polynomial = new Uint8Array(GF_SIZE);
    for (let index = 0; index < codeword.length; index += 1) {
      polynomial[index] = codeword[codeword.length - 1 - index];
    }
    for (let index = 0; index < paritySize; index += 1) {
      polynomial[index] ^= 0xff;
    }

    for (let root = GF_FIRST_ROOT; root < GF_FIRST_ROOT + paritySize; root += 1) {
      let syndrome = 0;
      for (let index = 0; index < polynomial.length; index += 1) {
        const value = polynomial[index];
        if (value !== 0) {
          syndrome ^= gfMultiply(value, GF_ALPHA[(root * index) % GF_SIZE]);
        }
      }
      if (syndrome !== 0) {
        return false;
      }
    }
    return true;
  }

  // Corrects a shortened Reed-Solomon word in the byte order used by RAW
  // dotcodes: the 16 parity bytes are stored first, inverted, followed by 48
  // data bytes. Header words use the same 16-byte parity with eight data bytes.
  function correctStoredCodeword(input, paritySize = RS_PARITY_SIZE) {
    if (!(input instanceof Uint8Array)) {
      input = new Uint8Array(input);
    }
    if (paritySize <= 0 || paritySize % 2 !== 0 || input.length <= paritySize) {
      throw new TypeError("Invalid Reed-Solomon codeword dimensions");
    }

    let received = new Array(GF_SIZE).fill(0);
    for (let index = 0; index < input.length; index += 1) {
      received[index] = input[input.length - 1 - index];
    }
    for (let index = 0; index < paritySize; index += 1) {
      received[index] ^= 0xff;
    }
    for (let index = 0; index < received.length; index += 1) {
      received[index] = GF_INDEX[received[index]];
    }

    const syndromes = new Array(paritySize + 1).fill(0);
    let hasErrors = false;
    for (let syndromeIndex = 1; syndromeIndex <= paritySize; syndromeIndex += 1) {
      let syndrome = 0;
      for (let index = 0; index < GF_SIZE; index += 1) {
        if (received[index] !== GF_SIZE) {
          syndrome ^= GF_ALPHA[
            (received[index] + (GF_FIRST_ROOT + syndromeIndex - 1) * index) % GF_SIZE
          ];
        }
      }
      hasErrors ||= syndrome !== 0;
      syndromes[syndromeIndex] = GF_INDEX[syndrome];
    }

    const finish = (polynomial, corrected) => {
      const output = new Uint8Array(input.length);
      for (let index = 0; index < input.length; index += 1) {
        let value = polynomial[input.length - 1 - index];
        if (input.length - 1 - index < paritySize) {
          value ^= 0xff;
        }
        output[index] = value;
      }
      if (!verifyStoredCodeword(output, paritySize)) {
        throw new DotcodeScanError("Reed-Solomon verification failed after correction");
      }
      return { data: output, corrected };
    };

    if (!hasErrors) {
      received = received.map((value) => GF_ALPHA[value]);
      return finish(received, 0);
    }

    const errorCapacity = paritySize / 2;
    let lambda = new Array(paritySize + 1).fill(0);
    let b = new Array(paritySize + 1).fill(0);
    lambda[0] = 1;
    b[0] = 1;
    let locatorDegree = 0;

    for (let step = 1; step <= paritySize; step += 1) {
      let discrepancy = 0;
      for (let index = 0; index <= Math.min(step, paritySize); index += 1) {
        if (lambda[index] !== 0 && syndromes[step - index] !== GF_SIZE) {
          discrepancy ^= GF_ALPHA[
            (GF_INDEX[lambda[index]] + syndromes[step - index]) % GF_SIZE
          ];
        }
      }

      if (discrepancy === 0) {
        b = [0, ...b.slice(0, paritySize)];
        continue;
      }

      const nextLambda = new Array(paritySize + 1).fill(0);
      nextLambda[0] = lambda[0];
      for (let index = 1; index <= paritySize; index += 1) {
        const product = b[index - 1] === 0
          ? 0
          : GF_ALPHA[(GF_INDEX[discrepancy] + GF_INDEX[b[index - 1]]) % GF_SIZE];
        nextLambda[index] = lambda[index] ^ product;
      }

      if (2 * locatorDegree <= step - 1) {
        locatorDegree = step - locatorDegree;
        b = lambda.map((value) => (
          value === 0
            ? 0
            : GF_ALPHA[(GF_INDEX[value] - GF_INDEX[discrepancy] + GF_SIZE) % GF_SIZE]
        ));
      } else {
        b = [0, ...b.slice(0, paritySize)];
      }
      lambda = nextLambda;
    }

    const lambdaIndex = lambda.map((value) => GF_INDEX[value]);
    let degree = paritySize;
    while (degree > 0 && lambdaIndex[degree] === GF_SIZE) {
      degree -= 1;
    }
    if (degree === 0 || degree > errorCapacity) {
      throw new DotcodeScanError(
        `Reed-Solomon codeword has more than ${errorCapacity} correctable byte errors`,
      );
    }

    const registers = new Array(paritySize + 1).fill(0);
    for (let index = 1; index <= paritySize; index += 1) {
      registers[index] = lambdaIndex[index];
    }
    const roots = [];
    const locations = [];
    for (let index = 1; index <= GF_SIZE; index += 1) {
      let value = 1;
      for (let term = 1; term <= degree; term += 1) {
        if (registers[term] !== GF_SIZE) {
          registers[term] = (registers[term] + term) % GF_SIZE;
          value ^= GF_ALPHA[registers[term]];
        }
      }
      if (value === 0) {
        roots.push(index);
        locations.push(GF_SIZE - index);
      }
    }
    if (roots.length !== degree) {
      throw new DotcodeScanError("Reed-Solomon codeword contains uncorrectable byte errors");
    }

    const omega = new Array(paritySize + 1).fill(0);
    for (let index = 0; index < paritySize; index += 1) {
      for (let term = 0; term <= Math.min(degree, index); term += 1) {
        if (syndromes[index + 1 - term] !== GF_SIZE && lambdaIndex[term] !== GF_SIZE) {
          omega[index] ^= GF_ALPHA[
            (syndromes[index + 1 - term] + lambdaIndex[term]) % GF_SIZE
          ];
        }
      }
    }
    const lambdaDerivative = new Array(paritySize + 1).fill(0);
    for (let index = 0; index < errorCapacity; index += 1) {
      lambdaDerivative[index * 2] = lambdaIndex[index * 2 + 1] === GF_SIZE
        ? 0
        : GF_ALPHA[lambdaIndex[index * 2 + 1]];
    }
    let omegaDegree = paritySize;
    while (omegaDegree > 0 && omega[omegaDegree] === 0) {
      omegaDegree -= 1;
    }

    received = received.map((value) => GF_ALPHA[value]);
    for (let errorIndex = 0; errorIndex < roots.length; errorIndex += 1) {
      const root = roots[errorIndex];
      const location = locations[errorIndex];
      let numerator = 0;
      for (let index = 0; index <= omegaDegree; index += 1) {
        if (omega[index] !== 0) {
          numerator ^= GF_ALPHA[(GF_INDEX[omega[index]] + index * root) % GF_SIZE];
        }
      }
      const rootAdjustment = GF_ALPHA[(root * (GF_FIRST_ROOT - 1)) % GF_SIZE];
      let denominator = 0;
      for (let index = 0; index <= degree; index += 1) {
        if (lambdaDerivative[index] !== 0) {
          denominator ^= GF_ALPHA[
            (GF_INDEX[lambdaDerivative[index]] + index * root) % GF_SIZE
          ];
        }
      }
      if (denominator === 0) {
        throw new DotcodeScanError("Reed-Solomon correction produced a zero denominator");
      }
      const errorValue = numerator === 0
        ? 0
        : GF_ALPHA[
          (GF_INDEX[numerator]
            + GF_INDEX[rootAdjustment]
            + GF_SIZE
            - GF_INDEX[denominator]) % GF_SIZE
        ];
      received[location] ^= errorValue;
    }
    return finish(received, locations.length);
  }

  function correctAndValidateRaw(raw, blockCount) {
    const expectedSize = blockCount * BYTES_PER_BLOCK;
    if (raw.length !== expectedSize) {
      throw new DotcodeScanError(`Decoded RAW has ${raw.length} bytes; expected ${expectedSize}`);
    }

    const headerWord = new Uint8Array(24);
    for (let block = 0; block < 12; block += 1) {
      headerWord[block * 2] = raw[block * BYTES_PER_BLOCK];
      headerWord[block * 2 + 1] = raw[block * BYTES_PER_BLOCK + 1];
    }
    let correctedHeader;
    try {
      correctedHeader = correctStoredCodeword(headerWord, RS_PARITY_SIZE).data;
    } catch (error) {
      if (error instanceof DotcodeScanError) {
        throw new DotcodeScanError(`The scan does not contain a valid e-Reader header: ${error.message}`);
      }
      throw error;
    }

    const expectedType = blockCount === LONG_BLOCK_COUNT ? 0x03 : 0x02;
    const expectedStartAddress = blockCount === LONG_BLOCK_COUNT ? 0x19 : 0x01;
    const interleaveWidth = blockCount === LONG_BLOCK_COUNT ? 44 : 28;
    if (
      correctedHeader[0] !== 0x00
      || correctedHeader[1] !== expectedType
      || correctedHeader[2] !== 0x00
      || correctedHeader[3] !== expectedStartAddress
      || correctedHeader[4] !== 0x40
      || correctedHeader[5] !== 0x10
      || correctedHeader[6] !== 0x00
      || correctedHeader[7] !== interleaveWidth
    ) {
      throw new DotcodeScanError("The scan's corrected header is not a Nintendo e-Reader dotcode");
    }

    const correctedRaw = new Uint8Array(raw);
    for (let block = 0; block < blockCount; block += 1) {
      correctedRaw[block * BYTES_PER_BLOCK] = correctedHeader[(block * 2) % 24];
      correctedRaw[block * BYTES_PER_BLOCK + 1] = correctedHeader[(block * 2 + 1) % 24];
    }

    const interleaved = new Uint8Array(blockCount * (BYTES_PER_BLOCK - 2));
    for (let block = 0; block < blockCount; block += 1) {
      interleaved.set(
        correctedRaw.subarray(block * BYTES_PER_BLOCK + 2, (block + 1) * BYTES_PER_BLOCK),
        block * (BYTES_PER_BLOCK - 2),
      );
    }

    for (let column = 0; column < interleaveWidth; column += 1) {
      const codeword = new Uint8Array(RS_CODEWORD_SIZE);
      for (let index = 0; index < RS_CODEWORD_SIZE; index += 1) {
        codeword[index] = interleaved[index * interleaveWidth + column];
      }
      let corrected;
      try {
        corrected = correctStoredCodeword(codeword, RS_PARITY_SIZE).data;
      } catch (error) {
        if (error instanceof DotcodeScanError) {
          throw new DotcodeScanError(
            `Dotcode data column ${column + 1}/${interleaveWidth} is unreadable: ${error.message}`,
          );
        }
        throw error;
      }
      for (let index = 0; index < RS_CODEWORD_SIZE; index += 1) {
        interleaved[index * interleaveWidth + column] = corrected[index];
      }
    }

    for (let block = 0; block < blockCount; block += 1) {
      correctedRaw.set(
        interleaved.subarray(
          block * (BYTES_PER_BLOCK - 2),
          (block + 1) * (BYTES_PER_BLOCK - 2),
        ),
        block * BYTES_PER_BLOCK + 2,
      );
    }
    return correctedRaw;
  }

  function decodeOrientation(image, top, bottom, blockCount, thresholds) {
    const sampled = sampleDataDots(image, top, bottom, blockCount);

    // Printed cards often contain midtone paper texture near otherwise light
    // data cells. A bounded threshold sweep preserves those cells more
    // faithfully than a two-cluster midpoint, including the unprotected RAW
    // tail that Reed-Solomon cannot repair. Keep the soft decoder as a
    // compatibility fallback for unusually low-contrast scans.
    for (const threshold of thresholds) {
      try {
        return correctAndValidateRaw(
          thresholdDemodulate(sampled.blocks, threshold),
          blockCount,
        );
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
      }
    }

    const levels = estimateDotLevels(sampled.values);
    return correctAndValidateRaw(
      softDemodulate(sampled.blocks, levels.dark, levels.light),
      blockCount,
    );
  }

  function decodeMarkerGrid(image, markers) {
    const normalTop = markers.top;
    const normalBottom = markers.bottom;
    const reversedTop = normalTop.slice().reverse();
    const reversedBottom = normalBottom.slice().reverse();
    const orientations = [
      [normalTop, normalBottom],
      [reversedBottom, reversedTop],
      [reversedTop, reversedBottom],
      [normalBottom, normalTop],
    ];

    const errors = [];
    const thresholds = estimateDemodulationThresholds(image);
    for (const [top, bottom] of orientations) {
      try {
        return decodeOrientation(image, top, bottom, markers.blockCount, thresholds);
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
        errors.push(error.message);
      }
    }
    throw new DotcodeScanError(
      `The detected strip could not be decoded in any orientation. ${errors[0]}`,
    );
  }

  function decodeRawApplicationForDeduplication(raw) {
    let interleaveWidth;
    let applicationSize;
    if (raw.length === LONG_BLOCK_COUNT * BYTES_PER_BLOCK) {
      interleaveWidth = 44;
      applicationSize = 0x081c;
    } else if (raw.length === SHORT_BLOCK_COUNT * BYTES_PER_BLOCK) {
      interleaveWidth = 28;
      applicationSize = 0x051c;
    } else {
      throw new DotcodeScanError("The corrected dotcode has an unsupported RAW size");
    }

    // This is the same semantic conversion performed by patcher.js and
    // patch_ereader.py: discard physical row headers and RS parity, then
    // convert the universal 48-byte header to the application-card format.
    // Comparing these bytes avoids treating noisy, unused RAW tail bytes as
    // distinct strips when several geometric candidates found the same code.
    const decoded = new Uint8Array(RS_DATA_SIZE * interleaveWidth);
    let decodedOffset = 0;
    for (let column = 0; column < interleaveWidth; column += 1) {
      for (let row = 0; row < RS_DATA_SIZE; row += 1) {
        const interleavedIndex = row * interleaveWidth + column;
        const block = Math.floor(interleavedIndex / (BYTES_PER_BLOCK - 2));
        const offsetInBlock = interleavedIndex % (BYTES_PER_BLOCK - 2);
        decoded[decodedOffset] = raw[block * BYTES_PER_BLOCK + 2 + offsetInBlock];
        decodedOffset += 1;
      }
    }

    const nintendo = "NINTENDO";
    for (let index = 0; index < nintendo.length; index += 1) {
      if (decoded[0x1a + index] !== nintendo.charCodeAt(index)) {
        throw new DotcodeScanError("The corrected strip is not Nintendo e-Reader data");
      }
    }

    const application = new Uint8Array(applicationSize);
    application[0] = decoded[0x0d];
    application[1] = decoded[0x0c];
    application[2] = decoded[0x11];
    application[3] = decoded[0x10];
    application.set(decoded.subarray(0x26, 0x2e), 4);
    application.set(decoded.subarray(0x30), 12);

    const xorRange = (bytes, start, end) => {
      let result = 0;
      for (let index = start; index < Math.min(end, bytes.length); index += 1) {
        result ^= bytes[index];
      }
      return result;
    };
    if (xorRange(application, 0, 12) !== decoded[0x2e]) {
      throw new DotcodeScanError("The corrected strip failed its card-header checksum");
    }

    let checksumTotal = 0;
    for (let index = 12; index < application.length; index += 1) {
      checksumTotal += index & 1 ? application[index] : application[index] << 8;
    }
    const checksumOne = (~checksumTotal) & 0xffff;
    if (
      decoded[0x13] !== ((checksumOne >>> 8) & 0xff)
      || decoded[0x14] !== (checksumOne & 0xff)
    ) {
      throw new DotcodeScanError("The corrected strip failed its card-data checksum");
    }

    checksumTotal = 0;
    for (let offset = 0; offset < 0x2f; offset += 1) {
      checksumTotal += decoded[offset];
    }
    for (let offset = 12; offset < application.length; offset += 0x30) {
      checksumTotal += xorRange(application, offset, offset + 0x30);
    }
    if (((~checksumTotal) & 0xff) !== decoded[0x2f]) {
      throw new DotcodeScanError("The corrected strip failed its global checksum");
    }
    return application;
  }

  function sameBytes(left, right) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }
    return true;
  }

  function appendDecodedApplication(decoded, raw, center) {
    const application = decodeRawApplicationForDeduplication(raw);
    if (decoded.some((known) => sameBytes(known.application, application))) {
      return;
    }
    decoded.push({ raw, application, center });
  }

  function horizontalPreciseFallbackImage(image) {
    if (image.width >= image.height) {
      return image;
    }
    const width = image.height;
    const height = image.width;
    const data = new Uint8Array(width * height);
    for (let sourceY = 0; sourceY < image.height; sourceY += 1) {
      for (let sourceX = 0; sourceX < image.width; sourceX += 1) {
        data[sourceX * width + (width - 1 - sourceY)] = redAt(
          image,
          sourceY * image.width + sourceX,
        );
      }
    }
    return { width, height, data, redOnly: true };
  }

  /**
   * Decode every e-Reader dotcode strip found in one image. Marker rows are
   * discovered without an angle assumption, then each full-resolution region
   * is normalized to a horizontal strip for precise marker and data decoding.
   *
   * @param {{width: number, height: number, data: Uint8Array|Uint8ClampedArray}} image
   * @returns {Uint8Array[]} corrected RAW strips in top-to-bottom order
   */
  function decodeLocatedDotcodeImages(rgba) {
    const locator = locatorImage(rgba);
    const errors = [];
    let coarseGrids = [];
    try {
      coarseGrids = locateSyncMarkerGrids(locator.image)
        .map((grid) => scaleMarkerGrid(grid, locator.scaleX, locator.scaleY));
    } catch (error) {
      if (!(error instanceof DotcodeScanError)) {
        throw error;
      }
      errors.push(error.message);
    }
    const decoded = [];
    for (const grid of coarseGrids) {
      let candidate;
      try {
        candidate = normalizeMarkerGrid(rgba, grid);
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
        errors.push(error.message);
        continue;
      }
      let decodedCandidate = false;
      let resolutionCandidate = candidate;
      for (let resolutionAttempt = 0; resolutionAttempt < 2; resolutionAttempt += 1) {
        const attempts = resolutionCandidate.coarseFallback
          ? [resolutionCandidate.markers, resolutionCandidate.coarseFallback]
          : [resolutionCandidate.markers];
        for (const attempt of attempts) {
          try {
            appendDecodedApplication(
              decoded,
              decodeMarkerGrid(resolutionCandidate.image, attempt),
              resolutionCandidate.center,
            );
            decodedCandidate = true;
            break;
          } catch (error) {
            if (!(error instanceof DotcodeScanError)) {
              throw error;
            }
            errors.push(error.message);
          }
        }
        if (decodedCandidate) {
          break;
        }
        resolutionCandidate = resolutionAttempt === 0
          ? upscaleNormalizedCandidate(candidate)
          : null;
        if (!resolutionCandidate) {
          break;
        }
      }
    }

    // A tightly cropped strip still gets the multi-strip search above. If its
    // coarse locator lost a marker while downsampling, retain the established
    // precise single-strip locator as a compatibility fallback.
    const fallbackAspect = Math.max(rgba.width, rgba.height)
      / Math.min(rgba.width, rgba.height);
    if (decoded.length === 0 && fallbackAspect >= 8) {
      const preciseImage = horizontalPreciseFallbackImage(rgba);
      try {
        appendDecodedApplication(
          decoded,
          decodeMarkerGrid(preciseImage, locateSyncMarkers(preciseImage)),
          { x: rgba.width / 2, y: rgba.height / 2 },
        );
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
        errors.push(error.message);
      }
    }

    if (decoded.length === 0) {
      throw new DotcodeScanError(
        coarseGrids.length === 0
          ? (errors[0]
            || "Could not find any paired e-Reader synchronization-marker rows in the image")
          : `The detected strip${coarseGrids.length === 1 ? "" : "s"} could not be decoded. `
            + (errors[0] || "No valid Nintendo e-Reader data was found."),
      );
    }
    return decoded
      .sort((left, right) => (
        left.center.y - right.center.y || left.center.x - right.center.x
      ))
      .map((entry) => entry.raw);
  }

  function decodeDotcodeImages(image) {
    const rgba = asRgbaImage(image);
    return decodeLocatedDotcodeImages(rgba);
  }

  function correctReedSolomon64_48(codeword) {
    const bytes = asByteArray(codeword, "RS(64,48) codeword");
    if (bytes.length !== RS_CODEWORD_SIZE) {
      throw new TypeError(`RS(64,48) codeword must contain exactly ${RS_CODEWORD_SIZE} bytes`);
    }
    return correctStoredCodeword(bytes, RS_PARITY_SIZE).data;
  }

  return Object.freeze({
    DotcodeScanError,
    decodeDotcodeImages,
    inspectEncodedImageDimensions,
    correctReedSolomon64_48,
    LONG_RAW_SIZE: LONG_BLOCK_COUNT * BYTES_PER_BLOCK,
    SHORT_RAW_SIZE: SHORT_BLOCK_COUNT * BYTES_PER_BLOCK,
  });
});
