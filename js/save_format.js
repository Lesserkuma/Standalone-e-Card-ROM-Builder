(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./binary.js"),
      require("./card_constants.js"),
      require("./title_codec.js"),
    );
  } else {
    root.EReaderSaveFormat = factory(
      root.EReaderBinary,
      root.EReaderCardConstants,
      root.EReaderTitleCodec,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (binary, constants, titleModule) {
    "use strict";

    const { asBytes, asciiBytes, bytesEqual, readU16LE, readU32LE, writeU16LE, writeU32LE, crc32 } =
      binary;
    const {
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
    } = constants;

    function createSaveFormat(ErrorType = Error, titles = titleModule.createTitleCodec(ErrorType)) {
      const {
        firstNull,
        decodeAscii,
        decodeShiftJis,
        decodeUsaTitle,
        encodeUsaTitle,
        encodeShiftJis,
        japaneseApplicationTitle,
      } = titles;

      const CALIBRATION_MAGIC = asciiBytes("Card-E Reader 2001\0\0");

      const USA_SAVED_REGION_CODE = 0;

      const PROGRAM_TYPE_DIRECT_GBA_MASK = 0x06;

      const PROGRAM_TYPE_DIRECT_GBA_VALUE = 0x02;

      const PROGRAM_TYPE_SCANNED_GBA_VALUE = 0x06;

      const PROGRAM_TYPE_NES_FLAG = 0x08;

      const PROGRAM_LOADER_APPLICATION = "application";

      const PROGRAM_LOADER_DIRECT_GBA = "direct-gba";

      const PROGRAM_LOADER_NES = "nes";

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
            if (!(error instanceof ErrorType)) {
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
          if (error instanceof ErrorType) {
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
          throw new ErrorType("Saved-program record size is outside the ROM-supported range");
        }
        const primarySize = Math.min(size, SAVED_RECORD_PRIMARY_SIZE);
        const record = new Uint8Array(size);
        record.set(save.subarray(SAVED_RECORD_START, SAVED_RECORD_START + primarySize));
        record.set(save.subarray(0, size - primarySize), primarySize);
        return record;
      }

      function writeSavedRecord(save, record) {
        if (record.length > SAVED_RECORD_MAX_SIZE) {
          throw new ErrorType("Saved-program record is larger than the ROM supports");
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
          programSize >= 6 &&
          readU32LE(program, 0) + 6 === programSize &&
          program[4] === 0 &&
          program[5] === 0
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
          (payload[7] | (payload[6] << 8) | (payload[5] << 16) | (payload[4] * 0x1000000)) >>> 0
        );
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
          throw new ErrorType("Program-type dispatch byte is outside the byte range");
        }
        if (!Number.isInteger(cardHeaderByte) || cardHeaderByte < 0 || cardHeaderByte > 0xff) {
          throw new ErrorType("Card-header byte is outside the byte range");
        }
        if (
          !Number.isInteger(storedRegionCode) ||
          storedRegionCode < 0 ||
          storedRegionCode > 0xff
        ) {
          throw new ErrorType("Stored program-type region code is outside the byte range");
        }
        return (
          (dispatchByte |
            (cardHeaderByte << PROGRAM_TYPE_CARD_HEADER_SHIFT) |
            (storedRegionCode << PROGRAM_TYPE_STORED_REGION_SHIFT)) >>>
          0
        );
      }

      function storedDotcodeRegionCode(scanRegion) {
        if (![0, 1, 2].includes(scanRegion)) {
          throw new ErrorType(`Unsupported e-Reader scan region: ${scanRegion}`);
        }
        return scanRegion === 2 ? JPN_SAVED_REGION_CODE : USA_SAVED_REGION_CODE;
      }

      function dotcodeCardHeaderByte(header) {
        if (header.length < 2) {
          throw new ErrorType("Dot-code application header is too short");
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
          dispatchByte === undefined ||
          cardHeaderByte === undefined ||
          prefixSize === undefined
        ) {
          throw new ErrorType(`Unknown dot-code execution family: ${execution}`);
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
        const storedRegionCode =
          (metadata.programType & PROGRAM_TYPE_STORED_REGION_MASK) >>>
          PROGRAM_TYPE_STORED_REGION_SHIFT;
        if (
          (metadata.programType & 0xff000000) === 0 &&
          [USA_SAVED_REGION_CODE, JPN_SAVED_REGION_CODE].includes(storedRegionCode) &&
          typeByte === DOTCODE_PROGRAM_DISPATCH_BYTES[metadata.execution] &&
          metadata.prefixSize === DOTCODE_SAVE_PREFIX_SIZES[metadata.execution]
        ) {
          return true;
        }
        if (metadata.execution !== PROGRAM_EXECUTION_GBA) {
          return false;
        }
        return (
          (typeByte === DOTCODE_PROGRAM_DISPATCH_BYTES[PROGRAM_EXECUTION_GBA] &&
            metadata.prefixSize === 6) ||
          (typeByte === PROGRAM_TYPE_DIRECT_GBA_VALUE &&
            metadata.prefixSize === 2 &&
            metadata.payloadFormat === "VPK")
        );
      }

      function parseSave(saveInput) {
        const save = asBytes(saveInput, "save");
        if (save.length !== SAVE_SIZE) {
          throw new ErrorType(
            `save size is 0x${save.length.toString(16).toUpperCase()}; expected 0x${SAVE_SIZE.toString(16).toUpperCase()}`,
          );
        }

        const header = save.subarray(SAVED_RECORD_START, SAVED_RECORD_START + 0x34);
        if (header[4] === 0xff) {
          throw new ErrorType("Save data contains no saved application");
        }

        const programType = readU32LE(header, 0x28);
        const programSize = readU32LE(header, 0x2c);
        const extraSize = readU32LE(header, 0x30);

        const recordSize = 0x34 + programSize + extraSize;
        if (recordSize > SAVED_RECORD_MAX_SIZE) {
          throw new ErrorType(
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
        const calculatedCrc = ~crc32(record.subarray(4, 4 + crcLength), 0x55b87bdd) >>> 0;
        if (calculatedCrc !== storedCrc) {
          throw new ErrorType(
            `saved-program CRC mismatch: stored 0x${storedCrc.toString(16).toUpperCase().padStart(8, "0")}, calculated 0x${calculatedCrc.toString(16).toUpperCase().padStart(8, "0")}`,
          );
        }

        const rawSize = savedPayloadRawSize(payload, payloadFormat);
        const storedRegionCode =
          (programType & PROGRAM_TYPE_STORED_REGION_MASK) >>> PROGRAM_TYPE_STORED_REGION_SHIFT;
        let applicationRegion;
        if (storedRegionCode === USA_SAVED_REGION_CODE) {
          applicationRegion = "usa";
        } else if (storedRegionCode === JPN_SAVED_REGION_CODE) {
          applicationRegion = "japan";
        } else {
          throw new ErrorType(
            `Saved application uses unsupported region code 0x${storedRegionCode.toString(16).toUpperCase().padStart(2, "0")}`,
          );
        }
        const { title, titleBytes, titleEncoding } = decodeSavedApplicationTitle(
          record,
          applicationRegion,
        );
        if (titleEncoding.startsWith("Shift-JIS")) {
          applicationRegion = "japan";
        }
        const execution = savedProgramExecution(programType);
        const metadata = {
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
        return { metadata, record, payload };
      }

      function validateSave(saveInput) {
        return parseSave(saveInput).metadata;
      }

      function isValidSaveCalibrationSector(sectorInput) {
        const sector = asBytes(sectorInput, "calibration sector");
        if (
          sector.length !== CALIBRATION_SECTOR_SIZE ||
          !bytesEqual(sector.subarray(0, CALIBRATION_MAGIC.length), CALIBRATION_MAGIC)
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
          throw new ErrorType(
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

        throw new ErrorType("Save data contains no valid e-Reader calibration data");
      }

      function applySaveCalibration(targetSaveInput, calibrationSectorInput) {
        const targetSave = asBytes(targetSaveInput, "target save");
        if (targetSave.length !== SAVE_SIZE) {
          throw new ErrorType(
            `target save size is 0x${targetSave.length.toString(16).toUpperCase()}; expected 0x${SAVE_SIZE.toString(16).toUpperCase()}`,
          );
        }

        const calibrationSector = asBytes(calibrationSectorInput, "calibration sector");
        if (calibrationSector.length !== CALIBRATION_SECTOR_SIZE) {
          throw new ErrorType(
            `calibration sector size is 0x${calibrationSector.length.toString(16).toUpperCase()}; expected 0x${CALIBRATION_SECTOR_SIZE.toString(16).toUpperCase()}`,
          );
        }
        if (!isValidSaveCalibrationSector(calibrationSector)) {
          throw new ErrorType("Calibration sector is not valid e-Reader calibration data");
        }

        const result = Uint8Array.from(targetSave);
        result.set(calibrationSector, CALIBRATION_PRIMARY_OFFSET);
        result.set(calibrationSector, CALIBRATION_SECONDARY_OFFSET);
        return result;
      }

      function extractSavePayload(saveInput) {
        return Uint8Array.from(parseSave(saveInput).payload);
      }

      function buildVirtualSave(application) {
        if (!application || typeof application !== "object") {
          throw new TypeError("Application must be an application descriptor object");
        }
        const title = asBytes(application.titleBytes, "application title");
        if (application.payload === undefined) {
          throw new ErrorType("Application descriptor has no payload");
        }
        const payload = asBytes(application.payload, "application payload");
        if (
          !Number.isInteger(application.programType) ||
          application.programType < 0 ||
          application.programType > 0xffffffff
        ) {
          throw new ErrorType("Application program type must be an unsigned 32-bit integer");
        }
        if (title.length >= 0x24) {
          throw new ErrorType("Application title is too long for the save record");
        }
        if (title.includes(0)) {
          throw new ErrorType("Application title must not contain a NUL byte");
        }
        if (payload.length > 0xffff) {
          throw new ErrorType("Application payload is too large for the save record");
        }
        if (![2, 6].includes(application.savePrefixSize)) {
          throw new ErrorType("Unsupported saved-program prefix size");
        }

        const programSize = payload.length + application.savePrefixSize;
        const recordSize = 0x34 + programSize;
        if (recordSize > SAVED_RECORD_MAX_SIZE) {
          throw new ErrorType("Application is larger than the e-Reader ROM supports");
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
        const crc = ~crc32(record.subarray(4, 4 + crcLength), 0x55b87bdd) >>> 0;
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
          throw new ErrorType(`Unknown application region: ${applicationRegion}`);
        }
        if (title.includes("\0")) {
          throw new ErrorType("Application title must not contain a NUL character");
        }
        const encoded =
          applicationRegion === "usa"
            ? encodeUsaTitle(title, "Application title")
            : encodeShiftJis(japaneseApplicationTitle(title), "Application title");
        if (encoded.length >= 0x24) {
          throw new ErrorType(
            "Application title is too long; the encoded title must be at most 35 bytes",
          );
        }
        return encoded;
      }

      function setSaveApplicationTitle(saveInput, title, applicationRegionHint = null) {
        const save = asBytes(saveInput, "save");
        const parsed = parseSave(save);
        const metadata = parsed.metadata;
        if (applicationRegionHint !== null && !["usa", "japan"].includes(applicationRegionHint)) {
          throw new ErrorType(`Unknown application region: ${applicationRegionHint}`);
        }
        if (
          metadata.storedRegionCode === JPN_SAVED_REGION_CODE &&
          applicationRegionHint === "usa"
        ) {
          throw new ErrorType("e-Reader+ application titles require Japanese encoding");
        }
        const applicationRegion = applicationRegionHint ?? metadata.applicationRegion;
        const titleBytes = encodeSaveApplicationTitle(title, applicationRegion);
        const record = parsed.record;
        record.fill(0, 4, 0x28);
        record.set(titleBytes, 4);
        const crcLength = 0x30 + metadata.programSize + metadata.extraSize;
        const crc = ~crc32(record.subarray(4, 4 + crcLength), 0x55b87bdd) >>> 0;
        writeU32LE(record, 0, crc);

        const updated = Uint8Array.from(save);
        writeSavedRecord(updated, record);
        validateSave(updated);
        return updated;
      }
      return Object.freeze({
        parseSave,
        savedRecordBytes,
        dotcodeCardHeaderByte,
        dotcodeSaveLayout,
        rawExportPreservesContent,
        validateSave,
        extractSaveCalibration,
        applySaveCalibration,
        extractSavePayload,
        buildVirtualSave,
        setSaveApplicationTitle,
      });
    }

    return Object.freeze({ createSaveFormat });
  },
);
