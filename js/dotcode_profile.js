(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./dotcode_math.js"));
  else root.EReaderDotcodeProfile = factory(root.EReaderDotcodeMath);
})(typeof globalThis !== "undefined" ? globalThis : this, function (math) {
  "use strict";

  function fitDotProfile(observations) {
    const featureCount = observations[0]?.features.length;
    if (!featureCount) return null;
    const means = [new Float64Array(featureCount), new Float64Array(featureCount)];
    const counts = [0, 0];
    for (const { features, label } of observations) {
      counts[label]++;
      for (let index = 0; index < featureCount; index++) means[label][index] += features[index];
    }
    if (counts.some((count) => count < featureCount * 2)) return null;
    for (let label = 0; label < 2; label++) {
      for (let index = 0; index < featureCount; index++) means[label][index] /= counts[label];
    }
    const covariance = Array.from({ length: featureCount }, () => new Float64Array(featureCount));
    for (const { features, label } of observations) {
      for (let row = 0; row < featureCount; row++) {
        const difference = features[row] - means[label][row];
        for (let column = 0; column <= row; column++) {
          covariance[row][column] += difference * (features[column] - means[label][column]);
        }
      }
    }
    let variance = 0;
    for (let row = 0; row < featureCount; row++) {
      for (let column = 0; column <= row; column++) {
        covariance[row][column] /= observations.length - 2;
        covariance[column][row] = covariance[row][column];
      }
      variance += covariance[row][row];
    }
    // Regularization keeps correlated pixel samples from amplifying noise.
    const ridge = (variance / featureCount) * 0.05 + 0.01;
    for (let index = 0; index < featureCount; index++) covariance[index][index] += ridge;
    const difference = Array.from(means[0], (value, index) => value - means[1][index]);
    const factor = math.factorSymmetric(covariance);
    if (!factor) return null;
    const weights = math.solveFactored(factor, difference);
    let gap = 0,
      midpoint = 0;
    for (let index = 0; index < featureCount; index++) {
      gap += weights[index] * difference[index];
      midpoint += (weights[index] * (means[0][index] + means[1][index])) / 2;
    }
    if (!Number.isFinite(gap) || gap <= 1e-6) return null;
    return { weights, gap, midpoint };
  }

  function profileIntensity(model, features) {
    let value = -model.midpoint;
    for (let index = 0; index < model.weights.length; index++)
      value += features[index] * model.weights[index];
    // Keep the dark/light separation on a bounded intensity scale, not a probability scale.
    return Math.round(Math.max(0, Math.min(255, 127.5 + (value * 120) / model.gap)));
  }

  return Object.freeze({ fitDotProfile, profileIntensity });
});
