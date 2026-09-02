(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderPatcher = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROM_SIZE = 0x800000;
  const SAVE_SIZE = 0x20000;
  const SAVE_BANK_SIZE = 0x10000;
  const CALIBRATION_SECTOR_SIZE = 0x1000;
  const CALIBRATION_PRIMARY_OFFSET = 0xd000;
  const CALIBRATION_SECONDARY_OFFSET = 0xe000;
  const CALIBRATION_MAGIC = asciiBytes("Card-E Reader 2001\0\0");
  // Both ROMs read saved-program sectors 16..30 and then sectors 0..6;
  // filesystem sector 31 is not part of the record.
  const SAVED_RECORD_START = 0x10000;
  const SAVED_RECORD_PRIMARY_SIZE = 0xf000;
  const SAVED_RECORD_MAX_SIZE = 0x15ffc;
  const SAV_BANK1_IMPORT_END = 0x1ff80;

  const EXPECTED_USA_ROM_SHA256 =
    "72bf37f887e896add1342bf95a7cfe3494a689199f878e5e1aa3072639b1b948";
  const EXPECTED_JPN_ROM_SHA256 =
    "db0a82027ac17da69c9651aed8f3be9c4814ea30ca04b6ccba2e7895bd7dde6d";

  const ROM_BANK1_OFFSET = 0x720000;
  // Bank 0 remains erased unless a ROM-valid record wraps past sector 30.
  const ROM_BANK0_OFFSET = 0x730000;
  const ROM_SAVE_IMAGE_END = ROM_BANK0_OFFSET + SAVE_BANK_SIZE;
  const NATIVE_CARD_DATA_OFFSET = ROM_SAVE_IMAGE_END;
  const USA_LEGAL_SPLASH_BYPASS_OFFSET = 0x006108;
  const JPN_LEGAL_SPLASH_BYPASS_OFFSET = 0x00614e;
  const USA_BOOT_BYPASS_OFFSET = 0x0061a4;
  const JPN_BOOT_BYPASS_OFFSET = 0x0061f0;
  const USA_RETURN_RELAUNCH_OFFSET = 0x006364;
  const JPN_RETURN_RELAUNCH_OFFSET = 0x0063b0;
  const USA_ERASE_MENU_BYPASS_OFFSET = 0x029570;
  const JPN_ERASE_MENU_BYPASS_OFFSET = 0x02a7da;
  const USA_READ_FLASH_OFFSET = 0x043c74;
  const JPN_READ_FLASH_OFFSET = 0x053e34;
  const USA_SAVE_TYPE_MARKER_OFFSET = 0x3b63a0;
  const JPN_SAVE_TYPE_MARKER_OFFSET = 0x349fb0;
  const READ_STUB_OFFSET = 0x71ffd0;
  const READ_STUB_ADDRESS = 0x08000000 + READ_STUB_OFFSET;
  const ROM_TITLE_OFFSET = 0xa0;
  const ROM_TITLE_SIZE = 12;
  const STANDALONE_ROM_TITLE = asciiBytes("E-READER SA\0");
  const GAME_CODE_OFFSET = 0xac;
  const HEADER_CHECKSUM_OFFSET = 0xbd;

  const RAW_LONG_SIZE = 0x0b60;
  const RAW_SHORT_SIZE = 0x0750;
  const RAW_LONG_BIN_SIZE = 0x081c;
  const RAW_SHORT_BIN_SIZE = 0x051c;
  const VIEWER_TITLE_OFFSET = 12;
  const VIEWER_TITLE_SIZE = 20;
  const VIEWER_COMPACT_TITLE_OFFSET = 13;
  const VIEWER_COMPACT_TITLE_SIZE = 19;
  const NATIVE_TITLE_OFFSET = 12;
  const NATIVE_TITLE_SIZE = 33;
  // The USA e-Reader alphabet is ASCII-compatible and reserves these byte
  // values for characters used by official titles and Pokémon names.
  const USA_TITLE_GLYPHS = Object.freeze({
    0x7f: "é",
    0x9b: "♂",
    0x9c: "♀",
  });
  const USA_TITLE_BYTES = Object.freeze(Object.fromEntries(
    Object.entries(USA_TITLE_GLYPHS).map(([value, character]) => [character, Number(value)]),
  ));
  const UNTITLED_CONTENT_TITLE = "Untitled";
  // Bit 0 selects a variant within each family. These generic type names are
  // used only after a card's own title field has been parsed.
  const SHARED_NATIVE_TYPE_FALLBACK_TITLES = Object.freeze({
    0x06: "Recognize",
  });
  const JPN_NATIVE_TYPE_FALLBACK_TITLES = Object.freeze({
    0x08: "e Game Zero: Block Break",
    0x0a: "e Game Zero: Action",
    0x0c: "e Game Zero: Melody Box",
  });
  const USA_NATIVE_TYPE_FALLBACK_TITLES = Object.freeze({
    0x08: "Construction: Escape",
    0x0a: "Construction: Action",
    0x0c: "Construction: Melody Box",
  });
  const NATIVE_CARD_DATA_END = NATIVE_CARD_DATA_OFFSET + RAW_LONG_BIN_SIZE + 12;
  const PROGRAM_TYPE_DISPATCH_MASK = 0xff;
  const PROGRAM_TYPE_CARD_HEADER_SHIFT = 8;
  const PROGRAM_TYPE_STORED_REGION_SHIFT = 16;
  const PROGRAM_TYPE_STORED_REGION_MASK = 0xff << PROGRAM_TYPE_STORED_REGION_SHIFT;
  const USA_SAVED_REGION_CODE = 0;
  const JPN_SAVED_REGION_CODE = 2;
  const PROGRAM_TYPE_DIRECT_GBA_MASK = 0x06;
  const PROGRAM_TYPE_DIRECT_GBA_VALUE = 0x02;
  const PROGRAM_TYPE_SCANNED_GBA_VALUE = 0x06;
  const PROGRAM_TYPE_NES_FLAG = 0x08;
  const PROGRAM_LOADER_APPLICATION = "application";
  const PROGRAM_LOADER_DIRECT_GBA = "direct-gba";
  const PROGRAM_LOADER_NES = "nes";
  const PROGRAM_EXECUTION_Z80 = "z80";
  const PROGRAM_EXECUTION_GBA = "gba";
  const PROGRAM_EXECUTION_NES = "nes";
  // A saved-program type is a composed 32-bit field, not a closed regional
  // enum. The low byte drives the ROM loader. The following byte comes from
  // bits 4..11 of the reduced 12-byte card header; in the universal header it
  // combines the two nibbles that GBATEK marks unknown around Card Type and
  // Region/Version. The third byte stores 0 for USA scans and 2 for Japanese
  // e-Reader+ scans. Japanese/Original region-0 cards do not reach the stock
  // ROM's save path; constructed saves carry that source region separately.
  const DOTCODE_PROGRAM_DISPATCH_BYTES = Object.freeze({
    [PROGRAM_EXECUTION_Z80]: 0x04,
    [PROGRAM_EXECUTION_GBA]: 0x06,
    [PROGRAM_EXECUTION_NES]: 0x0c,
  });
  const DOTCODE_SAVE_PREFIX_SIZES = Object.freeze({
    [PROGRAM_EXECUTION_Z80]: 2,
    [PROGRAM_EXECUTION_GBA]: 6,
    [PROGRAM_EXECUTION_NES]: 2,
  });
  const APPLICATION_CARD_TYPES = new Set([0x02, 0x03, 0x04, 0x05, 0x0e, 0x1e]);
  const NATIVE_CARD_TYPES = new Set([
    0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x1f,
  ]);

  // Exact 256-entry compact-title -> Shift-JIS lookup table used by both
  // base ROMs. It is stored at 0x4DC10C in Card e-Reader+ (Japan) and
  // 0x5EBDD8 in e-Reader (USA); both 512-byte copies have SHA-256
  // b33694d39216122e9c935485c7c55c871669bbfa6df4ccf5b4aae85ca2a2a816.
  // Byte 0 terminates a title, while every nonzero byte has a defined mapping.
  const JAPANESE_SHORT_TITLE_SHIFT_JIS = bytesFromHex(
    "81 40 81 40 82 4F 82 50 82 51 82 52 82 53 82 54 82 55 82 56 82 57 82 58 82 9F 82 A0 82 A1 82 A2 "
      + "82 A3 82 A4 82 A5 82 A6 82 A7 82 A8 82 A9 82 AA 82 AB 82 AC 82 AD 82 AE 82 AF 82 B0 82 B1 82 B2 "
      + "82 B3 82 B4 82 B5 82 B6 82 B7 82 B8 82 B9 82 BA 82 BB 82 BC 82 BD 82 BE 82 BF 82 C0 82 C1 82 C2 "
      + "82 C3 82 C4 82 C5 82 C6 82 C7 82 C8 82 C9 82 CA 82 CB 82 CC 82 CD 82 CE 82 CF 82 D0 82 D1 82 D2 "
      + "82 D3 82 D4 82 D5 83 77 82 D7 82 D8 82 D9 82 DA 82 DB 82 DC 82 DD 82 DE 82 DF 82 E0 82 E1 82 E2 "
      + "82 E3 82 E4 82 E5 82 E6 82 E7 82 E8 82 E9 82 EA 82 EB 82 EC 82 ED 82 F0 82 F1 83 40 83 41 83 42 "
      + "83 43 83 44 83 45 83 46 83 47 83 48 83 49 83 4A 83 4B 83 4C 83 4D 83 4E 83 4F 83 50 83 51 83 52 "
      + "83 53 83 54 83 55 83 56 83 57 83 58 83 59 83 5A 83 5B 83 5C 83 5D 83 5E 83 5F 83 60 83 61 83 62 "
      + "83 63 83 64 83 65 83 66 83 67 83 68 83 69 83 6A 83 6B 83 6C 83 6D 83 6E 83 6F 83 70 83 71 83 72 "
      + "83 73 83 74 83 75 83 76 83 77 83 78 83 79 83 7A 83 7B 83 7C 83 7D 83 7E 83 80 83 81 83 82 83 83 "
      + "83 84 83 85 83 86 83 87 83 88 83 89 83 8A 83 8B 83 8C 83 8D 83 8E 83 8F 83 93 83 94 83 95 83 96 "
      + "81 5B 81 89 81 8A 81 41 81 42 81 49 81 68 81 93 81 95 81 60 81 48 81 5E 81 7B 81 7C 81 46 81 44 "
      + "81 4C 82 60 82 61 82 62 82 63 82 64 82 65 82 66 82 67 82 68 82 69 82 6A 82 6B 82 6C 82 6D 82 6E "
      + "82 6F 82 70 82 71 82 72 82 73 82 74 82 75 82 76 82 77 82 78 82 79 81 40 81 40 81 40 81 40 81 40 "
      + "81 40 81 40 81 40 81 40 81 40 81 40 82 81 82 82 82 83 82 84 82 85 82 86 82 87 82 88 82 89 82 8A "
      + "82 8B 82 8C 82 8D 82 8E 82 8F 82 90 82 91 82 92 82 93 82 94 82 95 82 96 82 97 82 98 82 99 82 9A",
  );
  if (JAPANESE_SHORT_TITLE_SHIFT_JIS.length !== 0x200) {
    throw new Error("Compact Japanese title table must contain 256 entries");
  }
  const RAW_LONG_PHYSICAL_HEADER = bytesFromHex(
    "00 03 00 19 40 10 00 2C 0E 88 ED 82 50 67 FB D1 43 EE 03 C6 C6 2B 2C 93",
  );
  const RAW_SHORT_PHYSICAL_HEADER = bytesFromHex(
    "00 02 00 01 40 10 00 1C 10 6F 40 DA 39 25 8E E0 7B B5 98 B6 5B CF 7F 72",
  );

  class PatcherError extends Error {
    constructor(message) {
      super(message);
      this.name = "PatcherError";
    }
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
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)
    ) >>> 0;
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
    throw new PatcherError("SHA-256 is not available in this browser");
  }

  const CRC32_TABLE = new Uint32Array(256);
  for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC32_TABLE[index] = value >>> 0;
  }

  function crc32(data, initial = 0) {
    const bytes = asBytes(data);
    let value = (initial ^ 0xffffffff) >>> 0;
    for (const byte of bytes) {
      value = (CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function binaryPatch(offset, expected, replacement, description) {
    return Object.freeze({
      offset,
      expected: typeof expected === "string" ? bytesFromHex(expected) : asBytes(expected),
      replacement:
        typeof replacement === "string" ? bytesFromHex(replacement) : asBytes(replacement),
      description,
    });
  }

  function snapshotPatch(patch) {
    return Object.freeze({
      ...patch,
      expected: patch.expected.slice(),
      replacement: patch.replacement.slice(),
    });
  }

  function snapshotPatchList(patches) {
    return Object.freeze(patches.map(snapshotPatch));
  }

  function snapshotRomProfile(profile) {
    return Object.freeze({
      ...profile,
      title: profile.title.slice(),
      gameCode: profile.gameCode.slice(),
      privateGameCode: profile.privateGameCode.slice(),
      patches: snapshotPatchList(profile.patches),
    });
  }

  const READ_FLASH_REPLACEMENT = concatBytes(
    bytesFromHex("10 B4 01 4C 20 47 C0 46"),
    new Uint8Array([
      (READ_STUB_ADDRESS | 1) & 0xff,
      ((READ_STUB_ADDRESS | 1) >>> 8) & 0xff,
      ((READ_STUB_ADDRESS | 1) >>> 16) & 0xff,
      ((READ_STUB_ADDRESS | 1) >>> 24) & 0xff,
    ]),
  );

  const USA_PATCHES = Object.freeze([
    binaryPatch(0x0000ac, asciiBytes("PSAE"), asciiBytes("ERDE"), "use the standalone e-Reader game code"),
    binaryPatch(USA_LEGAL_SPLASH_BYPASS_OFFSET, "33 F0 6C F9", "00 46 00 46", "skip the standalone Nintendo/Creatures/HAL legal splash"),
    binaryPatch(USA_BOOT_BYPASS_OFFSET, "0A F0 3A F9", "82 E0 00 46", "skip title/menu and select saved-application state 9"),
    binaryPatch(USA_ERASE_MENU_BYPASS_OFFSET, "06 D1", "06 E0", "always skip the L+R saved-data erase prompt"),
    binaryPatch(USA_RETURN_RELAUNCH_OFFSET, "91 E0", "A2 E7", "relaunch the embedded application if it returns"),
    binaryPatch(USA_READ_FLASH_OFFSET, "F0 B5 A0 B0 0D 1C 16 1C 1F 1C 03 04", READ_FLASH_REPLACEMENT, "redirect FLASH1M ReadFlash to the ROM-backed Thumb stub"),
    binaryPatch(0x0439fc, "00 06 00 0E", "00 20 70 47", "make FLASH1M bank switching a hardware-free no-op"),
    binaryPatch(0x043a20, "30 B5 91 B0 68 46 00 F0", "00 48 70 47 C2 09 00 00", "identify a virtual Macronix FLASH1M device without cartridge access"),
    binaryPatch(0x043d40, "30 B5 C0 B0", "00 20 70 47", "neutralize FLASH1M sector verification"),
    binaryPatch(0x043dd8, "70 B5 C0 B0", "00 20 70 47", "neutralize FLASH1M ranged verification"),
    binaryPatch(0x043e70, "70 B5 0D 1C", "00 20 70 47", "neutralize FLASH1M program-and-verify"),
    binaryPatch(0x043eb4, "F0 B5 0D 1C", "00 20 70 47", "neutralize FLASH1M ranged program-and-verify"),
    binaryPatch(0x043f9c, "F0 B5 4F 46", "00 20 70 47", "neutralize FLASH1M write polling"),
    binaryPatch(0x04403c, "70 B5 90 B0", "00 20 70 47", "neutralize FLASH1M chip erase"),
    binaryPatch(0x0440b0, "F0 B5 90 B0", "00 20 70 47", "neutralize FLASH1M sector erase"),
    binaryPatch(0x044180, "F0 B5 90 B0", "00 20 70 47", "neutralize FLASH1M byte programming"),
    binaryPatch(0x044214, "10 B5 0A 4C", "00 20 70 47", "neutralize FLASH1M low-level byte programming"),
    binaryPatch(0x04424c, "F0 B5 90 B0", "00 20 70 47", "neutralize FLASH1M sector programming"),
    binaryPatch(USA_SAVE_TYPE_MARKER_OFFSET, asciiBytes("FLASH1M_V103"), asciiBytes("ROMONLY_V103"), "remove the emulator/flash-cart FLASH1M save-type marker"),
  ]);

  const USA_FLASH_PATCH_OFFSETS = new Set([
    USA_READ_FLASH_OFFSET,
    0x0439fc,
    0x043a20,
    0x043d40,
    0x043dd8,
    0x043e70,
    0x043eb4,
    0x043f9c,
    0x04403c,
    0x0440b0,
    0x044180,
    0x044214,
    0x04424c,
  ]);
  const USA_FLASH_PATCHES = USA_PATCHES.filter((patch) =>
    USA_FLASH_PATCH_OFFSETS.has(patch.offset),
  );
  const JPN_FLASH_OFFSET_DELTA = JPN_READ_FLASH_OFFSET - USA_READ_FLASH_OFFSET;
  const JPN_FLASH_PATCHES = USA_FLASH_PATCHES.map((patch) =>
    binaryPatch(
      patch.offset + JPN_FLASH_OFFSET_DELTA,
      patch.expected,
      patch.replacement,
      patch.description,
    ),
  );

  const JPN_PATCHES = Object.freeze([
    binaryPatch(0x0000ac, asciiBytes("PSAJ"), asciiBytes("ERDJ"), "use the Japanese standalone e-Reader game code"),
    binaryPatch(JPN_LEGAL_SPLASH_BYPASS_OFFSET, "34 F0 CF F9", "00 46 00 46", "skip the Japanese Nintendo/Creatures/HAL legal splash"),
    binaryPatch(JPN_BOOT_BYPASS_OFFSET, "0A F0 7E FB", "82 E0 00 46", "skip Japanese title/menu and select saved-application state 9"),
    binaryPatch(JPN_ERASE_MENU_BYPASS_OFFSET, "06 D1", "06 E0", "always skip the L+R saved-data erase prompt"),
    binaryPatch(JPN_RETURN_RELAUNCH_OFFSET, "A4 E0", "A2 E7", "relaunch the embedded Japanese application if it returns"),
    ...JPN_FLASH_PATCHES,
    binaryPatch(JPN_SAVE_TYPE_MARKER_OFFSET, asciiBytes("FLASH1M_V103"), asciiBytes("ROMONLY_V103"), "remove the Japanese emulator/flash-cart FLASH1M save-type marker"),
  ]);

  const USA_ROM_PROFILE = Object.freeze({
    key: "usa",
    name: "e-Reader (USA)",
    sha256: EXPECTED_USA_ROM_SHA256,
    title: asciiBytes("CARDE READER"),
    gameCode: asciiBytes("PSAE"),
    privateGameCode: asciiBytes("ERDE"),
    saveMarkerOffset: USA_SAVE_TYPE_MARKER_OFFSET,
    patches: USA_PATCHES,
  });
  const JPN_ROM_PROFILE = Object.freeze({
    key: "japan",
    name: "Card e-Reader+ (Japan)",
    sha256: EXPECTED_JPN_ROM_SHA256,
    title: asciiBytes("CARDEREADER+"),
    gameCode: asciiBytes("PSAJ"),
    privateGameCode: asciiBytes("ERDJ"),
    saveMarkerOffset: JPN_SAVE_TYPE_MARKER_OFFSET,
    patches: JPN_PATCHES,
  });
  const ROM_PROFILES_BY_SHA256 = new Map([
    [USA_ROM_PROFILE.sha256, USA_ROM_PROFILE],
    [JPN_ROM_PROFILE.sha256, JPN_ROM_PROFILE],
  ]);
  const PUBLIC_ROM_PROFILES = Object.freeze({
    usa: snapshotRomProfile(USA_ROM_PROFILE),
    japan: snapshotRomProfile(JPN_ROM_PROFILE),
  });
  const PUBLIC_PATCHES = Object.freeze({
    usa: snapshotPatchList(USA_PATCHES),
    japan: snapshotPatchList(JPN_PATCHES),
  });

  const USA_NATIVE_CARD_PROFILE = Object.freeze({
    bootOffset: USA_BOOT_BYPASS_OFFSET,
    bootExpected: bytesFromHex("0A F0 3A F9"),
    mainMenuOffset: 0x61d0,
    mainMenuExpected: bytesFromHex("06 48 00 25"),
    viewerExitOffset: 0x9f9c,
    viewerExitExpected: bytesFromHex("07 20"),
    returnPatchOffset: USA_RETURN_RELAUNCH_OFFSET,
    stubOffset: 0x2d6304,
    scanResetAddresses: [0x0800227c, 0x08015fe0, 0x08000ebc],
    scanOverlayRestoreAddress: 0x080099f0,
    scanPrepareAddress: 0x0800547c,
    scanSetupAddress: 0x080099c8,
    parserAddress: 0x08009294,
    formatAddress: 0x02029416,
    headerAddress: 0x020294a0,
    payloadAddress: 0x02028b78,
    validationHeaderAddress: 0x0202656c,
    nativeContextAddress: 0x02029434,
    outerStateAddress: 0x0202941c,
    frameDispatchAddress: 0x08006491,
  });
  const JPN_NATIVE_CARD_PROFILE = Object.freeze({
    bootOffset: JPN_BOOT_BYPASS_OFFSET,
    bootExpected: bytesFromHex("0A F0 7E FB"),
    mainMenuOffset: 0x621c,
    mainMenuExpected: bytesFromHex("06 48 00 25"),
    viewerExitOffset: 0xa0cc,
    viewerExitExpected: bytesFromHex("07 20"),
    returnPatchOffset: JPN_RETURN_RELAUNCH_OFFSET,
    stubOffset: 0x28d23c,
    scanResetAddresses: [0x080022c0, 0x080169a8, 0x08000efc],
    scanOverlayRestoreAddress: 0x08009b10,
    scanPrepareAddress: 0x080054cc,
    scanSetupAddress: 0x08009a9c,
    parserAddress: 0x0800932c,
    formatAddress: 0x02031922,
    headerAddress: 0x020319ac,
    payloadAddress: 0x02031084,
    validationHeaderAddress: 0x0202656c,
    nativeContextAddress: 0x02031940,
    outerStateAddress: 0x02031928,
    frameDispatchAddress: 0x08006503,
  });
  const NATIVE_CARD_PROFILES = Object.freeze({
    usa: USA_NATIVE_CARD_PROFILE,
    japan: JPN_NATIVE_CARD_PROFILE,
  });

  const READ_STUB = bytesFromHex(
    "1F 24 20 40 10 24 60 40 00 03 40 18 05 49 40 18 " +
      "00 2B 05 D0 01 78 11 70 01 30 01 32 01 3B F9 D1 " +
      "10 BC 70 47 00 00 72 08",
  );
  const PUBLIC_READ_STUB = READ_STUB.slice();

  function firstNull(bytes) {
    const offset = bytes.indexOf(0);
    return offset === -1 ? bytes : bytes.subarray(0, offset);
  }

  function decodeAscii(bytes) {
    return String.fromCharCode(...bytes);
  }

  function shiftJisDecoder(fatal) {
    try {
      return new TextDecoder("shift_jis", { fatal });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new PatcherError("Shift-JIS decoding is not available in this browser");
      }
      throw error;
    }
  }

  function decodeShiftJis(bytes, fatal) {
    return shiftJisDecoder(fatal).decode(bytes);
  }

  function japaneseShortTitleToShiftJis(bytesInput, label = "title") {
    const bytes = firstNull(asBytes(bytesInput, label));
    const encoded = new Uint8Array(bytes.length * 2);
    for (let index = 0; index < bytes.length; index += 1) {
      const offset = bytes[index] * 2;
      encoded.set(JAPANESE_SHORT_TITLE_SHIFT_JIS.subarray(offset, offset + 2), index * 2);
    }
    return encoded;
  }

  function decodeJapaneseShortTitle(bytesInput, label = "title") {
    return decodeShiftJis(japaneseShortTitleToShiftJis(bytesInput, label), true);
  }

  function decodeUsaTitle(bytesInput, label = "USA e-Reader title") {
    const bytes = firstNull(asBytes(bytesInput, label));
    let title = "";
    for (const value of bytes) {
      if (value >= 0x20 && value < 0x7f) {
        title += String.fromCharCode(value);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(USA_TITLE_GLYPHS, value)) {
        throw new PatcherError(
          `${label} contains unsupported e-Reader character 0x${value.toString(16).toUpperCase().padStart(2, "0")}`,
        );
      }
      title += USA_TITLE_GLYPHS[value];
    }
    return title;
  }

  function encodeUsaTitle(value, label = "USA e-Reader title") {
    const title = String(value);
    const encoded = [];
    for (const character of title) {
      const codePoint = character.codePointAt(0);
      if (codePoint >= 0x20 && codePoint < 0x7f) {
        encoded.push(codePoint);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(USA_TITLE_BYTES, character)) {
        throw new PatcherError(
          `${label} contains a character that cannot be encoded for the English version`,
        );
      }
      encoded.push(USA_TITLE_BYTES[character]);
    }
    return Uint8Array.from(encoded);
  }

  function isPrintableTitle(title) {
    return title.length > 0 && [...title].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x20 && codePoint !== 0x7f;
    });
  }

  function decodeExtendedTitleField(bytesInput, region, label) {
    const titleBytes = firstNull(asBytes(bytesInput, label));
    if (titleBytes.length === 0) {
      return null;
    }
    if (region === 1) {
      try {
        const title = decodeUsaTitle(titleBytes, label);
        const titleEncoding = titleBytes.every((value) => value >= 0x20 && value < 0x7f)
          ? "ASCII"
          : "e-Reader USA 1-byte";
        return { title, titleEncoding, saveTitleBytes: titleBytes.slice() };
      } catch (error) {
        if (!(error instanceof PatcherError)) {
          throw error;
        }
        return null;
      }
    }

    try {
      const title = decodeShiftJis(titleBytes, true);
      if (isPrintableTitle(title)) {
        return { title, titleEncoding: "Shift-JIS", saveTitleBytes: titleBytes.slice() };
      }
    } catch (error) {
      if (error instanceof PatcherError) {
        throw error;
      }
    }

    try {
      const title = new TextDecoder("utf-8", { fatal: true }).decode(titleBytes);
      if (!isPrintableTitle(title)) {
        return null;
      }
      return {
        title,
        titleEncoding: "UTF-8",
        saveTitleBytes: encodeShiftJis(title, label),
      };
    } catch (error) {
      if (error instanceof PatcherError || error instanceof RangeError) {
        throw error;
      }
      return null;
    }
  }

  function decodeDirectJapaneseViewerTitle(app) {
    // Direct-title records declare the alternate field layout in their header.
    // This keeps coincidental byte pairs in compact names from looking like
    // valid Shift-JIS titles.
    if (
      app[5] !== 0x20
      || app[6] !== 0x01
      || app.subarray(8, 12).some((value) => value !== 0)
    ) {
      return null;
    }
    const titleBytes = firstNull(app.subarray(
      VIEWER_TITLE_OFFSET,
      VIEWER_TITLE_OFFSET + VIEWER_TITLE_SIZE,
    ));
    if (titleBytes.length === 0 || titleBytes.length % 2 !== 0) {
      return null;
    }
    for (let offset = 0; offset < titleBytes.length; offset += 2) {
      const lead = titleBytes[offset];
      const trail = titleBytes[offset + 1];
      if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc))) {
        return null;
      }
      if (trail < 0x40 || trail > 0xfc || trail === 0x7f) {
        return null;
      }
    }
    try {
      const title = decodeShiftJis(titleBytes, true);
      return [...title].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint < 0x20 || codePoint === 0x7f;
      }) ? null : title;
    } catch (error) {
      if (error instanceof RangeError) {
        throw error;
      }
      return null;
    }
  }

  function decodeNativeTitle(decoded) {
    if (decoded.cardType !== 0x0f && decoded.cardType !== 0x1f) {
      return null;
    }
    const titleField = decoded.app.subarray(
      NATIVE_TITLE_OFFSET,
      NATIVE_TITLE_OFFSET + NATIVE_TITLE_SIZE,
    );
    const terminator = titleField.indexOf(0);
    if (
      terminator >= 0
      && titleField.subarray(terminator).some((value) => value !== 0)
    ) {
      return null;
    }
    const decodedTitle = decodeExtendedTitleField(
      titleField,
      decoded.region,
      "native game title",
    );
    return decodedTitle === null
      ? null
      : { title: decodedTitle.title, titleEncoding: decodedTitle.titleEncoding };
  }

  function nativeTypeFallbackTitle(region, cardType) {
    const family = cardType & 0xfe;
    if (Object.prototype.hasOwnProperty.call(SHARED_NATIVE_TYPE_FALLBACK_TITLES, family)) {
      return SHARED_NATIVE_TYPE_FALLBACK_TITLES[family];
    }
    const regionalTitles = region === 1
      ? USA_NATIVE_TYPE_FALLBACK_TITLES
      : JPN_NATIVE_TYPE_FALLBACK_TITLES;
    return regionalTitles[family];
  }

  let compactJapaneseTitleEncodings = null;
  let completeShiftJisEncodings = null;

  function compactJapaneseTitleEncodingMap() {
    if (compactJapaneseTitleEncodings) {
      return compactJapaneseTitleEncodings;
    }
    const decoder = shiftJisDecoder(true);
    const encodings = new Map();
    for (let compact = 1; compact <= 0xff; compact += 1) {
      const pair = JAPANESE_SHORT_TITLE_SHIFT_JIS.subarray(
        compact * 2,
        compact * 2 + 2,
      );
      const character = decoder.decode(pair);
      if (!encodings.has(character)) {
        encodings.set(character, (pair[0] << 8) | pair[1]);
      }
    }
    compactJapaneseTitleEncodings = encodings;
    return encodings;
  }

  function completeShiftJisEncodingMap() {
    if (completeShiftJisEncodings) {
      return completeShiftJisEncodings;
    }
    const decoder = shiftJisDecoder(true);
    const encodings = new Map(compactJapaneseTitleEncodingMap());
    const remember = (bytes, encoded) => {
      try {
        const character = decoder.decode(bytes);
        if ([...character].length === 1 && !encodings.has(character)) {
          encodings.set(character, encoded);
        }
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      }
    };

    for (let value = 0x80; value <= 0xff; value += 1) {
      remember(Uint8Array.of(value), value);
    }
    for (const [leadStart, leadEnd] of [[0x81, 0x9f], [0xe0, 0xfc]]) {
      for (let lead = leadStart; lead <= leadEnd; lead += 1) {
        for (let trail = 0x40; trail <= 0xfc; trail += 1) {
          if (trail !== 0x7f) {
            remember(Uint8Array.of(lead, trail), (lead << 8) | trail);
          }
        }
      }
    }

    // The Encoding Standard defines these encoder aliases even though the
    // corresponding single bytes decode as ASCII characters.
    encodings.set("¥", 0x5c);
    encodings.set("‾", 0x7e);
    if (encodings.has("－")) {
      encodings.set("−", encodings.get("－"));
    }
    completeShiftJisEncodings = encodings;
    return encodings;
  }

  function encodeShiftJis(value, label = "application title") {
    const text = String(value);
    if (text.includes("\0")) {
      throw new PatcherError(`${label} must not contain a NUL character`);
    }
    const encoded = [];
    const compactEncodings = compactJapaneseTitleEncodingMap();
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 0x7f) {
        encoded.push(codePoint);
        continue;
      }
      const valueFromMap = compactEncodings.get(character)
        ?? completeShiftJisEncodingMap().get(character);
      if (valueFromMap === undefined) {
        throw new PatcherError(
          `${label} contains a character that cannot be encoded for the Japanese version`,
        );
      }
      if (valueFromMap <= 0xff) {
        encoded.push(valueFromMap);
      } else {
        encoded.push(valueFromMap >>> 8, valueFromMap & 0xff);
      }
    }
    return Uint8Array.from(encoded);
  }

  function japaneseApplicationTitle(value) {
    let title = "";
    for (const character of String(value)) {
      const codePoint = character.codePointAt(0);
      if (codePoint === 0x20) {
        title += "\u3000";
      } else if (codePoint >= 0x21 && codePoint <= 0x7e) {
        title += String.fromCodePoint(codePoint + 0xfee0);
      } else {
        title += character;
      }
    }
    return title;
  }

  async function validatedRomProfile(romInput) {
    const rom = asBytes(romInput, "ROM");
    if (rom.length !== ROM_SIZE) {
      throw new PatcherError(
        `ROM size is 0x${rom.length.toString(16).toUpperCase()}; expected 0x${ROM_SIZE.toString(16).toUpperCase()}`,
      );
    }
    const digest = await sha256(rom);
    const profile = ROM_PROFILES_BY_SHA256.get(digest);
    if (!profile) {
      throw new PatcherError(
        "Unsupported base ROM; expected e-Reader (USA) or Card e-Reader+ (Japan).",
      );
    }
    if (
      !bytesEqual(rom.subarray(0xa0, 0xac), profile.title) ||
      !bytesEqual(rom.subarray(0xac, 0xb0), profile.gameCode)
    ) {
      throw new PatcherError(`ROM header is not the supported ${profile.name} revision`);
    }
    for (let offset = ROM_BANK1_OFFSET; offset < rom.length; offset += 1) {
      if (rom[offset] !== 0xff) {
        throw new PatcherError("Expected free 0xFF ROM space from 0x720000 onward");
      }
    }
    return profile;
  }

  async function validateRom(romInput) {
    return snapshotRomProfile(await validatedRomProfile(romInput));
  }

  function decodeSavedApplicationTitle(record, applicationRegion) {
    const titleBytes = firstNull(record.subarray(4, 0x28));
    if (titleBytes.length === 0) {
      return {
        title: UNTITLED_CONTENT_TITLE,
        titleBytes,
        titleEncoding: "none",
      };
    }
    if (applicationRegion === "usa") {
      try {
        return {
          title: decodeUsaTitle(titleBytes, "saved application title"),
          titleBytes,
          titleEncoding: titleBytes.every((value) => value >= 0x20 && value < 0x7f)
            ? "ASCII"
            : "e-Reader USA 1-byte",
        };
      } catch (error) {
        if (!(error instanceof PatcherError)) {
          throw error;
        }
        // Region code 0 is also used by Japanese/Original dot codes. If the
        // title is not valid in the small USA alphabet, try Shift-JIS below.
      }
    }
    if (titleBytes.every((value) => value < 0x80)) {
      return {
        title: decodeAscii(titleBytes),
        titleBytes,
        titleEncoding: "ASCII",
      };
    }
    try {
      return {
        title: decodeShiftJis(titleBytes, true),
        titleBytes,
        titleEncoding: "Shift-JIS",
      };
    } catch (error) {
      if (error instanceof PatcherError) {
        throw error;
      }
      return {
        title: decodeShiftJis(titleBytes, false),
        titleBytes,
        titleEncoding: "Shift-JIS (damaged)",
      };
    }
  }

  function savedRecordBytes(save, size) {
    if (!Number.isInteger(size) || size < 0 || size > SAVED_RECORD_MAX_SIZE) {
      throw new PatcherError("Saved-program record size is outside the ROM-supported range");
    }
    const primarySize = Math.min(size, SAVED_RECORD_PRIMARY_SIZE);
    const record = new Uint8Array(size);
    record.set(save.subarray(SAVED_RECORD_START, SAVED_RECORD_START + primarySize));
    record.set(save.subarray(0, size - primarySize), primarySize);
    return record;
  }

  function writeSavedRecord(save, record) {
    if (record.length > SAVED_RECORD_MAX_SIZE) {
      throw new PatcherError("Saved-program record is larger than the ROM supports");
    }
    const primarySize = Math.min(record.length, SAVED_RECORD_PRIMARY_SIZE);
    save.set(record.subarray(0, primarySize), SAVED_RECORD_START);
    save.set(record.subarray(primarySize), 0);
  }

  function savedPayloadLayout(record, programSize, programType, loader) {
    const program = record.subarray(0x34, 0x34 + programSize);
    if (loader === PROGRAM_LOADER_DIRECT_GBA && (programType & 1) !== 0) {
      return { prefixSize: 0, payloadOffset: 0x34, payloadSize: programSize };
    }
    if (
      programSize >= 6
      && readU32LE(program, 0) + 6 === programSize
      && program[4] === 0
      && program[5] === 0
    ) {
      return { prefixSize: 6, payloadOffset: 0x3a, payloadSize: programSize - 6 };
    }
    if (programSize >= 2 && readU16LE(program, 0) + 2 === programSize) {
      return { prefixSize: 2, payloadOffset: 0x36, payloadSize: programSize - 2 };
    }
    return { prefixSize: 0, payloadOffset: 0x34, payloadSize: programSize };
  }

  function savedPayloadRawSize(payload, payloadFormat) {
    if (payloadFormat === "RAW") {
      return payload.length;
    }
    if (payload.length < 8) {
      return 0;
    }
    return (
      payload[7]
      | (payload[6] << 8)
      | (payload[5] << 16)
      | (payload[4] * 0x1000000)
    ) >>> 0;
  }

  function savedProgramLoader(programType) {
    const typeByte = programType & PROGRAM_TYPE_DISPATCH_MASK;
    if ((typeByte & PROGRAM_TYPE_DIRECT_GBA_MASK) === PROGRAM_TYPE_DIRECT_GBA_VALUE) {
      return PROGRAM_LOADER_DIRECT_GBA;
    }
    if (typeByte & PROGRAM_TYPE_NES_FLAG) {
      return PROGRAM_LOADER_NES;
    }
    return PROGRAM_LOADER_APPLICATION;
  }

  function savedProgramExecution(programType) {
    const typeByte = programType & PROGRAM_TYPE_DISPATCH_MASK;
    const loader = savedProgramLoader(programType);
    if (loader === PROGRAM_LOADER_DIRECT_GBA) {
      return PROGRAM_EXECUTION_GBA;
    }
    if (loader === PROGRAM_LOADER_NES) {
      return PROGRAM_EXECUTION_NES;
    }
    if ((typeByte & PROGRAM_TYPE_DIRECT_GBA_MASK) === PROGRAM_TYPE_SCANNED_GBA_VALUE) {
      return PROGRAM_EXECUTION_GBA;
    }
    return PROGRAM_EXECUTION_Z80;
  }

  function composeProgramType(dispatchByte, cardHeaderByte, storedRegionCode) {
    if ((dispatchByte & ~PROGRAM_TYPE_DISPATCH_MASK) !== 0) {
      throw new PatcherError("Program-type dispatch byte is outside the byte range");
    }
    if (!Number.isInteger(cardHeaderByte) || cardHeaderByte < 0 || cardHeaderByte > 0xff) {
      throw new PatcherError("Card-header byte is outside the byte range");
    }
    if (
      !Number.isInteger(storedRegionCode)
      || storedRegionCode < 0
      || storedRegionCode > 0xff
    ) {
      throw new PatcherError("Stored program-type region code is outside the byte range");
    }
    return (
      dispatchByte
      | (cardHeaderByte << PROGRAM_TYPE_CARD_HEADER_SHIFT)
      | (storedRegionCode << PROGRAM_TYPE_STORED_REGION_SHIFT)
    ) >>> 0;
  }

  function storedDotcodeRegionCode(scanRegion) {
    if (![0, 1, 2].includes(scanRegion)) {
      throw new PatcherError(`Unsupported e-Reader scan region: ${scanRegion}`);
    }
    return scanRegion === 2 ? JPN_SAVED_REGION_CODE : USA_SAVED_REGION_CODE;
  }

  function dotcodeCardHeaderByte(header) {
    if (header.length < 2) {
      throw new PatcherError("Dot-code application header is too short");
    }
    // The reduced header reverses universal-header bytes 0x0C and 0x0D.
    // Consequently this combines universal Region/Type bits 12..15 in the
    // low nibble and bits 0..3 in the high nibble. GBATEK labels both unknown.
    return (readU16LE(header, 0) >>> 4) & 0xff;
  }

  function dotcodeSaveLayout(execution, cardHeaderByte, scanRegion) {
    const dispatchByte = DOTCODE_PROGRAM_DISPATCH_BYTES[execution];
    const prefixSize = DOTCODE_SAVE_PREFIX_SIZES[execution];
    if (
      dispatchByte === undefined
      || cardHeaderByte === undefined
      || prefixSize === undefined
    ) {
      throw new PatcherError(`Unknown dot-code execution family: ${execution}`);
    }
    return {
      programType: composeProgramType(
        dispatchByte,
        cardHeaderByte,
        storedDotcodeRegionCode(scanRegion),
      ),
      prefixSize,
    };
  }

  function rawExportPreservesContent(metadata) {
    const typeByte = metadata.programType & PROGRAM_TYPE_DISPATCH_MASK;
    const storedRegionCode = (
      metadata.programType & PROGRAM_TYPE_STORED_REGION_MASK
    ) >>> PROGRAM_TYPE_STORED_REGION_SHIFT;
    if (
      (metadata.programType & 0xff000000) === 0
      && [USA_SAVED_REGION_CODE, JPN_SAVED_REGION_CODE].includes(storedRegionCode)
      && typeByte === DOTCODE_PROGRAM_DISPATCH_BYTES[metadata.execution]
      && metadata.prefixSize === DOTCODE_SAVE_PREFIX_SIZES[metadata.execution]
    ) {
      return true;
    }
    if (metadata.execution !== PROGRAM_EXECUTION_GBA) {
      return false;
    }
    return (
      typeByte === DOTCODE_PROGRAM_DISPATCH_BYTES[PROGRAM_EXECUTION_GBA]
      && metadata.prefixSize === 6
    ) || (
      typeByte === PROGRAM_TYPE_DIRECT_GBA_VALUE
      && metadata.prefixSize === 2
      && metadata.payloadFormat === "VPK"
    );
  }

  function validateSave(saveInput) {
    const save = asBytes(saveInput, "save");
    if (save.length !== SAVE_SIZE) {
      throw new PatcherError(
        `save size is 0x${save.length.toString(16).toUpperCase()}; expected 0x${SAVE_SIZE.toString(16).toUpperCase()}`,
      );
    }

    const header = save.subarray(SAVED_RECORD_START, SAVED_RECORD_START + 0x34);
    if (header[4] === 0xff) {
      throw new PatcherError("Save data contains no saved application");
    }

    const programType = readU32LE(header, 0x28);
    const programSize = readU32LE(header, 0x2c);
    const extraSize = readU32LE(header, 0x30);

    const recordSize = 0x34 + programSize + extraSize;
    if (recordSize > SAVED_RECORD_MAX_SIZE) {
      throw new PatcherError(
        "Saved-program record exceeds the 0x15FFC-byte limit enforced by the e-Reader ROM",
      );
    }
    const record = savedRecordBytes(save, recordSize);

    const loader = savedProgramLoader(programType);
    const { prefixSize, payloadOffset, payloadSize } = savedPayloadLayout(
      record,
      programSize,
      programType,
      loader,
    );

    const payload = record.subarray(payloadOffset, payloadOffset + payloadSize);
    const payloadFormat = bytesEqual(payload.subarray(0, 4), asciiBytes("vpk0"))
      ? "VPK"
      : "RAW";
    const crcLength = 0x30 + programSize + extraSize;
    const storedCrc = readU32LE(record, 0);
    const calculatedCrc = (~crc32(record.subarray(4, 4 + crcLength), 0x55b87bdd)) >>> 0;
    if (calculatedCrc !== storedCrc) {
      throw new PatcherError(
        `saved-program CRC mismatch: stored 0x${storedCrc.toString(16).toUpperCase().padStart(8, "0")}, calculated 0x${calculatedCrc.toString(16).toUpperCase().padStart(8, "0")}`,
      );
    }

    const rawSize = savedPayloadRawSize(payload, payloadFormat);
    const storedRegionCode = (
      programType & PROGRAM_TYPE_STORED_REGION_MASK
    ) >>> PROGRAM_TYPE_STORED_REGION_SHIFT;
    let applicationRegion;
    if (storedRegionCode === USA_SAVED_REGION_CODE) {
      applicationRegion = "usa";
    } else if (storedRegionCode === JPN_SAVED_REGION_CODE) {
      applicationRegion = "japan";
    } else {
      throw new PatcherError(
        `Saved application uses unsupported region code 0x${storedRegionCode.toString(16).toUpperCase().padStart(2, "0")}`,
      );
    }
    const { title, titleBytes, titleEncoding } = decodeSavedApplicationTitle(
      record,
      applicationRegion,
    );
    const execution = savedProgramExecution(programType);
    return {
      title,
      titleBytes: titleBytes.slice(),
      titleEncoding,
      applicationRegion,
      loader,
      execution,
      programType,
      cardHeaderByte: (programType >>> PROGRAM_TYPE_CARD_HEADER_SHIFT) & 0xff,
      storedRegionCode,
      programSize,
      extraSize,
      recordSize,
      prefixSize,
      payloadSize,
      payloadOffset,
      payloadFormat,
      rawSize,
      crc: storedCrc,
    };
  }

  function isValidSaveCalibrationSector(sectorInput) {
    const sector = asBytes(sectorInput, "calibration sector");
    if (
      sector.length !== CALIBRATION_SECTOR_SIZE
      || !bytesEqual(sector.subarray(0, CALIBRATION_MAGIC.length), CALIBRATION_MAGIC)
    ) {
      return false;
    }

    let sum = 0;
    for (let offset = 0; offset < CALIBRATION_SECTOR_SIZE; offset += 2) {
      sum += readU16LE(sector, offset);
    }
    const folded = (sum & 0xffff) + (sum >>> 16);
    return (folded & 0xffff) === 0xffff;
  }

  function extractSaveCalibration(saveInput) {
    const save = asBytes(saveInput, "save");
    if (save.length !== SAVE_SIZE) {
      throw new PatcherError(
        `save size is 0x${save.length.toString(16).toUpperCase()}; expected 0x${SAVE_SIZE.toString(16).toUpperCase()}`,
      );
    }

    const secondary = save.subarray(
      CALIBRATION_SECONDARY_OFFSET,
      CALIBRATION_SECONDARY_OFFSET + CALIBRATION_SECTOR_SIZE,
    );
    if (isValidSaveCalibrationSector(secondary)) {
      return Uint8Array.from(secondary);
    }

    const primary = save.subarray(
      CALIBRATION_PRIMARY_OFFSET,
      CALIBRATION_PRIMARY_OFFSET + CALIBRATION_SECTOR_SIZE,
    );
    if (isValidSaveCalibrationSector(primary)) {
      return Uint8Array.from(primary);
    }

    throw new PatcherError("Save data contains no valid e-Reader calibration data");
  }

  function applySaveCalibration(targetSaveInput, calibrationSectorInput) {
    const targetSave = asBytes(targetSaveInput, "target save");
    if (targetSave.length !== SAVE_SIZE) {
      throw new PatcherError(
        `target save size is 0x${targetSave.length.toString(16).toUpperCase()}; expected 0x${SAVE_SIZE.toString(16).toUpperCase()}`,
      );
    }

    const calibrationSector = asBytes(calibrationSectorInput, "calibration sector");
    if (calibrationSector.length !== CALIBRATION_SECTOR_SIZE) {
      throw new PatcherError(
        `calibration sector size is 0x${calibrationSector.length.toString(16).toUpperCase()}; expected 0x${CALIBRATION_SECTOR_SIZE.toString(16).toUpperCase()}`,
      );
    }
    if (!isValidSaveCalibrationSector(calibrationSector)) {
      throw new PatcherError("Calibration sector is not valid e-Reader calibration data");
    }

    const result = Uint8Array.from(targetSave);
    result.set(calibrationSector, CALIBRATION_PRIMARY_OFFSET);
    result.set(calibrationSector, CALIBRATION_SECONDARY_OFFSET);
    return result;
  }

  function validatedSavePayload(save, metadata) {
    const record = savedRecordBytes(save, metadata.recordSize);
    return record.slice(metadata.payloadOffset, metadata.payloadOffset + metadata.payloadSize);
  }

  function extractSavePayload(saveInput) {
    const save = asBytes(saveInput, "save");
    return validatedSavePayload(save, validateSave(save));
  }

  function xorBytes(data) {
    let result = 0;
    for (const value of asBytes(data)) {
      result ^= value;
    }
    return result;
  }

  const GF_POWERS = new Uint8Array(256);
  const GF_LOGARITHMS = new Uint16Array(256);
  GF_LOGARITHMS[0] = 255;
  {
    let value = 1;
    for (let exponent = 0; exponent < 255; exponent += 1) {
      GF_POWERS[exponent] = value;
      GF_LOGARITHMS[value] = exponent;
      value <<= 1;
      if (value >= 0x100) {
        value ^= 0x187;
      }
    }
  }

  function gfMultiply(left, right) {
    if (left === 0 || right === 0) {
      return 0;
    }
    return GF_POWERS[(GF_LOGARITHMS[left] + GF_LOGARITHMS[right]) % 255];
  }

  function gfInverse(value) {
    if (value === 0) {
      throw new PatcherError("Cannot invert zero in GF(256)");
    }
    return GF_POWERS[(255 - GF_LOGARITHMS[value]) % 255];
  }

  function gfSolve(matrix, vector) {
    const size = vector.length;
    const rows = matrix.map((row, index) => [...row, vector[index]]);
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      while (pivot < size && rows[pivot][column] === 0) {
        pivot += 1;
      }
      if (pivot === size) {
        throw new PatcherError("Singular Reed-Solomon parity system");
      }
      [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
      const inverse = gfInverse(rows[column][column]);
      rows[column] = rows[column].map((value) => gfMultiply(value, inverse));
      for (let row = 0; row < size; row += 1) {
        if (row === column || rows[row][column] === 0) {
          continue;
        }
        const factor = rows[row][column];
        rows[row] = rows[row].map(
          (value, index) => value ^ gfMultiply(factor, rows[column][index]),
        );
      }
    }
    return rows.map((row) => row[row.length - 1]);
  }

  function rsSyndromes(codeword, paritySize = 16) {
    const syndromes = [];
    for (let rootIndex = 0; rootIndex < paritySize; rootIndex += 1) {
      let syndrome = 0;
      for (let position = 0; position < codeword.length; position += 1) {
        const value = codeword[position];
        if (value !== 0) {
          syndrome ^= gfMultiply(
            value,
            GF_POWERS[((0x78 + rootIndex) * position) % 255],
          );
        }
      }
      syndromes.push(syndrome);
    }
    return syndromes;
  }

  function encodeEReaderCodeword(dataInput, paritySize = 16) {
    const data = asBytes(dataInput);
    if (data.length === 0 || data.length + paritySize > 255 || paritySize <= 0) {
      throw new PatcherError("Invalid Reed-Solomon data size");
    }
    const codeword = new Array(255).fill(0);
    codeword.fill(0xff, 0, paritySize);
    for (let index = 0; index < data.length; index += 1) {
      codeword[paritySize + index] = data[data.length - 1 - index];
    }
    const syndromes = rsSyndromes(codeword, paritySize);
    const positions = Array.from(
      { length: paritySize },
      (_value, index) => paritySize - 1 - index,
    );
    const matrix = Array.from({ length: paritySize }, (_value, row) =>
      positions.map(
        (position) => GF_POWERS[((0x78 + row) * position) % 255],
      ));
    return concatBytes(data, Uint8Array.from(gfSolve(matrix, syndromes)));
  }

  function encodeRawDotcode(appInput, physicalCardType = null) {
    const app = asBytes(appInput, "card data");
    let rawSize;
    let physicalHeader;
    let columns;
    let dataEnd;
    let stripHeader;
    if (app.length === RAW_LONG_BIN_SIZE) {
      rawSize = RAW_LONG_SIZE;
      physicalHeader = RAW_LONG_PHYSICAL_HEADER;
      columns = 44;
      dataEnd = 0x0b38;
      stripHeader = bytesFromHex("00 30 01 02 00 01 08 10 00 00 10 12");
    } else if (app.length === RAW_SHORT_BIN_SIZE) {
      rawSize = RAW_SHORT_SIZE;
      physicalHeader = RAW_SHORT_PHYSICAL_HEADER;
      columns = 28;
      dataEnd = 0x0724;
      stripHeader = bytesFromHex("00 30 01 01 00 01 05 10 00 00 10 12");
    } else {
      throw new PatcherError(
        `card data is 0x${app.length.toString(16).toUpperCase()} bytes; expected 0x${RAW_LONG_BIN_SIZE.toString(16).toUpperCase()} or 0x${RAW_SHORT_BIN_SIZE.toString(16).toUpperCase()}`,
      );
    }
    const cardType = physicalCardType === null ? app[1] >>> 4 : physicalCardType;
    if (cardType < 0 || cardType > 0x1f || (cardType & 0x0f) !== (app[1] >>> 4)) {
      throw new PatcherError("Card type does not match the old-style card header");
    }

    const header = new Uint8Array(0x30);
    header.set(stripHeader);
    header[3] = cardType & 0x10 ? 1 : 2;
    header[0x0d] = app[0];
    header[0x0c] = app[1];
    header[0x0e] = 0x02;
    header[0x0f] = 0;
    header[0x11] = app[2];
    header[0x10] = app[3];
    header[0x12] = 0x10;
    header[0x15] = 0x19;
    header[0x19] = 0x08;
    header.set(asciiBytes("NINTENDO"), 0x1a);
    header.set(bytesFromHex("00 22 00 09"), 0x22);
    header.set(app.subarray(4, 12), 0x26);
    header[0x2e] = xorBytes(app.subarray(0, 12));

    let checksumTotal = 0;
    for (let index = 12; index < app.length; index += 1) {
      checksumTotal += index & 1 ? app[index] : app[index] << 8;
    }
    const dataChecksum = (~checksumTotal) & 0xffff;
    header[0x13] = (dataChecksum >>> 8) & 0xff;
    header[0x14] = dataChecksum & 0xff;
    checksumTotal = 0;
    for (let index = 0; index < 0x2f; index += 1) {
      checksumTotal += header[index];
    }
    for (let offset = 12; offset < app.length; offset += 0x30) {
      checksumTotal += xorBytes(app.subarray(offset, offset + 0x30));
    }
    header[0x2f] = (~checksumTotal) & 0xff;

    const decoded = concatBytes(header, app.subarray(12));
    if (decoded.length !== columns * 0x30) {
      throw new Error("Generated universal dot-code data has the wrong size");
    }
    const codewords = [];
    for (let offset = 0; offset < decoded.length; offset += 0x30) {
      codewords.push(encodeEReaderCodeword(decoded.subarray(offset, offset + 0x30)));
    }
    const interleaved = new Uint8Array(columns * 0x40);
    let interleavedOffset = 0;
    for (let row = 0; row < 0x40; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        interleaved[interleavedOffset] = codewords[column][row];
        interleavedOffset += 1;
      }
    }

    const raw = new Uint8Array(rawSize);
    for (let row = 0; row < rawSize / 0x68; row += 1) {
      const headerOffset = (row % 12) * 2;
      raw.set(physicalHeader.subarray(headerOffset, headerOffset + 2), row * 0x68);
    }
    let rawDataOffset = 0;
    for (let index = 2; index < dataEnd; index += 1) {
      if (index % 0x68 >= 2) {
        raw[index] = interleaved[rawDataOffset];
        rawDataOffset += 1;
      }
    }
    if (rawDataOffset !== interleaved.length) {
      throw new Error("Generated RAW interleave extent is invalid");
    }
    for (let index = dataEnd; index < raw.length; index += 1) {
      raw[index] = index & 0xff;
    }
    const checked = decodeRawDotcodeDetails(raw, "generated RAW");
    if (!bytesEqual(checked.app, app) || checked.cardType !== cardType) {
      throw new Error("Generated RAW did not round-trip");
    }
    return raw;
  }

  function decodeRawDotcodeDetails(rawInput, label = "RAW input") {
    const raw = asBytes(rawInput, "RAW input");
    let expectedPrefix;
    let appSize;
    if (raw.length === RAW_LONG_SIZE) {
      expectedPrefix = bytesFromHex("00 03 00 19 40 10 00 2C");
      appSize = RAW_LONG_BIN_SIZE;
    } else if (raw.length === RAW_SHORT_SIZE) {
      expectedPrefix = bytesFromHex("00 02 00 01 40 10 00 1C");
      appSize = RAW_SHORT_BIN_SIZE;
    } else {
      throw new PatcherError(
        `${label} is 0x${raw.length.toString(16).toUpperCase()} bytes; expected a 0x${RAW_LONG_SIZE.toString(16).toUpperCase()} long or 0x${RAW_SHORT_SIZE.toString(16).toUpperCase()} short RAW strip`,
      );
    }

    const physicalHeader = new Uint8Array(24);
    for (let row = 0; row < 12; row += 1) {
      physicalHeader[row * 2] = raw[row * 0x68];
      physicalHeader[row * 2 + 1] = raw[row * 0x68 + 1];
    }
    if (!bytesEqual(physicalHeader.subarray(0, 8), expectedPrefix)) {
      throw new PatcherError(`${label} has an unsupported or damaged RAW header`);
    }

    const codewordSize = physicalHeader[4];
    const paritySize = physicalHeader[5];
    const columns = physicalHeader[7];
    if (codewordSize !== 0x40 || paritySize !== 0x10) {
      throw new PatcherError(`${label} uses an unsupported RAW error-correction layout`);
    }

    const encodedEnd = Math.floor((codewordSize * columns * 0x68 + 0x65) / 0x66);
    if (encodedEnd > raw.length) {
      throw new PatcherError(`${label} ends before its declared dot-code data`);
    }
    const interleavedValues = [];
    for (let index = 2; index < encodedEnd; index += 1) {
      if (index % 0x68 >= 2) {
        interleavedValues.push(raw[index]);
      }
    }
    const interleaved = Uint8Array.from(interleavedValues);
    if (interleaved.length !== codewordSize * columns) {
      throw new PatcherError(`${label} has an invalid interleaved data extent`);
    }

    const dataSize = codewordSize - paritySize;
    const decoded = new Uint8Array(dataSize * columns);
    let decodedOffset = 0;
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < dataSize; row += 1) {
        decoded[decodedOffset] = interleaved[row * columns + column];
        decodedOffset += 1;
      }
    }
    const expectedDecodedSize = appSize === RAW_LONG_BIN_SIZE ? 0x840 : 0x540;
    if (decoded.length !== expectedDecodedSize) {
      throw new PatcherError(`${label} decoded to an unexpected card size`);
    }
    if (!bytesEqual(decoded.subarray(0x1a, 0x22), asciiBytes("NINTENDO"))) {
      throw new PatcherError(`${label} is not Nintendo e-Reader dot-code data`);
    }

    const app = new Uint8Array(appSize);
    app[0] = decoded[0x0d];
    app[1] = decoded[0x0c];
    app[2] = decoded[0x11];
    app[3] = decoded[0x10];
    app.set(decoded.subarray(0x26, 0x2e), 4);
    app.set(decoded.subarray(0x30), 12);

    if (xorBytes(app.subarray(0, 12)) !== decoded[0x2e]) {
      throw new PatcherError(`${label} failed its card-header checksum`);
    }

    let checksumTotal = 0;
    for (let index = 12; index < app.length; index += 1) {
      checksumTotal += index & 1 ? app[index] : app[index] << 8;
    }
    const checksumOne = (~checksumTotal) & 0xffff;
    if (decoded[0x13] !== ((checksumOne >>> 8) & 0xff) || decoded[0x14] !== (checksumOne & 0xff)) {
      throw new PatcherError(`${label} failed its card-data checksum`);
    }

    checksumTotal = 0;
    for (let offset = 0; offset < 0x2f; offset += 1) {
      checksumTotal += decoded[offset];
    }
    for (let offset = 12; offset < app.length; offset += 0x30) {
      checksumTotal += xorBytes(app.subarray(offset, offset + 0x30));
    }
    const checksumTwo = (~checksumTotal) & 0xff;
    if (decoded[0x2f] !== checksumTwo) {
      throw new PatcherError(`${label} failed its global checksum`);
    }
    return {
      app,
      region: app[0] & 0x0f,
      cardType: ((decoded[3] & 1) << 4) | (app[1] >>> 4),
    };
  }

  function decodeRawDotcode(rawInput, label = "RAW input") {
    return decodeRawDotcodeDetails(rawInput, label).app;
  }

  function parseDecodedApplicationStrip(app, label, physicalCardType = null) {
    const header = app.subarray(0, 12);
    const region = header[0] & 0x0f;
    const cardType = physicalCardType === null ? header[1] >>> 4 : physicalCardType;
    if (![0, 1, 2].includes(region)) {
      throw new PatcherError(`${label} uses unsupported e-Reader region ${region}`);
    }
    if (!APPLICATION_CARD_TYPES.has(cardType)) {
      throw new PatcherError(`${label} is not an e-Reader application card`);
    }

    const cardCount = (header[4] >>> 5) | ((header[5] & 1) << 3);
    const cardIndex = (header[4] & 0x1e) >>> 1;
    const encodedTwice = (header[6] << 8) | (header[5] & 0xfe);
    if (!cardCount || cardIndex < 1 || cardIndex > cardCount) {
      throw new PatcherError(`${label} has an invalid card-set index`);
    }
    if (encodedTwice & 1) {
      throw new PatcherError(`${label} has an invalid application-data length`);
    }
    const encodedSize = encodedTwice / 2;

    const extendedApplicationHeader = (cardType & 0x0f) === 0x0e;
    const setTitleSize = extendedApplicationHeader ? 33 : 17;
    const cardTitleSize = header[8] & 0x02 ? 0 : extendedApplicationHeader ? 33 : 0x15;
    const payloadOffset = 12 + setTitleSize + cardTitleSize * cardCount;
    if (payloadOffset > app.length) {
      throw new PatcherError(`${label} has an invalid title area`);
    }

    const titleField = app.subarray(12, 12 + setTitleSize);
    const titleArea = app.subarray(12, payloadOffset);
    let embeddedTitleBytes = firstNull(titleField);
    let embeddedTitle;
    let saveTitleBytes;
    let titleEncoding;
    try {
      if (extendedApplicationHeader) {
        let decodedTitle = decodeExtendedTitleField(titleField, region, `${label} title`);
        if (!decodedTitle && cardType === 0x0e && cardTitleSize > 0) {
          const cardTitlesOffset = 12 + setTitleSize;
          for (let offset = 0; offset < cardTitleSize * cardCount; offset += cardTitleSize) {
            const cardTitleField = app.subarray(
              cardTitlesOffset + offset,
              cardTitlesOffset + offset + cardTitleSize,
            );
            decodedTitle = decodeExtendedTitleField(
              cardTitleField,
              region,
              `${label} card title`,
            );
            if (decodedTitle) {
              embeddedTitleBytes = firstNull(cardTitleField);
              break;
            }
          }
        }
        if (decodedTitle) {
          embeddedTitle = decodedTitle.title;
          saveTitleBytes = decodedTitle.saveTitleBytes;
          titleEncoding = decodedTitle.titleEncoding;
        } else {
          embeddedTitle = "";
          embeddedTitleBytes = new Uint8Array();
          saveTitleBytes = new Uint8Array();
          titleEncoding = "none";
        }
      } else if (region === 1) {
        embeddedTitle = decodeUsaTitle(embeddedTitleBytes, `${label} title`);
        saveTitleBytes = embeddedTitleBytes.slice();
        titleEncoding = embeddedTitleBytes.length === 0
          ? "none"
          : embeddedTitleBytes.every((value) => value >= 0x20 && value < 0x7f)
            ? "ASCII"
            : "e-Reader USA 1-byte";
      } else {
        embeddedTitle = decodeJapaneseShortTitle(embeddedTitleBytes, `${label} title`);
        saveTitleBytes = japaneseShortTitleToShiftJis(
          embeddedTitleBytes,
          `${label} title`,
        );
        titleEncoding = embeddedTitleBytes.length === 0
          ? "none"
          : "e-Reader Japanese 1-byte";
      }
    } catch (error) {
      if (error instanceof PatcherError) {
        throw error;
      }
      throw new PatcherError(`${label} has an invalid application title`);
    }
    if (embeddedTitleBytes.length >= 0x24) {
      throw new PatcherError("Application title is too long for the save record");
    }

    const headerTail = header.slice(7, 12);
    const setId = [
      header[0].toString(16).padStart(2, "0"),
      header[1].toString(16).padStart(2, "0"),
      cardType.toString(16).padStart(2, "0"),
      String(cardCount),
      String(encodedSize),
      bytesToHex(headerTail),
      bytesToHex(titleArea),
      String(payloadOffset),
    ].join(":");
    return {
      app,
      header: header.slice(),
      header0: header[0],
      header1: header[1],
      headerTail,
      region,
      cardType,
      cardCount,
      cardIndex,
      encodedSize,
      payloadOffset,
      titleArea: titleArea.slice(),
      embeddedTitle,
      embeddedTitleBytes: embeddedTitleBytes.slice(),
      saveTitleBytes,
      titleEncoding,
      setId,
    };
  }

  function inspectDecodedDotcode(decoded, label = "RAW input") {
    if (![0, 1, 2].includes(decoded.region)) {
      throw new PatcherError(`${label} uses unsupported e-Reader region ${decoded.region}`);
    }
    if (decoded.cardType >= 0x10 && decoded.cardType <= 0x1d) {
      let embeddedTitle = "";
      let viewerTitle;
      let titleEncoding;
      const compactTitleField = decoded.app.subarray(
        VIEWER_COMPACT_TITLE_OFFSET,
        VIEWER_COMPACT_TITLE_OFFSET + VIEWER_COMPACT_TITLE_SIZE,
      );
      if (decoded.region === 1) {
        viewerTitle = decodeUsaTitle(
          compactTitleField,
          `${label} Pokémon Viewer title`,
        );
        titleEncoding = viewerTitle ? "e-Reader USA 1-byte" : "none";
      } else {
        viewerTitle = decodeDirectJapaneseViewerTitle(decoded.app);
        if (viewerTitle !== null) {
          titleEncoding = "Shift-JIS";
        } else {
          viewerTitle = decodeJapaneseShortTitle(
            compactTitleField,
            `${label} Pokémon Viewer title`,
          );
          titleEncoding = viewerTitle ? "e-Reader Japanese 1-byte" : "none";
        }
      }
      embeddedTitle = viewerTitle ? `Pokémon Viewer: ${viewerTitle}` : "Pokémon Viewer";
      return Object.freeze({
        contentKind: "pokedex",
        region: decoded.region,
        cardType: decoded.cardType,
        cardCount: 1,
        cardIndex: 1,
        encodedSize: 0,
        payloadOffset: 12,
        embeddedTitle,
        embeddedTitleBytes: new Uint8Array(),
        titleEncoding,
        setId: `pokedex:${bytesToHex(decoded.app)}`,
      });
    }
    if (!APPLICATION_CARD_TYPES.has(decoded.cardType)) {
      if (!NATIVE_CARD_TYPES.has(decoded.cardType)) {
        throw new PatcherError(
          `${label} uses unsupported e-Reader card type 0x${decoded.cardType.toString(16).toUpperCase().padStart(2, "0")}`,
        );
      }
      const decodedTitle = decodeNativeTitle(decoded);
      const genericTitle = nativeTypeFallbackTitle(decoded.region, decoded.cardType);
      const embeddedTitle = decodedTitle
        ? decodedTitle.title
        : genericTitle
          ?? `Type 0x${decoded.cardType.toString(16).toUpperCase().padStart(2, "0")}`;
      return Object.freeze({
        contentKind: "native",
        region: decoded.region,
        cardType: decoded.cardType,
        cardCount: 1,
        cardIndex: 1,
        encodedSize: 0,
        payloadOffset: 12,
        embeddedTitle,
        embeddedTitleBytes: new Uint8Array(),
        titleEncoding: decodedTitle
          ? decodedTitle.titleEncoding
          : genericTitle
            ? "generic card-type name"
            : "none",
        setId: `native:${bytesToHex(decoded.app)}`,
      });
    }
    const parsed = parseDecodedApplicationStrip(
      decoded.app,
      label,
      decoded.cardType,
    );
    return Object.freeze({
      contentKind: "application",
      region: parsed.region,
      cardType: parsed.cardType,
      cardCount: parsed.cardCount,
      cardIndex: parsed.cardIndex,
      encodedSize: parsed.encodedSize,
      payloadOffset: parsed.payloadOffset,
      embeddedTitle: parsed.embeddedTitle,
      embeddedTitleBytes: parsed.embeddedTitleBytes,
      titleEncoding: parsed.titleEncoding,
      setId: parsed.setId,
    });
  }

  function inspectRawDotcode(rawInput, label = "RAW input") {
    return inspectDecodedDotcode(decodeRawDotcodeDetails(rawInput, label), label);
  }

  function normalizeRawFile(file, index) {
    if (!file || typeof file.name !== "string") {
      throw new TypeError(`RAW file ${index + 1} has no name`);
    }
    if (!/\.raw$/i.test(file.name)) {
      throw new PatcherError(`RAW source must have a .raw extension: ${file.name}`);
    }
    return {
      name: file.name,
      bytes: asBytes(file.bytes ?? file.data, file.name),
    };
  }

  function selectRawSet(rawFiles, selectedName = null) {
    const files = Array.from(rawFiles, normalizeRawFile);
    if (files.length === 0) {
      throw new PatcherError("No RAW strips were supplied");
    }

    const inspected = files.map((file) => ({
      ...file,
      metadata: inspectRawDotcode(file.bytes, file.name),
    }));
    const hasSelectedName = selectedName !== null
      && selectedName !== undefined
      && String(selectedName).length > 0;
    let selectedFile = inspected[0];
    if (hasSelectedName) {
      const normalizedSelectedName = String(selectedName)
        .replace(/^.*[\\/]/, "")
        .toLocaleLowerCase("en-US");
      selectedFile = inspected.find((file) => (
        file.name.replace(/^.*[\\/]/, "").toLocaleLowerCase("en-US")
          === normalizedSelectedName
      ));
      if (!selectedFile) {
        throw new PatcherError(`no RAW strip found for ${selectedName}`);
      }
    }

    const distinctSetIds = new Set(inspected.map((file) => file.metadata.setId));
    if (!hasSelectedName && distinctSetIds.size > 1) {
      throw new PatcherError(
        "multiple RAW content sets were selected; choose the strips for one content set only",
      );
    }
    return inspected
      .filter((file) => file.metadata.setId === selectedFile.metadata.setId)
      .sort((left, right) => (
        left.metadata.cardIndex - right.metadata.cardIndex
        || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      ))
      .map(({ name, bytes }) => ({ name, bytes }));
  }

  function applicationTitleForSave(parsed, fallbackTitle, label) {
    let titleBytes = parsed.saveTitleBytes.slice();
    let title = parsed.embeddedTitle;
    try {
      if (titleBytes.length === 0 && fallbackTitle) {
        title = String(fallbackTitle);
        if (title.includes("\0")) {
          throw new PatcherError("Application title must not contain a NUL character");
        }
        titleBytes = parsed.region === 1
          ? encodeUsaTitle(title)
          : encodeShiftJis(title);
      }
      if (!title && titleBytes.length > 0) {
        title = parsed.region === 1
          ? decodeUsaTitle(titleBytes, `${label} title`)
          : (parsed.cardType & 0x0f) === 0x0e
            ? decodeShiftJis(titleBytes, true)
            : decodeJapaneseShortTitle(parsed.embeddedTitleBytes, `${label} title`);
      }
    } catch (error) {
      if (error instanceof PatcherError) {
        throw error;
      }
      throw new PatcherError(`${label} has an invalid application title`);
    }
    if (!title) {
      title = UNTITLED_CONTENT_TITLE;
      titleBytes = parsed.region === 1
        ? encodeUsaTitle(title)
        : encodeShiftJis(title);
    }
    if (titleBytes.length >= 0x24) {
      throw new PatcherError("Application title is too long for the save record");
    }
    return { title, titleBytes };
  }

  function applicationPayloadFromEncoded(encoded, common) {
    let execution;
    if (common.header[8] & 0x04) {
      if (encoded.length < 6 || readU16LE(encoded, 0) !== encoded.length - 2) {
        throw new PatcherError("NES dot-code set has an invalid VPK length prefix");
      }
      if (![1, 2].includes(common.region)) {
        throw new PatcherError("Original-region Japanese NES cards are unsupported");
      }
      execution = PROGRAM_EXECUTION_NES;
    } else if (
      encoded.length >= 10
      && readU32LE(encoded, 0) === encoded.length - 6
      && encoded[4] === 0
      && encoded[5] === 0
    ) {
      execution = PROGRAM_EXECUTION_GBA;
    } else {
      if (encoded.length < 6 || readU16LE(encoded, 0) !== encoded.length - 2) {
        throw new PatcherError("Z80 dot-code set has an invalid VPK length prefix");
      }
      execution = PROGRAM_EXECUTION_Z80;
    }

    const { programType, prefixSize: savePrefixSize } = dotcodeSaveLayout(
      execution,
      dotcodeCardHeaderByte(common.header),
      common.region,
    );
    const dotcodePrefixSize = execution === PROGRAM_EXECUTION_GBA ? 6 : 2;
    const payload = encoded.slice(dotcodePrefixSize);
    if (payload.length > 0xffff) {
      throw new PatcherError("Application payload is too large for a saved-program record");
    }
    if (
      [PROGRAM_EXECUTION_Z80, PROGRAM_EXECUTION_NES].includes(execution)
      && !bytesEqual(payload.subarray(0, 4), asciiBytes("vpk0"))
    ) {
      throw new PatcherError("Dot-code application payload does not contain a vpk0 stream");
    }
    return { programType, savePrefixSize, payload };
  }

  function rawFilesToApplication(rawFiles, fallbackTitle = "") {
    const files = Array.from(rawFiles, normalizeRawFile);
    if (files.length === 0) {
      throw new PatcherError("No RAW strips were supplied");
    }

    const indexedPayloads = new Map();
    let common = null;

    for (const file of files) {
      const decoded = decodeRawDotcodeDetails(file.bytes, file.name);
      const parsed = parseDecodedApplicationStrip(
        decoded.app,
        file.name,
        decoded.cardType,
      );
      const { title, titleBytes } = applicationTitleForSave(
        parsed,
        fallbackTitle,
        file.name,
      );

      const candidate = {
        header0: parsed.header0,
        header1: parsed.header1,
        cardType: parsed.cardType,
        cardCount: parsed.cardCount,
        encodedSize: parsed.encodedSize,
        headerTail: parsed.headerTail,
        titleArea: parsed.titleArea,
        payloadOffset: parsed.payloadOffset,
        title,
        titleBytes: titleBytes.slice(),
        region: parsed.region,
        header: parsed.header,
      };
      if (!common) {
        common = candidate;
      } else if (
        candidate.header0 !== common.header0 ||
        candidate.header1 !== common.header1 ||
        candidate.cardType !== common.cardType ||
        candidate.cardCount !== common.cardCount ||
        candidate.encodedSize !== common.encodedSize ||
        candidate.payloadOffset !== common.payloadOffset ||
        !bytesEqual(candidate.headerTail, common.headerTail) ||
        !bytesEqual(candidate.titleArea, common.titleArea)
      ) {
        throw new PatcherError(`${file.name} belongs to a different dot-code application set`);
      }
      if (indexedPayloads.has(parsed.cardIndex)) {
        throw new PatcherError(`duplicate dot-code strip index ${parsed.cardIndex}`);
      }
      indexedPayloads.set(parsed.cardIndex, parsed.app.slice(parsed.payloadOffset));
    }

    const missing = [];
    for (let index = 1; index <= common.cardCount; index += 1) {
      if (!indexedPayloads.has(index)) {
        missing.push(index);
      }
    }
    if (missing.length > 0 || indexedPayloads.size !== common.cardCount) {
      throw new PatcherError(
        `dot-code application set is incomplete; missing strip index/indices: ${missing.join(", ")}`,
      );
    }

    const orderedPayloads = [];
    for (let index = 1; index <= common.cardCount; index += 1) {
      orderedPayloads.push(indexedPayloads.get(index));
    }
    let encoded = concatBytes(...orderedPayloads);
    if (common.encodedSize > encoded.length) {
      throw new PatcherError("Dot-code application set ends before its declared data");
    }
    encoded = encoded.slice(0, common.encodedSize);

    const { programType, savePrefixSize, payload } = applicationPayloadFromEncoded(
      encoded,
      common,
    );
    const payloadFormat = bytesEqual(payload.subarray(0, 4), asciiBytes("vpk0"))
      ? "VPK"
      : "RAW";
    return {
      title: common.title,
      titleBytes: common.titleBytes,
      region: common.region,
      programType,
      savePrefixSize,
      payload,
      payloadFormat,
      stripCount: files.length,
    };
  }

  function rawExportScanRegion(metadata, applicationRegionHint) {
    // The optional hint preserves known Japanese/Original provenance only
    // while converting an in-memory virtual SAV built from region-0 RAWs.
    if (
      applicationRegionHint !== null
      && applicationRegionHint !== undefined
      && !["usa", "japan"].includes(applicationRegionHint)
    ) {
      throw new PatcherError(`Unknown application region: ${applicationRegionHint}`);
    }
    if (metadata.storedRegionCode === JPN_SAVED_REGION_CODE) {
      if (applicationRegionHint === "usa") {
        throw new PatcherError("e-Reader+ application data requires the Japanese region");
      }
      return 2;
    }
    const resolvedRegion = applicationRegionHint ?? metadata.applicationRegion;
    if (resolvedRegion === "japan") {
      return 0;
    }
    return 1;
  }

  function saveToRawDotcodes(saveInput, applicationRegionHint = null) {
    const save = asBytes(saveInput, "save");
    const metadata = validateSave(save);
    if (metadata.titleBytes.length > 32) {
      throw new PatcherError(
        "Saved application title is too long for a generated type-E dot-code",
      );
    }
    if (metadata.extraSize !== 0) {
      throw new PatcherError(
        "Saved application contains extra record data that cannot be represented in RAW strips",
      );
    }
    if (!rawExportPreservesContent(metadata)) {
      throw new PatcherError(
        "This saved application uses a specialized loader variant that has no known downloadable dot-code equivalent",
      );
    }
    const cardHeaderByte = (
      metadata.programType >>> PROGRAM_TYPE_CARD_HEADER_SHIFT
    ) & 0xff;
    const region = rawExportScanRegion(metadata, applicationRegionHint);
    const dotcodeLayout = dotcodeSaveLayout(
      metadata.execution,
      cardHeaderByte,
      region,
    );

    const payload = validatedSavePayload(save, metadata);
    let encoded;
    if (metadata.execution === PROGRAM_EXECUTION_GBA) {
      const prefix = new Uint8Array(6);
      writeU32LE(prefix, 0, payload.length);
      encoded = concatBytes(prefix, payload);
    } else {
      const prefix = new Uint8Array(2);
      writeU16LE(prefix, 0, payload.length);
      encoded = concatBytes(prefix, payload);
    }

    const payloadOffset = 12 + 33;
    const capacity = RAW_LONG_BIN_SIZE - payloadOffset;
    const cardCount = Math.max(1, Math.ceil(encoded.length / capacity));
    if (cardCount > 12) {
      throw new PatcherError(
        `saved application needs ${cardCount} RAW strips; the e-Reader supports at most 12`,
      );
    }
    let flags = 0x03;
    if (metadata.execution === PROGRAM_EXECUTION_NES) {
      flags |= 0x04;
    }

    const raws = [];
    const cardType = cardHeaderByte & 0x80 ? 0x1e : 0x0e;
    for (let cardIndex = 1; cardIndex <= cardCount; cardIndex += 1) {
      const app = new Uint8Array(RAW_LONG_BIN_SIZE);
      writeU16LE(app, 0, 0xe000 | (cardHeaderByte << 4) | region);
      const sizeInfo = (
        0x02000000
        | (encoded.length << 9)
        | (cardCount << 5)
        | (cardIndex << 1)
      ) >>> 0;
      writeU32LE(app, 4, sizeInfo);
      writeU32LE(app, 8, flags);
      app.set(metadata.titleBytes, 12);
      const start = (cardIndex - 1) * capacity;
      app.set(encoded.subarray(start, start + capacity), payloadOffset);
      raws.push(encodeRawDotcode(app, cardType));
    }

    const application = rawFilesToApplication(
      raws.map((bytes, index) => ({ name: `generated RAW ${index + 1}.raw`, bytes })),
      metadata.title || "e-Reader application",
    );
    if (
      (metadata.title && application.title !== metadata.title)
      || application.programType !== dotcodeLayout.programType
      || application.savePrefixSize !== dotcodeLayout.prefixSize
      || !bytesEqual(application.payload, payload)
    ) {
      throw new Error("Generated RAW set changed the saved application");
    }
    return raws;
  }

  function buildVirtualSave(application) {
    if (!application || typeof application !== "object") {
      throw new TypeError("Application must be an application descriptor object");
    }
    const title = asBytes(application.titleBytes, "application title");
    if (application.payload === undefined) {
      throw new PatcherError("Application descriptor has no payload");
    }
    const payload = asBytes(application.payload, "application payload");
    if (!Number.isInteger(application.programType)
      || application.programType < 0
      || application.programType > 0xffffffff) {
      throw new PatcherError("Application program type must be an unsigned 32-bit integer");
    }
    if (title.length >= 0x24) {
      throw new PatcherError("Application title is too long for the save record");
    }
    if (title.includes(0)) {
      throw new PatcherError("Application title must not contain a NUL byte");
    }
    if (payload.length > 0xffff) {
      throw new PatcherError("Application payload is too large for the save record");
    }
    if (![2, 6].includes(application.savePrefixSize)) {
      throw new PatcherError("Unsupported saved-program prefix size");
    }

    const programSize = payload.length + application.savePrefixSize;
    const recordSize = 0x34 + programSize;
    if (recordSize > SAVED_RECORD_MAX_SIZE) {
      throw new PatcherError("Application is larger than the e-Reader ROM supports");
    }

    const save = new Uint8Array(SAVE_SIZE).fill(0xff);
    const record = new Uint8Array(recordSize).fill(0xff);
    record.fill(0, 4, 0x28);
    record.set(title, 4);
    writeU32LE(record, 0x28, application.programType);
    writeU32LE(record, 0x2c, programSize);
    writeU32LE(record, 0x30, 0);
    let payloadOffset;
    if (application.savePrefixSize === 2) {
      writeU16LE(record, 0x34, payload.length);
      payloadOffset = 0x36;
    } else {
      writeU32LE(record, 0x34, payload.length);
      record[0x38] = 0;
      record[0x39] = 0;
      payloadOffset = 0x3a;
    }
    record.set(payload, payloadOffset);

    const crcLength = 0x30 + programSize;
    const crc = (~crc32(record.subarray(4, 4 + crcLength), 0x55b87bdd)) >>> 0;
    writeU32LE(record, 0, crc);
    writeSavedRecord(save, record);
    validateSave(save);
    return save;
  }

  function encodeSaveApplicationTitle(title, applicationRegion) {
    if (typeof title !== "string") {
      throw new TypeError("Application title must be a string");
    }
    if (!["usa", "japan"].includes(applicationRegion)) {
      throw new PatcherError(`Unknown application region: ${applicationRegion}`);
    }
    if (title.includes("\0")) {
      throw new PatcherError("Application title must not contain a NUL character");
    }
    const encoded = applicationRegion === "usa"
      ? encodeUsaTitle(title, "Application title")
      : encodeShiftJis(japaneseApplicationTitle(title), "Application title");
    if (encoded.length >= 0x24) {
      throw new PatcherError(
        "Application title is too long; the encoded title must be at most 35 bytes",
      );
    }
    return encoded;
  }

  function setSaveApplicationTitle(saveInput, title, applicationRegionHint = null) {
    const save = asBytes(saveInput, "save");
    const metadata = validateSave(save);
    if (
      applicationRegionHint !== null
      && !["usa", "japan"].includes(applicationRegionHint)
    ) {
      throw new PatcherError(`Unknown application region: ${applicationRegionHint}`);
    }
    if (
      metadata.storedRegionCode === JPN_SAVED_REGION_CODE
      && applicationRegionHint === "usa"
    ) {
      throw new PatcherError("e-Reader+ application titles require Japanese encoding");
    }
    const applicationRegion = applicationRegionHint ?? metadata.applicationRegion;
    const titleBytes = encodeSaveApplicationTitle(title, applicationRegion);
    const record = savedRecordBytes(save, metadata.recordSize);
    record.fill(0, 4, 0x28);
    record.set(titleBytes, 4);
    const crcLength = 0x30 + metadata.programSize + metadata.extraSize;
    const crc = (~crc32(record.subarray(4, 4 + crcLength), 0x55b87bdd)) >>> 0;
    writeU32LE(record, 0, crc);

    const updated = Uint8Array.from(save);
    writeSavedRecord(updated, record);
    validateSave(updated);
    return updated;
  }

  function applyCheckedPatch(rom, patch) {
    const actual = rom.subarray(patch.offset, patch.offset + patch.expected.length);
    if (!bytesEqual(actual, patch.expected)) {
      throw new PatcherError(
        `Unexpected bytes at ROM offset 0x${patch.offset.toString(16).toUpperCase()} for '${patch.description}': ${bytesToHex(actual, " ")}`,
      );
    }
    if (patch.expected.length !== patch.replacement.length) {
      throw new Error("In-place patch changes length");
    }
    rom.set(patch.replacement, patch.offset);
  }

  function mappedSaveRead(romInput, sector, offset, size) {
    const rom = asBytes(romInput, "ROM");
    const logicalSector = sector & 0x1f;
    const bankOffset = logicalSector & 0x10
      ? ROM_BANK1_OFFSET
      : ROM_BANK0_OFFSET;
    const start = bankOffset + (logicalSector & 0x0f) * 0x1000 + offset;
    return rom.slice(start, start + size);
  }

  function importedSaveImage(save, recordSize) {
    const imported = new Uint8Array(SAVE_SIZE).fill(0xff);
    imported.set(
      save.subarray(SAVED_RECORD_START, SAV_BANK1_IMPORT_END),
      SAVED_RECORD_START,
    );
    const overflowSize = Math.max(0, recordSize - SAVED_RECORD_PRIMARY_SIZE);
    imported.set(save.subarray(0, overflowSize), 0);
    return imported;
  }

  function embedSaveImage(patched, save) {
    patched.set(save.subarray(SAVE_BANK_SIZE), ROM_BANK1_OFFSET);
    patched.set(save.subarray(0, SAVE_BANK_SIZE), ROM_BANK0_OFFSET);
  }

  function thumbBl(sourceAddress, targetAddress) {
    const offset = targetAddress - (sourceAddress + 4);
    if ((offset & 1) !== 0 || offset < -(1 << 22) || offset >= (1 << 22)) {
      throw new PatcherError("Thumb BL target is out of range or misaligned");
    }
    const encoded = offset & 0x7fffff;
    const result = new Uint8Array(4);
    writeU16LE(result, 0, 0xf000 | ((encoded >>> 12) & 0x07ff));
    writeU16LE(result, 2, 0xf800 | ((encoded >>> 1) & 0x07ff));
    return result;
  }

  function appendBytes(target, source) {
    target.push(...asBytes(source));
  }

  function appendU16(target, value) {
    target.push(value & 0xff, (value >>> 8) & 0xff);
  }

  function appendU32(target, value) {
    target.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  function padBytes(target, length) {
    if (target.length > length) {
      throw new Error("Native-card bootstrap layout overlaps its next routine");
    }
    while (target.length < length) {
      target.push(0xff);
    }
  }

  function nativeCardBootStub(profile, shortStrip) {
    const stubAddress = 0x08000000 + profile.stubOffset;
    const readerRelativeOffset = 0x70;
    const irqRestoreRelativeOffset = 0xe0;
    const scanResetRelativeOffset = 0x110;
    const nativeContextRelativeOffset = 0x130;
    const boot = [];

    const bootTargets = [
      stubAddress + readerRelativeOffset,
      stubAddress + nativeContextRelativeOffset,
      profile.scanOverlayRestoreAddress,
      stubAddress + scanResetRelativeOffset,
      stubAddress + irqRestoreRelativeOffset,
    ];
    for (const target of bootTargets) {
      appendBytes(boot, thumbBl(stubAddress + boot.length, target));
    }
    appendBytes(
      boot,
      bytesFromHex(
        "04 49 08 88 02 30 04 28 00 D3 01 38 02 49 08 60 02 48 00 47",
      ),
    );
    appendU32(boot, profile.formatAddress - 2);
    appendU32(boot, profile.outerStateAddress);
    appendU32(boot, profile.frameDispatchAddress);

    padBytes(boot, readerRelativeOffset);
    const readerAddress = stubAddress + readerRelativeOffset;
    const reader = [];
    appendU16(reader, 0xb5f0);
    appendU16(reader, 0x2001);
    appendBytes(reader, thumbBl(readerAddress + reader.length, profile.scanPrepareAddress));
    appendBytes(reader, thumbBl(readerAddress + reader.length, profile.scanSetupAddress));
    appendU16(reader, 0x4d10);
    appendU16(reader, shortStrip ? 0x2601 : 0x2600);
    appendU16(reader, 0x802e);
    appendU16(reader, 0x4c10);
    appendU16(reader, 0x4d10);
    appendU16(reader, 0x260c);
    appendBytes(reader, bytesFromHex("27 68 2F 60 04 34 04 35 04 3E F9 D1"));
    appendU16(reader, 0x4d0d);
    appendU16(reader, 0x4e0e);
    appendBytes(reader, bytesFromHex("27 68 2F 60 04 34 04 35 04 3E F9 D1"));
    appendU16(reader, 0x4c0b);
    appendU16(reader, 0x4d0c);
    appendU16(reader, 0x260c);
    appendBytes(reader, bytesFromHex("27 68 2F 60 04 34 04 35 04 3E F9 D1"));
    appendBytes(reader, thumbBl(readerAddress + reader.length, profile.parserAddress));
    appendBytes(reader, bytesFromHex("00 20 F0 BD C0 46"));
    if (reader.length !== 0x50) {
      throw new Error("Native-card reader routine layout changed");
    }
    for (const value of [
      profile.formatAddress,
      0x08000000 + NATIVE_CARD_DATA_OFFSET,
      profile.headerAddress,
      profile.payloadAddress,
      RAW_LONG_BIN_SIZE - 12,
      0x08000000 + NATIVE_CARD_DATA_OFFSET + RAW_LONG_BIN_SIZE,
      profile.validationHeaderAddress,
    ]) {
      appendU32(reader, value);
    }
    appendBytes(boot, Uint8Array.from(reader));

    padBytes(boot, irqRestoreRelativeOffset);
    appendBytes(
      boot,
      bytesFromHex(
        "07 4B 00 20 18 80 07 4A 10 88 01 21 08 43 10 80 "
          + "05 4A 10 88 08 21 08 43 10 80 01 20 18 80 70 47",
      ),
    );
    appendU32(boot, 0x04000208);
    appendU32(boot, 0x04000200);
    appendU32(boot, 0x04000004);

    padBytes(boot, scanResetRelativeOffset);
    appendU16(boot, 0xb500);
    for (const target of profile.scanResetAddresses) {
      appendBytes(boot, thumbBl(stubAddress + boot.length, target));
    }
    appendU16(boot, 0xbd00);

    padBytes(boot, nativeContextRelativeOffset);
    appendBytes(
      boot,
      bytesFromHex(
        "05 48 06 49 01 60 00 21 41 60 05 49 81 60 01 21 C1 60 "
          + "70 47 C0 46 C0 46",
      ),
    );
    appendU32(boot, profile.nativeContextAddress);
    appendU32(boot, 0x00030000);
    appendU32(boot, 0x000c0000);
    return Uint8Array.from(boot);
  }

  function nativeCardRecord(decoded) {
    const app = decoded.app;
    if (![RAW_SHORT_BIN_SIZE, RAW_LONG_BIN_SIZE].includes(app.length)) {
      throw new PatcherError("Native card has an unsupported logical data size");
    }
    const record = new Uint8Array(RAW_LONG_BIN_SIZE + 12);
    record.set(app.subarray(2, 4), 0);
    record.set(app.subarray(0, 2), 2);
    record.set(app.subarray(4, 12), 4);
    record.set(app.subarray(12), 12);
    record.set(app.subarray(0, 12), RAW_LONG_BIN_SIZE);
    return record;
  }

  function nativeSupportSave(region) {
    const isJpn = region !== 1;
    const supportLayout = dotcodeSaveLayout(
      isJpn ? PROGRAM_EXECUTION_GBA : PROGRAM_EXECUTION_Z80,
      0,
      region,
    );
    return buildVirtualSave({
      title: "Native card",
      titleBytes: asciiBytes("Native card"),
      region,
      programType: supportLayout.programType,
      savePrefixSize: supportLayout.prefixSize,
      payload: isJpn ? new Uint8Array([0, 0]) : asciiBytes("vpk0\0\0\0\0"),
      stripCount: 0,
    });
  }

  function finalizeRomHeaderAndReadStub(patched, profile) {
    if (!(patched instanceof Uint8Array) || patched.length !== ROM_SIZE) {
      throw new Error("ROM finalizer requires one complete writable base-ROM copy");
    }
    if (STANDALONE_ROM_TITLE.length !== ROM_TITLE_SIZE) {
      throw new Error(`standalone ROM title must occupy exactly ${ROM_TITLE_SIZE} bytes`);
    }

    const expectedMarker = asciiBytes("ROMONLY_V103");
    if (!bytesEqual(
      patched.subarray(profile.saveMarkerOffset, profile.saveMarkerOffset + expectedMarker.length),
      expectedMarker,
    )) {
      throw new Error("Patched ROM still advertises cartridge FLASH storage");
    }

    const readStubEnd = READ_STUB_OFFSET + READ_STUB.length;
    if (readStubEnd > ROM_BANK1_OFFSET) {
      throw new Error("Thumb read-stub overlaps the content area");
    }
    if (!patched.subarray(READ_STUB_OFFSET, readStubEnd).every((value) => value === 0xff)) {
      throw new PatcherError("Thumb read-stub location is not free");
    }
    if (!bytesEqual(
      patched.subarray(GAME_CODE_OFFSET, GAME_CODE_OFFSET + profile.privateGameCode.length),
      profile.privateGameCode,
    )) {
      throw new Error("Patched ROM does not contain the private standalone game code");
    }

    patched.set(STANDALONE_ROM_TITLE, ROM_TITLE_OFFSET);
    let headerSum = 0;
    for (let offset = 0xa0; offset < 0xbd; offset += 1) {
      headerSum += patched[offset];
    }
    patched[HEADER_CHECKSUM_OFFSET] = (-headerSum - 0x19) & 0xff;
    patched.set(READ_STUB, READ_STUB_OFFSET);
    return decodeAscii(firstNull(patched.subarray(
      ROM_TITLE_OFFSET,
      ROM_TITLE_OFFSET + ROM_TITLE_SIZE,
    )));
  }

  async function buildNativeDotcodeRom(romInput, rawInput, label = "RAW input") {
    const rom = asBytes(romInput, "ROM");
    const raw = asBytes(rawInput, label);
    const profile = await validatedRomProfile(rom);
    const nativeProfile = NATIVE_CARD_PROFILES[profile.key];
    const decoded = decodeRawDotcodeDetails(raw, label);
    const inspected = inspectDecodedDotcode(decoded, label);
    if (inspected.contentKind === "application") {
      throw new PatcherError(
        "application cards must be assembled as a complete set",
      );
    }
    const contentRegion = decoded.region === 1 ? "usa" : "japan";
    if (profile.key !== contentRegion) {
      const requiredName = contentRegion === "usa"
        ? USA_ROM_PROFILE.name
        : JPN_ROM_PROFILE.name;
      const contentRegionLabel = contentRegion === "usa" ? "English" : "Japanese";
      throw new PatcherError(
        `${contentRegionLabel} dot-code content requires the ${requiredName} base ROM`,
      );
    }

    const patched = rom.slice();
    for (const patch of profile.patches) {
      if (
        patch.offset !== nativeProfile.bootOffset
        && patch.offset !== nativeProfile.returnPatchOffset
      ) {
        applyCheckedPatch(patched, patch);
      }
    }

    const stub = nativeCardBootStub(
      nativeProfile,
      decoded.app.length === RAW_SHORT_BIN_SIZE,
    );
    const stubEnd = nativeProfile.stubOffset + stub.length;
    if (!patched.subarray(nativeProfile.stubOffset, stubEnd).every((value) => value === 0xff)) {
      throw new PatcherError("Native-card bootstrap location is not free");
    }
    patched.set(stub, nativeProfile.stubOffset);
    applyCheckedPatch(
      patched,
      binaryPatch(
        nativeProfile.bootOffset,
        nativeProfile.bootExpected,
        thumbBl(0x08000000 + nativeProfile.bootOffset, 0x08000000 + nativeProfile.stubOffset),
        "start the embedded card through the native dot-code dispatcher",
      ),
    );
    if (inspected.contentKind === "pokedex") {
      // B normally changes the viewer's inner state to 7, fades out, and
      // returns to front-end state 12. Keep the displayed entry unchanged.
      applyCheckedPatch(
        patched,
        binaryPatch(
          nativeProfile.viewerExitOffset,
          nativeProfile.viewerExitExpected,
          bytesFromHex("00 46"),
          "ignore the Pokémon Viewer's return-to-menu transition",
        ),
      );
    }
    // All native handlers eventually return through front-end state 12. A
    // BIOS SoftReset restarts the patched ROM without inheriting handler UI
    // state. The trailing self-branch fails closed if SWI 0 ever returns.
    applyCheckedPatch(
      patched,
      binaryPatch(
        nativeProfile.mainMenuOffset,
        nativeProfile.mainMenuExpected,
        bytesFromHex("00 DF FE E7"),
        "soft-reset native content instead of entering the main menu",
      ),
    );

    const supportSave = nativeSupportSave(decoded.region);
    embedSaveImage(
      patched,
      importedSaveImage(supportSave, validateSave(supportSave).recordSize),
    );
    patched.set(nativeCardRecord(decoded), NATIVE_CARD_DATA_OFFSET);

    const title = inspected.embeddedTitle;
    const romTitle = finalizeRomHeaderAndReadStub(patched, profile);
    if (!patched.subarray(NATIVE_CARD_DATA_END).every((value) => value === 0xff)) {
      throw new Error("Generated ROM contains data after the native card");
    }

    return {
      rom: patched,
      metadata: {
        ...inspected,
        title,
        sourceKind: "RAW",
        romProfile: profile.key,
        romName: profile.name,
        romTitle,
        gameCode: decodeAscii(profile.privateGameCode),
      },
    };
  }

  async function buildPatchedRom(romInput, saveInput, applicationRegionHint = null) {
    const rom = asBytes(romInput, "ROM");
    const save = asBytes(saveInput, "save");
    const profile = await validatedRomProfile(rom);
    const metadata = validateSave(save);
    const detectedRegion = metadata.applicationRegion;
    if (applicationRegionHint !== null && !["usa", "japan"].includes(applicationRegionHint)) {
      throw new PatcherError(`Unknown application region: ${applicationRegionHint}`);
    }
    if (
      metadata.storedRegionCode === JPN_SAVED_REGION_CODE
      && applicationRegionHint === "usa"
    ) {
      throw new PatcherError("e-Reader+ application data requires the Japanese base ROM");
    }
    const applicationRegion = applicationRegionHint ?? detectedRegion;
    if (profile.key !== applicationRegion) {
      const requiredName =
        applicationRegion === "japan" ? JPN_ROM_PROFILE.name : USA_ROM_PROFILE.name;
      const applicationRegionLabel =
        applicationRegion === "japan" ? "Japanese" : "English";
      throw new PatcherError(
        `${applicationRegionLabel} application '${metadata.title}' requires the ${requiredName} base ROM`,
      );
    }
    metadata.applicationRegion = applicationRegion;
    metadata.romProfile = profile.key;
    metadata.romName = profile.name;
    const patched = rom.slice();

    const importedSave = importedSaveImage(save, metadata.recordSize);
    embedSaveImage(patched, importedSave);

    for (const patch of profile.patches) {
      applyCheckedPatch(patched, patch);
    }

    metadata.romTitle = finalizeRomHeaderAndReadStub(patched, profile);
    metadata.gameCode = decodeAscii(profile.privateGameCode);

    for (let sector = 0; sector < 32; sector += 1) {
      const embedded = mappedSaveRead(patched, sector, 0, 0x1000);
      const expected = importedSave.subarray(sector * 0x1000, (sector + 1) * 0x1000);
      if (!bytesEqual(embedded, expected)) {
        throw new Error(`embedded save mapping failed for sector ${sector}`);
      }
    }

    const embeddedRecord = savedRecordBytes(importedSave, metadata.recordSize);
    const payloadStart = metadata.payloadOffset;
    const payloadEnd = payloadStart + metadata.payloadSize;
    const expectedPayload = validatedSavePayload(save, metadata);
    if (!bytesEqual(embeddedRecord.subarray(payloadStart, payloadEnd), expectedPayload)) {
      throw new Error("Saved-program payload is not present in the ROM-backed save");
    }
    for (let offset = ROM_SAVE_IMAGE_END; offset < patched.length; offset += 1) {
      if (patched[offset] !== 0xff) {
        throw new Error("Generated ROM contains data after the content area");
      }
    }
    return { rom: patched, metadata };
  }

  const constants = Object.freeze({
    ROM_SIZE,
    SAVE_SIZE,
    SAVE_BANK_SIZE,
    CALIBRATION_SECTOR_SIZE,
    CALIBRATION_PRIMARY_OFFSET,
    CALIBRATION_SECONDARY_OFFSET,
    SAVED_RECORD_START,
    SAVED_RECORD_PRIMARY_SIZE,
    SAVED_RECORD_MAX_SIZE,
    SAV_BANK1_IMPORT_END,
    EXPECTED_USA_ROM_SHA256,
    EXPECTED_JPN_ROM_SHA256,
    ROM_BANK1_OFFSET,
    ROM_BANK0_OFFSET,
    ROM_SAVE_IMAGE_END,
    NATIVE_CARD_DATA_OFFSET,
    NATIVE_CARD_DATA_END,
    READ_STUB_OFFSET,
    READ_STUB_ADDRESS,
    ROM_TITLE_OFFSET,
    ROM_TITLE_SIZE,
    GAME_CODE_OFFSET,
    HEADER_CHECKSUM_OFFSET,
    USA_ERASE_MENU_BYPASS_OFFSET,
    JPN_ERASE_MENU_BYPASS_OFFSET,
    RAW_LONG_SIZE,
    RAW_SHORT_SIZE,
    RAW_LONG_BIN_SIZE,
    RAW_SHORT_BIN_SIZE,
    PROGRAM_TYPE_DISPATCH_MASK,
    PROGRAM_TYPE_CARD_HEADER_SHIFT,
    PROGRAM_TYPE_STORED_REGION_SHIFT,
    PROGRAM_TYPE_STORED_REGION_MASK,
  });

  return Object.freeze({
    PatcherError,
    constants,
    profiles: PUBLIC_ROM_PROFILES,
    patches: PUBLIC_PATCHES,
    readStub: PUBLIC_READ_STUB,
    asBytes,
    bytesEqual,
    bytesToHex,
    sha256,
    crc32,
    validateRom,
    validateSave,
    extractSaveCalibration,
    applySaveCalibration,
    extractSavePayload,
    decodeJapaneseShortTitle,
    japaneseShortTitleToShiftJis,
    decodeRawDotcode,
    inspectRawDotcode,
    encodeRawDotcode,
    selectRawSet,
    rawFilesToApplication,
    saveToRawDotcodes,
    buildVirtualSave,
    setSaveApplicationTitle,
    applyCheckedPatch,
    mappedSaveRead,
    buildNativeDotcodeRom,
    buildPatchedRom,
  });
});
