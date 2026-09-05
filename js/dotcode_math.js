(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EReaderDotcodeMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function factorSymmetric(matrix) {
    const size = matrix.length;
    const factor = Array.from({ length: size }, () => new Float64Array(size));
    for (let row = 0; row < size; row++) {
      for (let column = 0; column <= row; column++) {
        let value = matrix[row][column];
        for (let index = 0; index < column; index++)
          value -= factor[row][index] * factor[column][index];
        if (!Number.isFinite(value) || (row === column && value <= 1e-10)) return null;
        factor[row][column] = row === column ? Math.sqrt(value) : value / factor[column][column];
      }
    }
    return factor;
  }

  function whiten(factor, values) {
    const result = new Float64Array(values.length);
    for (let row = 0; row < result.length; row++) {
      let value = values[row];
      for (let column = 0; column < row; column++) value -= factor[row][column] * result[column];
      result[row] = value / factor[row][row];
    }
    return result;
  }

  function solveFactored(factor, values) {
    const result = whiten(factor, values);
    for (let row = result.length - 1; row >= 0; row--) {
      for (let column = row + 1; column < result.length; column++)
        result[row] -= factor[column][row] * result[column];
      result[row] /= factor[row][row];
    }
    return result;
  }

  function dot(left, right) {
    let result = 0;
    for (let index = 0; index < left.length; index++) result += left[index] * right[index];
    return result;
  }

  return Object.freeze({ factorSymmetric, whiten, solveFactored, dot });
});
