(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./binary.js"));
  } else {
    root.EReaderCardConstants = factory(root.EReaderBinary);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary) {
  "use strict";

  const SAVE_SIZE = 0x20000;

  const CALIBRATION_SECTOR_SIZE = 0x1000;

  const CALIBRATION_PRIMARY_OFFSET = 0xd000;

  const CALIBRATION_SECONDARY_OFFSET = 0xe000;

  const SAVED_RECORD_START = 0x10000;

  const SAVED_RECORD_PRIMARY_SIZE = 0xf000;

  const SAVED_RECORD_MAX_SIZE = 0x15ffc;

  const UNTITLED_CONTENT_TITLE = "Untitled";

  const PROGRAM_TYPE_DISPATCH_MASK = 0xff;

  const PROGRAM_TYPE_CARD_HEADER_SHIFT = 8;

  const PROGRAM_TYPE_STORED_REGION_SHIFT = 16;

  const PROGRAM_TYPE_STORED_REGION_MASK = 0xff << PROGRAM_TYPE_STORED_REGION_SHIFT;

  const JPN_SAVED_REGION_CODE = 2;

  const PROGRAM_EXECUTION_Z80 = "z80";

  const PROGRAM_EXECUTION_GBA = "gba";

  const PROGRAM_EXECUTION_NES = "nes";

  return Object.freeze({
    SAVE_SIZE,
    CALIBRATION_SECTOR_SIZE,
    CALIBRATION_PRIMARY_OFFSET,
    CALIBRATION_SECONDARY_OFFSET,
    SAVED_RECORD_START,
    SAVED_RECORD_PRIMARY_SIZE,
    SAVED_RECORD_MAX_SIZE,
    UNTITLED_CONTENT_TITLE,
    PROGRAM_TYPE_DISPATCH_MASK,
    PROGRAM_TYPE_CARD_HEADER_SHIFT,
    PROGRAM_TYPE_STORED_REGION_SHIFT,
    PROGRAM_TYPE_STORED_REGION_MASK,
    JPN_SAVED_REGION_CODE,
    PROGRAM_EXECUTION_Z80,
    PROGRAM_EXECUTION_GBA,
    PROGRAM_EXECUTION_NES,
  });
});
