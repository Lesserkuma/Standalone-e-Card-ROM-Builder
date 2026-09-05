(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./binary.js"));
  } else {
    root.EReaderReedSolomon = factory(root.EReaderBinary);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary) {
  "use strict";

  const GF_SIZE = 255;
  const GF_POLYNOMIAL = 0x187;
  const GF_FIRST_ROOT = 0x78;
  const RS_PARITY_SIZE = 16;

  class ReedSolomonError extends Error {
    constructor(message) {
      super(message);
      this.name = "ReedSolomonError";
    }
  }

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

  function gfMultiply(left, right) {
    if (left === 0 || right === 0) {
      return 0;
    }
    return GF_ALPHA[(GF_INDEX[left] + GF_INDEX[right]) % GF_SIZE];
  }

  function verifyStoredCodeword(codeword, paritySize = RS_PARITY_SIZE) {
    if (
      !Number.isInteger(paritySize) ||
      paritySize <= 0 ||
      codeword.length <= paritySize ||
      codeword.length > GF_SIZE
    ) {
      return false;
    }
    const polynomial = new Uint8Array(codeword.length);
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

  function correctStoredCodeword(input, paritySize = RS_PARITY_SIZE) {
    if (!(input instanceof Uint8Array)) {
      input = new Uint8Array(input);
    }
    if (
      !Number.isInteger(paritySize) ||
      paritySize <= 0 ||
      paritySize % 2 !== 0 ||
      input.length <= paritySize ||
      input.length > GF_SIZE
    ) {
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
          syndrome ^=
            GF_ALPHA[(received[index] + (GF_FIRST_ROOT + syndromeIndex - 1) * index) % GF_SIZE];
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
        throw new ReedSolomonError("Reed-Solomon verification failed after correction");
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
          discrepancy ^= GF_ALPHA[(GF_INDEX[lambda[index]] + syndromes[step - index]) % GF_SIZE];
        }
      }

      if (discrepancy === 0) {
        b = [0, ...b.slice(0, paritySize)];
        continue;
      }

      const nextLambda = new Array(paritySize + 1).fill(0);
      nextLambda[0] = lambda[0];
      for (let index = 1; index <= paritySize; index += 1) {
        const product =
          b[index - 1] === 0
            ? 0
            : GF_ALPHA[(GF_INDEX[discrepancy] + GF_INDEX[b[index - 1]]) % GF_SIZE];
        nextLambda[index] = lambda[index] ^ product;
      }

      if (2 * locatorDegree <= step - 1) {
        locatorDegree = step - locatorDegree;
        b = lambda.map((value) =>
          value === 0 ? 0 : GF_ALPHA[(GF_INDEX[value] - GF_INDEX[discrepancy] + GF_SIZE) % GF_SIZE],
        );
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
      throw new ReedSolomonError(
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
      throw new ReedSolomonError("Reed-Solomon codeword contains uncorrectable byte errors");
    }

    const omega = new Array(paritySize + 1).fill(0);
    for (let index = 0; index < paritySize; index += 1) {
      for (let term = 0; term <= Math.min(degree, index); term += 1) {
        if (syndromes[index + 1 - term] !== GF_SIZE && lambdaIndex[term] !== GF_SIZE) {
          omega[index] ^= GF_ALPHA[(syndromes[index + 1 - term] + lambdaIndex[term]) % GF_SIZE];
        }
      }
    }
    const lambdaDerivative = new Array(paritySize + 1).fill(0);
    for (let index = 0; index < errorCapacity; index += 1) {
      lambdaDerivative[index * 2] =
        lambdaIndex[index * 2 + 1] === GF_SIZE ? 0 : GF_ALPHA[lambdaIndex[index * 2 + 1]];
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
          denominator ^= GF_ALPHA[(GF_INDEX[lambdaDerivative[index]] + index * root) % GF_SIZE];
        }
      }
      if (denominator === 0) {
        throw new ReedSolomonError("Reed-Solomon correction produced a zero denominator");
      }
      const errorValue =
        numerator === 0
          ? 0
          : GF_ALPHA[
              (GF_INDEX[numerator] + GF_INDEX[rootAdjustment] + GF_SIZE - GF_INDEX[denominator]) %
                GF_SIZE
            ];
      received[location] ^= errorValue;
    }
    return finish(received, locations.length);
  }

  function dataSyndromes(codeword, paritySize) {
    const syndromes = [];
    for (let rootIndex = 0; rootIndex < paritySize; rootIndex += 1) {
      let syndrome = 0;
      for (let position = 0; position < codeword.length; position += 1) {
        const value = codeword[position];
        if (value !== 0) {
          syndrome ^= gfMultiply(
            value,
            GF_ALPHA[((GF_FIRST_ROOT + rootIndex) * position) % GF_SIZE],
          );
        }
      }
      syndromes.push(syndrome);
    }
    return syndromes;
  }

  const parityTransforms = new Map();

  function parityTransform(size) {
    let transform = parityTransforms.get(size);
    if (transform) return transform;
    const rows = Array.from({ length: size }, (_value, row) => {
      const values = new Uint8Array(size * 2);
      for (let column = 0; column < size; column += 1) {
        values[column] = GF_ALPHA[((GF_FIRST_ROOT + row) * (size - 1 - column)) % GF_SIZE];
      }
      values[size + row] = 1;
      return values;
    });
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      while (pivot < size && rows[pivot][column] === 0) pivot += 1;
      if (pivot === size) throw new ReedSolomonError("Singular Reed-Solomon parity system");
      [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
      const inverse = GF_ALPHA[(GF_SIZE - GF_INDEX[rows[column][column]]) % GF_SIZE];
      for (let index = 0; index < size * 2; index += 1) {
        rows[column][index] = gfMultiply(rows[column][index], inverse);
      }
      for (let row = 0; row < size; row += 1) {
        if (row === column) continue;
        const factor = rows[row][column];
        if (factor === 0) continue;
        for (let index = 0; index < size * 2; index += 1) {
          rows[row][index] ^= gfMultiply(factor, rows[column][index]);
        }
      }
    }
    transform = rows.map((row) => row.slice(size));
    parityTransforms.set(size, transform);
    return transform;
  }

  function encodeCodeword(dataInput, paritySize = RS_PARITY_SIZE) {
    const data = binary.asBytes(dataInput);
    if (
      !Number.isInteger(paritySize) ||
      data.length === 0 ||
      data.length + paritySize > GF_SIZE ||
      paritySize <= 0
    ) {
      throw new ReedSolomonError("Invalid Reed-Solomon data size");
    }
    const polynomial = new Uint8Array(data.length + paritySize);
    polynomial.fill(0xff, 0, paritySize);
    for (let index = 0; index < data.length; index += 1) {
      polynomial[paritySize + index] = data[data.length - 1 - index];
    }
    const syndromes = dataSyndromes(polynomial, paritySize);
    const transform = parityTransform(paritySize);
    const codeword = new Uint8Array(data.length + paritySize);
    codeword.set(data);
    for (let row = 0; row < paritySize; row += 1) {
      let value = 0;
      for (let column = 0; column < paritySize; column += 1) {
        value ^= gfMultiply(transform[row][column], syndromes[column]);
      }
      codeword[data.length + row] = value;
    }
    if (!verifyStoredCodeword(codeword, paritySize)) {
      throw new ReedSolomonError("Generated Reed-Solomon codeword failed verification");
    }
    return codeword;
  }

  return Object.freeze({
    ReedSolomonError,
    encodeCodeword,
    verifyStoredCodeword,
    correctStoredCodeword,
  });
});
