(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./dotcode_layout.js"),
      require("./dotcode_profile.js"),
      require("./dotcode_context.js"),
    );
  } else {
    root.EReaderDotcodeSampling = factory(
      root.EReaderDotcodeLayout,
      root.EReaderDotcodeProfile,
      root.EReaderDotcodeContext,
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (layout, profiles, context) {
  "use strict";

  const { BYTES_PER_BLOCK, BITS_PER_BLOCK, MODULATION_TABLE } = layout;
  const MAX_CALIBRATION_ERROR_RATE = 0.025;
  const MIN_SYMBOL_MARGIN = 0.35;
  const PROFILE_OFFSETS = Object.freeze([-0.65, -0.325, 0, 0.325, 0.65]);
  const PROFILE_FEATURE_COUNT = PROFILE_OFFSETS.length ** 2;
  const PROFILE_CENTER = Math.floor(PROFILE_FEATURE_COUNT / 2);

  function redAt(image, x, y) {
    const index = y * image.width + x;
    return image.data[image.redOnly ? index : index * 4];
  }

  function sampleRed(image, x, y) {
    if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return 255;
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, image.width - 1),
      y1 = Math.min(y0 + 1, image.height - 1);
    const dx = x - x0,
      dy = y - y0;
    return (
      (redAt(image, x0, y0) * (1 - dx) + redAt(image, x1, y0) * dx) * (1 - dy) +
      (redAt(image, x0, y1) * (1 - dx) + redAt(image, x1, y1) * dx) * dy
    );
  }

  function quantile(histogram, count, fraction) {
    const rank = Math.floor((count - 1) * fraction);
    let cumulative = 0;
    for (let value = 0; value < 256; value++) {
      cumulative += histogram[value];
      if (cumulative > rank) return value;
    }
    return 255;
  }

  function refineMarker(image, point, pitch) {
    const radius = Math.max(3, Math.round(pitch * 3.25));
    let center = point;
    for (let iteration = 0; iteration < 4; iteration++) {
      const centerX = Math.round(center.x),
        centerY = Math.round(center.y);
      const left = Math.max(0, centerX - radius),
        right = Math.min(image.width - 1, centerX + radius);
      const top = Math.max(0, centerY - radius),
        bottom = Math.min(image.height - 1, centerY + radius);
      const histogram = new Uint32Array(256);
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) histogram[redAt(image, x, y)]++;
      const count = (right - left + 1) * (bottom - top + 1);
      const dark = quantile(histogram, count, 0.1),
        light = quantile(histogram, count, 0.9);
      if (light - dark < 10) return point;
      const threshold = (dark + light) / 2;
      let sumX = 0,
        sumY = 0,
        weight = 0;
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) {
          const darkness = Math.max(0, threshold - redAt(image, x, y));
          sumX += (x - centerX) * darkness;
          sumY += (y - centerY) * darkness;
          weight += darkness;
        }
      if (weight === 0) return point;
      center = { x: centerX + sumX / weight, y: centerY + sumY / weight };
      if (Math.round(center.x) === centerX && Math.round(center.y) === centerY) break;
    }
    return Math.hypot(center.x - point.x, center.y - point.y) <= pitch ? center : point;
  }

  function gridPosition(top, bottom, block, x, y) {
    const u = (x - 4) / 35,
      v = (y - 4) / 35;
    // Local deltas reduce interpolation rounding differences after integer translations.
    const origin = top[block];
    return {
      x:
        origin.x +
        (top[block + 1].x - origin.x) * u * (1 - v) +
        (bottom[block].x - origin.x) * (1 - u) * v +
        (bottom[block + 1].x - origin.x) * u * v,
      y:
        origin.y +
        (top[block + 1].y - origin.y) * u * (1 - v) +
        (bottom[block].y - origin.y) * (1 - u) * v +
        (bottom[block + 1].y - origin.y) * u * v,
    };
  }

  function blockGeometry(top, bottom, block) {
    const x = new Float64Array(BITS_PER_BLOCK),
      y = new Float64Array(BITS_PER_BLOCK);
    for (let i = 0; i < BITS_PER_BLOCK; i++) {
      const [logicalX, logicalY] = layout.dataPosition(i);
      const position = gridPosition(top, bottom, block, logicalX, logicalY);
      x[i] = position.x;
      y[i] = position.y;
    }
    return {
      x,
      y,
      xx: (top[block + 1].x - top[block].x + bottom[block + 1].x - bottom[block].x) / 70,
      xy: (top[block + 1].y - top[block].y + bottom[block + 1].y - bottom[block].y) / 70,
      yx: (bottom[block].x - top[block].x + bottom[block + 1].x - top[block + 1].x) / 70,
      yy: (bottom[block].y - top[block].y + bottom[block + 1].y - top[block + 1].y) / 70,
    };
  }

  function sampleDot(image, geometry, index, dx, dy) {
    const x = geometry.x[index] + dx * geometry.xx + dy * geometry.yx;
    const y = geometry.y[index] + dx * geometry.xy + dy * geometry.yy;
    const radius = 0.2;
    return (
      (sampleRed(image, x, y) * 2 +
        sampleRed(image, x + radius * geometry.xx, y + radius * geometry.xy) +
        sampleRed(image, x - radius * geometry.xx, y - radius * geometry.xy) +
        sampleRed(image, x + radius * geometry.yx, y + radius * geometry.yy) +
        sampleRed(image, x - radius * geometry.yx, y - radius * geometry.yy)) /
      6
    );
  }

  function expectedDots(raw, block, count) {
    const dots = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const byte = raw[block * BYTES_PER_BLOCK + Math.floor(i / 10)];
      const nibble = i % 10 < 5 ? byte >>> 4 : byte & 15;
      dots[i] = (MODULATION_TABLE[nibble] >>> (4 - (i % 5))) & 1;
    }
    return dots;
  }

  function fitOffset(image, geometry, expected) {
    let dx = 0,
      dy = 0;
    const score = (offsetX, offsetY) => {
      let dark = 0,
        darkCount = 0,
        light = 0,
        lightCount = 0;
      for (let i = 0; i < expected.length; i += 3) {
        const value = sampleDot(image, geometry, i, offsetX, offsetY);
        if (expected[i]) {
          dark += value;
          darkCount++;
        } else {
          light += value;
          lightCount++;
        }
      }
      return darkCount && lightCount ? light / lightCount - dark / darkCount : -Infinity;
    };
    let bestScore = score(dx, dy);
    for (const step of [0.25, 0.125, 0.0625]) {
      let nextX = dx,
        nextY = dy;
      for (const shiftY of [-step, 0, step])
        for (const shiftX of [-step, 0, step]) {
          const value = score(dx + shiftX, dy + shiftY);
          if (value > bestScore + 0.000001) {
            bestScore = value;
            nextX = dx + shiftX;
            nextY = dy + shiftY;
          }
        }
      dx = nextX;
      dy = nextY;
    }
    return { dx, dy };
  }

  function calibrate(samples, expected) {
    const dark = new Uint32Array(256),
      light = new Uint32Array(256);
    let darkCount = 0,
      darkSum = 0,
      lightSum = 0;
    for (let i = 0; i < expected.length; i++) {
      const value = samples[i];
      if (expected[i]) {
        dark[value]++;
        darkCount++;
        darkSum += value;
      } else {
        light[value]++;
        lightSum += value;
      }
    }
    const contrast = lightSum / (expected.length - darkCount) - darkSum / darkCount;
    let errors = darkCount,
      best = errors;
    const costs = new Uint16Array(257);
    costs[0] = errors;
    for (let value = 0; value < 256; value++) {
      errors += light[value] - dark[value];
      costs[value + 1] = errors;
      best = Math.min(best, errors);
    }
    let low = 0,
      high = -1;
    for (let start = 0; start < costs.length; start++) {
      if (costs[start] !== best) continue;
      let end = start;
      while (end + 1 < costs.length && costs[end + 1] === best) end++;
      if (end - start > high - low) {
        low = start;
        high = end;
      }
      start = end;
    }
    let lower = low,
      upper = high;
    const tolerance = Math.max(1, Math.floor(expected.length * 0.002));
    while (lower > 0 && costs[lower - 1] <= best + tolerance) lower--;
    while (upper < 256 && costs[upper + 1] <= best + tolerance) upper++;
    const threshold = (low + high - 1) / 2;
    // A wide, empty intensity gap does not make clear black/white cells ambiguous.
    const variation = contrast * 0.1;
    return {
      threshold,
      lower: Math.max(lower - 0.5, threshold - variation),
      upper: Math.min(upper - 0.5, threshold + variation),
      contrast,
      errors: best,
      count: expected.length,
    };
  }

  function readSymbol(samples, offset, threshold) {
    let nibble = 0,
      best = Infinity,
      second = Infinity;
    for (let value = 0; value < 16; value++) {
      const symbol = MODULATION_TABLE[value];
      let cost = 0;
      for (let bit = 0; bit < 5; bit++) {
        const delta = samples[offset + bit] - threshold;
        cost += (symbol >>> (4 - bit)) & 1 ? delta : -delta;
      }
      if (cost < best) {
        second = best;
        best = cost;
        nibble = value;
      } else if (cost < second) second = cost;
    }
    return { nibble, margin: second - best };
  }

  function sampleBlock(image, top, bottom, raw, block, fillerStart) {
    const count = Math.min(BITS_PER_BLOCK, (fillerStart - block * BYTES_PER_BLOCK) * 10);
    const expected = expectedDots(raw, block, count);
    const geometry = blockGeometry(top, bottom, block);
    const offset = fitOffset(image, geometry, expected);
    const features = [],
      observations = [];
    const centers = new Uint8Array(BITS_PER_BLOCK);
    for (let index = 0; index < BITS_PER_BLOCK; index++) {
      const patch = new Float64Array(PROFILE_FEATURE_COUNT);
      let at = 0;
      for (const y of PROFILE_OFFSETS)
        for (const x of PROFILE_OFFSETS) {
          patch[at++] = sampleDot(image, geometry, index, offset.dx + x, offset.dy + y);
        }
      features.push(patch);
      centers[index] = Math.round(patch[PROFILE_CENTER]);
      if (index < count)
        observations.push({
          features: patch,
          label: expected[index],
          validation: Math.floor(index / 10) % 5 === 0,
        });
    }
    return { block, features, observations, expected, centers };
  }

  function usableLevels(levels) {
    return (
      Number.isFinite(levels.contrast) &&
      levels.contrast >= 10 &&
      levels.errors / levels.count <= MAX_CALIBRATION_ERROR_RATE
    );
  }

  function validatedProfile(observations) {
    const training = observations.filter((row) => !row.validation);
    const heldOut = observations.filter((row) => row.validation);
    const candidate = profiles.fitDotProfile(training);
    if (!candidate) return null;
    const labels = Uint8Array.from(training, (row) => row.label);
    const profileLevels = calibrate(
      Uint8Array.from(training, (row) => profiles.profileIntensity(candidate, row.features)),
      labels,
    );
    const centerLevels = calibrate(
      Uint8Array.from(training, (row) => Math.round(row.features[PROFILE_CENTER])),
      labels,
    );
    if (!usableLevels(profileLevels) || !usableLevels(centerLevels)) return null;
    let profileErrors = 0,
      centerErrors = 0;
    for (const row of heldOut) {
      const expectedDark = Boolean(row.label);
      const profileDark =
        profiles.profileIntensity(candidate, row.features) < profileLevels.threshold;
      const centerDark = Math.round(row.features[PROFILE_CENTER]) < centerLevels.threshold;
      if (profileDark !== expectedDark) profileErrors++;
      if (centerDark !== expectedDark) centerErrors++;
    }
    if (profileErrors > centerErrors || profileErrors / heldOut.length > MAX_CALIBRATION_ERROR_RATE)
      return null;
    return profiles.fitDotProfile(observations);
  }

  function assessSymbol(samples, offset, levels) {
    const symbol = readSymbol(samples, offset, levels.threshold);
    return {
      nibble: symbol.nibble,
      margin: symbol.margin / levels.contrast,
      uncertain:
        symbol.margin < levels.contrast * MIN_SYMBOL_MARGIN ||
        readSymbol(samples, offset, levels.lower).nibble !== symbol.nibble ||
        readSymbol(samples, offset, levels.upper).nibble !== symbol.nibble,
    };
  }

  function combineSymbols(center, profile) {
    if (!profile) return center;
    if (center.nibble === profile.nibble) {
      return { nibble: profile.nibble, uncertain: center.uncertain && profile.uncertain };
    }
    return {
      nibble: profile.margin > center.margin ? profile.nibble : center.nibble,
      uncertain: true,
    };
  }

  function refineRaw(image, top, bottom, raw) {
    const blockCount = raw.length / BYTES_PER_BLOCK;
    const pitch =
      Math.hypot(top[blockCount].x - top[0].x, top[blockCount].y - top[0].y) / (blockCount * 35);
    const columns = blockCount === layout.LONG_BLOCK_COUNT ? 44 : 28;
    const fillerStart = columns * 64 + blockCount * 2;
    const firstBlock = Math.floor(fillerStart / BYTES_PER_BLOCK);
    const trainingStart = Math.max(0, firstBlock - 2);
    top = top.slice();
    bottom = bottom.slice();
    for (let marker = trainingStart; marker <= blockCount; marker++) {
      top[marker] = refineMarker(image, top[marker], pitch);
      bottom[marker] = refineMarker(image, bottom[marker], pitch);
    }
    const sampledBlocks = [],
      observations = [];
    for (let block = trainingStart; block < blockCount; block++) {
      const sampled = sampleBlock(image, top, bottom, raw, block, fillerStart);
      sampledBlocks.push(sampled);
      observations.push(...sampled.observations);
    }
    const profile = validatedProfile(observations);
    const output = new Uint8Array(raw),
      uncertainSymbols = [];
    let calibrated = true,
      profileCalibrated = Boolean(profile);
    // Only ECC-protected bits supply labels; filler never trains the reader.
    for (let block = firstBlock; block < blockCount; block++) {
      const sampled = sampledBlocks[block - trainingStart];
      const { expected, centers: samples } = sampled;
      const levels = calibrate(samples, expected);
      const profileSamples = profile
        ? Uint8Array.from(sampled.features, (features) =>
            profiles.profileIntensity(profile, features),
          )
        : null;
      const profileLevels = profileSamples ? calibrate(profileSamples, expected) : null;
      const usableProfile = profileLevels && usableLevels(profileLevels);
      profileCalibrated &&= Boolean(usableProfile);
      const usable = usableLevels(levels);
      calibrated &&= usable;
      for (
        let byte = Math.max(0, fillerStart - block * BYTES_PER_BLOCK);
        byte < BYTES_PER_BLOCK;
        byte++
      ) {
        const at = block * BYTES_PER_BLOCK + byte;
        if (!usable) {
          uncertainSymbols.push(at * 2, at * 2 + 1);
          continue;
        }
        let value = 0;
        for (let half = 0; half < 2; half++) {
          const sampleOffset = byte * 10 + half * 5;
          const symbol = combineSymbols(
            assessSymbol(samples, sampleOffset, levels),
            usableProfile ? assessSymbol(profileSamples, sampleOffset, profileLevels) : null,
          );
          value = (value << 4) | symbol.nibble;
          if (symbol.uncertain) uncertainSymbols.push(at * 2 + half);
        }
        output[at] = value;
      }
    }
    const refinement =
      calibrated && profileCalibrated
        ? context.refineFiller(output, sampledBlocks, fillerStart, uncertainSymbols)
        : { raw: output, uncertainSymbols, calibrated: false };
    const uncertain = [
      ...new Set(refinement.uncertainSymbols.map((symbol) => Math.floor(symbol / 2))),
    ];
    return {
      raw: refinement.raw,
      quality: Object.freeze({
        fillerStart,
        fillerBytes: raw.length - fillerStart,
        calibrated,
        profileCalibrated,
        contextCalibrated: refinement.calibrated,
        uncertainFillerBytes: Object.freeze(uncertain),
      }),
    };
  }

  return Object.freeze({ refineRaw });
});
