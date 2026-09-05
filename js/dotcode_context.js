(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./dotcode_layout.js"), require("./dotcode_math.js"));
  else root.EReaderDotcodeContext = factory(root.EReaderDotcodeLayout, root.EReaderDotcodeMath);
})(typeof globalThis !== "undefined" ? globalThis : this, function (layout, math) {
  "use strict";

  const GRID_SIZE = 44;
  const INPUT_COUNT = 10;
  const SELF_INPUT = 5;
  const MIN_SYMBOL_MARGIN = 0.35;
  const NEIGHBORS = Object.freeze(
    Array.from({ length: 9 }, (_, index) =>
      Object.freeze([(index % 3) - 1, Math.floor(index / 3) - 1]),
    ),
  );
  const SYMBOL_BITS = Object.freeze(
    layout.MODULATION_TABLE.map((value) =>
      Object.freeze(Array.from({ length: 5 }, (_, bit) => (value >>> (4 - bit)) & 1)),
    ),
  );

  function createGrid(raw, block, fillerStart) {
    const grid = new Int8Array(GRID_SIZE * GRID_SIZE);
    const addresses = layout.addressSequence(
      raw[layout.BYTES_PER_BLOCK + 1],
      raw.length / layout.BYTES_PER_BLOCK + 1,
    );
    for (const [x, address] of [
      [4, addresses[block]],
      [39, addresses[block + 1]],
    ]) {
      grid[9 * GRID_SIZE + x] = 1;
      for (let bit = 0; bit < 16; bit++) grid[(33 - bit) * GRID_SIZE + x] = (address >>> bit) & 1;
    }
    for (let i = 0; i < 6; i++) {
      for (const x of [10 + i * 2, 23 + i * 2])
        grid[4 * GRID_SIZE + x] = grid[39 * GRID_SIZE + x] = 1;
    }
    for (let bit = 0; bit < layout.BITS_PER_BLOCK; bit++) {
      const [x, y] = layout.dataPosition(bit);
      const at = block * layout.BYTES_PER_BLOCK + Math.floor(bit / 10);
      const nibble = bit % 10 < 5 ? raw[at] >>> 4 : raw[at] & 15;
      grid[y * GRID_SIZE + x] = at < fillerStart ? SYMBOL_BITS[nibble][bit % 5] : -1;
    }
    return grid;
  }

  function contextLabels(grid, bit) {
    const [x, y] = layout.dataPosition(bit);
    const labels = new Float64Array(INPUT_COUNT);
    labels[0] = 1;
    for (let i = 0; i < NEIGHBORS.length; i++) {
      const [dx, dy] = NEIGHBORS[i];
      const label = grid[(y + dy) * GRID_SIZE + x + dx];
      if (label < 0) return null;
      labels[i + 1] = label;
    }
    return labels;
  }

  function fitContext(blocks) {
    const featureCount = blocks[0].features[0].length;
    const rows = [];
    for (const block of blocks) {
      for (let bit = 0; bit < block.expected.length; bit++) {
        const labels = contextLabels(block.grid, bit);
        if (labels) rows.push({ labels, features: block.features[bit] });
      }
    }
    if (rows.length < featureCount * 4) return null;
    const gram = Array.from({ length: INPUT_COUNT }, () => new Float64Array(INPUT_COUNT));
    const products = Array.from({ length: featureCount }, () => new Float64Array(INPUT_COUNT));
    for (const { labels, features } of rows) {
      for (let row = 0; row < INPUT_COUNT; row++) {
        for (let column = 0; column <= row; column++)
          gram[row][column] += labels[row] * labels[column];
        for (let feature = 0; feature < featureCount; feature++)
          products[feature][row] += labels[row] * features[feature];
      }
    }
    for (let row = 0; row < INPUT_COUNT; row++) {
      for (let column = 0; column < row; column++) gram[column][row] = gram[row][column];
      if (row > 0) gram[row][row] += rows.length * 0.001;
    }
    const gramFactor = math.factorSymmetric(gram);
    if (!gramFactor) return null;
    const regressions = products.map((product) => math.solveFactored(gramFactor, product));
    const contrast = -regressions[Math.floor(featureCount / 2)][SELF_INPUT];
    if (!Number.isFinite(contrast) || contrast < 10) return null;
    const covariance = Array.from({ length: featureCount }, () => new Float64Array(featureCount));
    for (const { labels, features } of rows) {
      const residual = Float64Array.from(
        features,
        (value, index) => value - math.dot(regressions[index], labels),
      );
      for (let row = 0; row < featureCount; row++) {
        for (let column = 0; column <= row; column++)
          covariance[row][column] += residual[row] * residual[column];
      }
    }
    let variance = 0;
    for (let row = 0; row < featureCount; row++) {
      for (let column = 0; column <= row; column++) {
        covariance[row][column] /= rows.length - INPUT_COUNT;
        covariance[column][row] = covariance[row][column];
      }
      variance += covariance[row][row];
    }
    const ridge = (variance / featureCount) * 0.05 + 0.01;
    for (let row = 0; row < featureCount; row++) covariance[row][row] += ridge;
    const factor = math.factorSymmetric(covariance);
    if (!factor) return null;
    const coefficients = Array.from({ length: INPUT_COUNT }, (_, input) =>
      math.whiten(
        factor,
        Float64Array.from(regressions, (row) => row[input]),
      ),
    );
    const separation = math.dot(coefficients[SELF_INPUT], coefficients[SELF_INPUT]);
    if (!Number.isFinite(separation) || separation <= 1e-6) return null;
    return {
      factor,
      coefficients,
      separation,
      brightness: math.whiten(factor, new Float64Array(featureCount).fill(contrast * 0.1)),
    };
  }

  function assessContextSymbol(model, block, offset, grid, uncertainGrid = null) {
    const positions = Array.from({ length: 5 }, (_, bit) => layout.dataPosition(offset + bit));
    const cells = positions.map(([x, y]) => y * GRID_SIZE + x);
    const linear = new Float64Array(5),
      brightness = new Float64Array(5);
    const cross = Array.from({ length: 5 }, () => new Float64Array(5));
    const influences = new Map();
    for (let cell = 0; cell < 5; cell++) {
      const [x, y] = positions[cell];
      const residual = math.whiten(model.factor, block.features[offset + cell]);
      for (let feature = 0; feature < residual.length; feature++)
        residual[feature] -= model.coefficients[0][feature];
      const effects = new Array(5).fill(null),
        uncertainNeighbors = [];
      for (let neighbor = 0; neighbor < NEIGHBORS.length; neighbor++) {
        const [dx, dy] = NEIGHBORS[neighbor];
        const position = (y + dy) * GRID_SIZE + x + dx;
        const target = cells.indexOf(position),
          coefficient = model.coefficients[neighbor + 1];
        if (target !== -1) {
          effects[target] = coefficient;
          continue;
        }
        const label = grid[position];
        if (label < 0) return null;
        for (let feature = 0; feature < residual.length; feature++)
          residual[feature] -= label * coefficient[feature];
        if (uncertainGrid?.[position]) {
          if (!influences.has(position))
            influences.set(position, { label, linear: new Float64Array(5) });
          uncertainNeighbors.push({ influence: influences.get(position), coefficient });
        }
      }
      for (let bit = 0; bit < 5; bit++) {
        const effect = effects[bit];
        if (!effect) continue;
        linear[bit] += math.dot(effect, effect) - 2 * math.dot(residual, effect);
        brightness[bit] -= 2 * math.dot(model.brightness, effect);
        for (let other = 0; other < bit; other++) {
          if (effects[other]) cross[bit][other] += 2 * math.dot(effect, effects[other]);
        }
        for (const { influence, coefficient } of uncertainNeighbors)
          influence.linear[bit] += 2 * math.dot(effect, coefficient);
      }
    }
    const costs = Float64Array.from(SYMBOL_BITS, (bits) => {
      let cost = math.dot(linear, bits);
      for (let bit = 0; bit < 5; bit++) {
        if (bits[bit])
          for (let other = 0; other < bit; other++) cost += cross[bit][other] * bits[other];
      }
      return cost;
    });
    let nibble = 0;
    for (let value = 1; value < costs.length; value++)
      if (costs[value] < costs[nibble]) nibble = value;
    let margin = Infinity,
      nominalMargin = Infinity;
    for (let value = 0; value < costs.length; value++) {
      if (value === nibble) continue;
      const difference = Float64Array.from(
        SYMBOL_BITS[value],
        (bit, index) => bit - SYMBOL_BITS[nibble][index],
      );
      const nominalDistance = costs[value] - costs[nibble];
      nominalMargin = Math.min(nominalMargin, nominalDistance);
      let distance = nominalDistance - Math.abs(math.dot(brightness, difference));
      // Bound every uncertain neighbor independently so ambiguous dots cannot confirm each other.
      for (const influence of influences.values()) {
        const change = math.dot(influence.linear, difference);
        distance += change >= 0 ? -influence.label * change : (1 - influence.label) * change;
      }
      margin = Math.min(margin, distance);
    }
    return {
      nibble,
      uncertain: nominalMargin < model.separation * MIN_SYMBOL_MARGIN || margin <= 0,
    };
  }

  function validatedContext(blocks, raw) {
    const heldOut = blocks[blocks.length - 1];
    const candidate = fitContext(blocks.slice(0, -1));
    if (!candidate) return null;
    let checked = 0;
    for (let offset = 0; offset < heldOut.expected.length; offset += 5) {
      const symbol = assessContextSymbol(candidate, heldOut, offset, heldOut.grid);
      if (!symbol) continue;
      const byte = raw[heldOut.block * layout.BYTES_PER_BLOCK + Math.floor(offset / 10)];
      const expected = offset % 10 === 0 ? byte >>> 4 : byte & 15;
      if (symbol.nibble !== expected) return null;
      checked++;
    }
    return checked >= 64 ? fitContext(blocks) : null;
  }

  function refineFiller(raw, sampledBlocks, fillerStart, uncertainSymbols) {
    const unchanged = { raw, uncertainSymbols, calibrated: false };
    if (uncertainSymbols.length === 0) return unchanged;
    const blocks = sampledBlocks.map((block) => ({
      ...block,
      grid: createGrid(raw, block.block, fillerStart),
    }));
    const model = validatedContext(blocks, raw);
    if (!model) return unchanged;
    for (const block of blocks) {
      block.grid = createGrid(raw, block.block, Infinity);
      block.uncertainGrid = new Uint8Array(GRID_SIZE * GRID_SIZE);
      for (const symbol of uncertainSymbols) {
        const offset = (symbol - block.block * layout.BYTES_PER_BLOCK * 2) * 5;
        if (offset < 0 || offset >= layout.BITS_PER_BLOCK) continue;
        for (let bit = 0; bit < 5; bit++) {
          const [x, y] = layout.dataPosition(offset + bit);
          block.uncertainGrid[y * GRID_SIZE + x] = 1;
        }
      }
    }
    const output = new Uint8Array(raw),
      remaining = [];
    for (const index of uncertainSymbols) {
      const at = Math.floor(index / 2),
        blockIndex = Math.floor(at / layout.BYTES_PER_BLOCK);
      const block = blocks[blockIndex - blocks[0].block];
      const offset = (index - blockIndex * layout.BYTES_PER_BLOCK * 2) * 5;
      const symbol = assessContextSymbol(model, block, offset, block.grid, block.uncertainGrid);
      const shift = index % 2 === 0 ? 4 : 0;
      if (!symbol || symbol.uncertain) {
        remaining.push(index);
        continue;
      }
      if (symbol.nibble !== ((raw[at] >>> shift) & 15)) remaining.push(index);
      output[at] = (output[at] & ~(15 << shift)) | (symbol.nibble << shift);
    }
    return { raw: output, uncertainSymbols: remaining, calibrated: true };
  }

  return Object.freeze({ refineFiller });
});
