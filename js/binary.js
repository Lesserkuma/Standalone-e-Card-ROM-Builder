(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EReaderBinary = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class BinaryError extends Error {
    constructor(message) {
      super(message);
      this.name = "BinaryError";
    }
  }

  const CRC32_TABLE = new Uint32Array(256);
  for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC32_TABLE[index] = value >>> 0;
  }

  function asBytes(value, label = "data") {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError(`${label} must be an ArrayBuffer or Uint8Array`);
  }

  function bytesFromHex(value) {
    const compact = value.replace(/\s+/g, "");
    if (compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
      throw new TypeError("Invalid hexadecimal byte string");
    }
    const result = new Uint8Array(compact.length / 2);
    for (let index = 0; index < result.length; index += 1) {
      result[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    }
    return result;
  }

  function asciiBytes(value) {
    const result = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code > 0x7f) {
        throw new TypeError("ASCII byte string contains a non-ASCII character");
      }
      result[index] = code;
    }
    return result;
  }

  function concatBytes(...parts) {
    const byteParts = parts.map((part) => asBytes(part));
    const length = byteParts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of byteParts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function bytesEqual(left, right) {
    const a = asBytes(left);
    const b = asBytes(right);
    if (a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return false;
      }
    }
    return true;
  }

  function bytesToHex(bytes, separator = "") {
    return Array.from(asBytes(bytes), (value) => value.toString(16).padStart(2, "0")).join(
      separator,
    );
  }

  function readU16LE(data, offset) {
    const bytes = asBytes(data);
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU32LE(data, offset) {
    const bytes = asBytes(data);
    return (
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0
    );
  }

  function writeU16LE(data, offset, value) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeU32LE(data, offset, value) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
    data[offset + 2] = (value >>> 16) & 0xff;
    data[offset + 3] = (value >>> 24) & 0xff;
  }

  async function sha256(data) {
    const bytes = asBytes(data);
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      return bytesToHex(new Uint8Array(digest));
    }
    if (typeof require === "function") {
      const crypto = require("node:crypto");
      return crypto
        .createHash("sha256")
        .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        .digest("hex");
    }
    throw new BinaryError("SHA-256 is not available in this browser");
  }

  function crc32(data, initial = 0) {
    const bytes = asBytes(data);
    let value = (initial ^ 0xffffffff) >>> 0;
    for (const byte of bytes) {
      value = (CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function cloneBytes(value, label = "data") {
    return Uint8Array.from(asBytes(value, label));
  }

  return Object.freeze({
    BinaryError,
    cloneBytes,
    asBytes,
    bytesFromHex,
    asciiBytes,
    concatBytes,
    bytesEqual,
    bytesToHex,
    readU16LE,
    readU32LE,
    writeU16LE,
    writeU32LE,
    sha256,
    crc32,
  });
});
