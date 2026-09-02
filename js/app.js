(function () {
  "use strict";

  const svgModule = window.EReaderSvg;
  const patcher = window.EReaderPatcher;
  const dotcode = window.EReaderDotcodeScan;
  const zipArchive = window.EReaderZipArchive;
  const inputFiles = window.EReaderInputFiles;
  const browserRuntime = window.EReaderBrowserRuntime;
  const saveDataModule = window.EReaderSaveData;
  const fileServices = (
    patcher
    && dotcode
    && typeof inputFiles?.createFileServices === "function"
  ) ? inputFiles.createFileServices(patcher, dotcode) : null;
  const svgServices = (
    patcher
    && fileServices
    && typeof svgModule?.createSvgServices === "function"
  ) ? svgModule.createSvgServices(patcher, {
    readFileBytes: fileServices.readFileBytes,
  }) : null;
  const saveData = (
    patcher
    && typeof saveDataModule?.createSaveDataServices === "function"
  ) ? saveDataModule.createSaveDataServices(patcher) : null;
  const {
    dotcodeDataFilename,
    dotcodeEntriesMatch,
    fileKind,
    fileSizeError,
    formatBytes,
    readFileBytes,
    rememberDecodedDotcodes,
    safeFilename,
    scanImageDimensionsForFile,
  } = fileServices || {};
  const {
    downloadBytes,
    loadImagePixels,
    wireDropZone,
  } = browserRuntime || {};
  const {
    loadSvgImagePixels,
    rawDotcodeToSvg,
    readSvgInput,
  } = svgServices || {};
  const ARCHIVE_ENTRY_EXTENSIONS = Object.freeze([
    ".gba",
    ".sav",
    ".raw",
    ".jpg",
    ".jpeg",
    ".png",
    ".svg",
  ]);
  const ARCHIVE_ENTRY_MIME_TYPES = Object.freeze({
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  });
  const elements = {
    fileInput: document.querySelector("#file-input"),
    fileDropZone: document.querySelector("#file-drop-zone"),
    romSelection: document.querySelector("#rom-selection"),
    contentListHeading: document.querySelector("#content-list-heading"),
    clearContentButton: document.querySelector("#clear-content-button"),
    contentFileTable: document.querySelector("#content-file-table"),
    contentFileRows: document.querySelector("#content-file-rows"),
    dataHeading: document.querySelector("#data-heading"),
    removeHeading: document.querySelector("#remove-heading"),
    clearButton: document.querySelector("#clear-button"),
    outputModeToggle: document.querySelector("#output-mode-toggle"),
    saveDataOptions: document.querySelector("#save-data-options"),
    saveDataWarning: document.querySelector("#save-data-warning"),
    applicationTitle: document.querySelector("#application-title"),
    buildButton: document.querySelector("#build-button"),
    buttonIdle: document.querySelector(".button-idle"),
    buttonWorking: document.querySelector(".button-working"),
    status: document.querySelector("#status-region"),
  };

  const state = {
    romFile: null,
    preparedRom: null,
    sourceFiles: [],
    romError: "",
    compatibilityError: "",
    optionError: "",
    sourceError: "",
    sourceNotice: "",
    inputNotice: "",
    sourceFileErrors: new Map(),
    preparing: false,
    preparationId: 0,
    preparedDotcodes: new Map(),
    preparedApplication: null,
    preparedNative: null,
    preparedSave: null,
    pendingFileBatches: [],
    drainingFileBatches: false,
    busy: false,
    outputMode: "rom",
    applicationTitle: "",
  };

  function isSaveDataMode() {
    return state.outputMode === "save";
  }
  function setStatus(message, tone = "") {
    elements.status.textContent = message || "\u00a0";
    if (tone) {
      elements.status.dataset.tone = tone;
    } else {
      delete elements.status.dataset.tone;
    }
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function renderFileCard(card, options) {
    const name = card.querySelector(".file-name");
    const detail = card.querySelector(".file-detail");
    const badge = card.querySelector(".status-badge");
    const remove = card.querySelector("[data-clear]");

    card.dataset.state = options.state;
    name.textContent = options.name;
    if (Object.prototype.hasOwnProperty.call(options, "detailHtml")) {
      detail.innerHTML = options.detailHtml;
    } else {
      detail.textContent = options.detail;
    }
    badge.textContent = options.badge;
    remove.hidden = options.state === "empty";
  }

  function regionLabel(region) {
    return region === 1 || region === "usa" ? "English" : "Japanese";
  }

  function queuedContentFiles() {
    return state.pendingFileBatches
      .flatMap((batch) => batch)
      .filter((file) => ["SAV", "RAW", "SCAN", "SVG"].includes(fileKind(file)));
  }

  function selectedSaveFiles() {
    return state.sourceFiles.filter((file) => fileKind(file) === "SAV");
  }

  function selectedDotcodeFiles() {
    return state.sourceFiles.filter((file) => (
      ["RAW", "SCAN", "SVG"].includes(fileKind(file))
    ));
  }

  function selectedApplicationIsReady() {
    const dotcodeFiles = selectedDotcodeFiles();
    if (dotcodeFiles.length > 0) {
      return Boolean(state.preparedApplication || state.preparedNative);
    }
    const saveFiles = selectedSaveFiles();
    return Boolean(
      saveFiles.length === 1
      && state.preparedSave?.file === saveFiles[0]
      && state.preparedSave.application
    );
  }

  function removeSaveFile(file) {
    if (state.busy || state.preparing || fileKind(file) !== "SAV") {
      return;
    }
    state.preparationId += 1;
    state.sourceFiles = state.sourceFiles.filter((candidate) => candidate !== file);
    state.sourceFileErrors.delete(file);
    if (state.preparedSave?.file === file) {
      state.preparedSave = null;
    }
    state.compatibilityError = "";
    state.optionError = "";
    state.sourceError = "";
    state.sourceNotice = "";
    state.inputNotice = "";
    analyzePreparedDotcodes();
    renderInputs();
    refreshInputStatus();
  }

  function removeSaveComponent(file, component) {
    if (
      state.busy
      || state.preparing
      || state.preparedSave?.file !== file
      || !["application", "calibration"].includes(component)
    ) {
      return;
    }

    state.preparationId += 1;
    state.compatibilityError = "";
    state.optionError = "";
    state.sourceError = "";
    state.sourceNotice = "";
    state.sourceFileErrors.delete(file);
    state.preparedSave[component] = null;

    if (!state.preparedSave.application && !state.preparedSave.calibration) {
      removeSaveFile(file);
      return;
    }

    state.inputNotice = "";
    analyzePreparedDotcodes();
    renderInputs();
    refreshInputStatus();
  }

  function removePreparedDotcode(file, entry) {
    if (state.busy || state.preparing) {
      return;
    }
    const entries = state.preparedDotcodes.get(file);
    const entryIndex = entries?.indexOf(entry) ?? -1;
    if (entryIndex < 0) {
      return;
    }

    state.preparationId += 1;
    state.compatibilityError = "";
    state.optionError = "";
    state.sourceError = "";
    state.sourceNotice = "";
    state.sourceFileErrors.delete(file);
    state.preparedApplication = null;
    state.preparedNative = null;

    const retainedEntries = entries.filter((_candidate, index) => index !== entryIndex);
    if (retainedEntries.length > 0) {
      state.preparedDotcodes.set(file, retainedEntries);
    } else {
      state.preparedDotcodes.delete(file);
      state.sourceFiles = state.sourceFiles.filter((candidate) => candidate !== file);
    }

    state.inputNotice = "";
    analyzePreparedDotcodes();
    renderInputs();
    refreshInputStatus();
  }

  function renderContentFileRows() {
    const contentItems = [];
    const usingDotcodeContent = selectedDotcodeFiles().length > 0;
    const unresolvedDetails = (file) => (
      state.sourceFileErrors.has(file)
        ? {
          state: "error",
          region: "Invalid",
          title: "\u2014",
          index: "\u2014",
          count: "\u2014",
        }
        : {
          state: "pending",
          region: "Reading\u2026",
          title: "\u2014",
          index: "\u2014",
          count: "\u2014",
        }
    );

    for (const file of state.sourceFiles) {
      if (fileKind(file) === "SAV") {
        const preparedSave = state.preparedSave?.file === file
          ? state.preparedSave
          : null;
        if (!preparedSave) {
          contentItems.push({
            file,
            entry: null,
            contentKind: "application",
            details: unresolvedDetails(file),
            removeAction: "save-file",
          });
          continue;
        }
        if (preparedSave.application) {
          const { metadata, rawEntries } = preparedSave.application;
          if (!usingDotcodeContent) {
            if (rawEntries.length > 0) {
              for (const [index, entry] of rawEntries.entries()) {
                contentItems.push({
                  file,
                  entry,
                  contentKind: "application",
                  details: {
                    state: "ready",
                    region: regionLabel(metadata.applicationRegion),
                    title: metadata.title || "Untitled",
                    index: String(entry.metadata.cardIndex),
                    count: String(entry.metadata.cardCount),
                  },
                  removeAction: index === 0 ? "save-application" : null,
                });
              }
            } else {
              contentItems.push({
                file,
                entry: null,
                contentKind: "application",
                details: {
                  state: "ready",
                  region: regionLabel(metadata.applicationRegion),
                  title: metadata.title || "Untitled",
                  index: "\u2014",
                  count: "\u2014",
                },
                removeAction: "save-application",
              });
            }
          } else {
            contentItems.push({
              file,
              entry: null,
              contentKind: "inactive-save-application",
              details: {
                state: "inactive",
                region: "Inactive",
                title: `Saved card content (inactive): ${metadata.title || "Untitled"}`,
                index: "\u2014",
                count: "\u2014",
              },
              removeAction: "save-application",
            });
          }
        }
        if (isSaveDataMode() && preparedSave.calibration) {
          contentItems.push({
            file,
            entry: null,
            contentKind: "calibration",
            details: {
              state: "ready",
              region: "\u2014",
              title: "e-Reader Calibration Data",
              index: "\u2014",
              count: "\u2014",
            },
            removeAction: "save-calibration",
          });
        }
        continue;
      }
      const entries = state.preparedDotcodes.get(file);
      if (entries && entries.length > 0) {
        for (const entry of entries) {
          contentItems.push({
            file,
            entry,
            contentKind: "application",
            details: {
              state: "ready",
              region: regionLabel(entry.metadata.region),
              title: entry.metadata.embeddedTitle || "Untitled",
              index: String(entry.metadata.cardIndex),
              count: String(entry.metadata.cardCount),
            },
            removeAction: "dotcode",
          });
        }
      } else {
        contentItems.push({
          file,
          entry: null,
          contentKind: "application",
          details: unresolvedDetails(file),
          removeAction: null,
        });
      }
    }
    for (const file of queuedContentFiles()) {
      contentItems.push({
        file,
        entry: null,
        contentKind: "application",
        details: unresolvedDetails(file),
        removeAction: null,
      });
    }

    const hasContentItems = contentItems.length > 0;
    elements.contentListHeading.hidden = !hasContentItems;
    elements.contentFileTable.hidden = !hasContentItems;
    const showDataDownloads = contentItems.some(({ entry, contentKind }) => (
      contentKind === "application" && Boolean(entry)
    ));
    const showRemoveActions = contentItems.some(({ removeAction }) => Boolean(removeAction));
    elements.dataHeading.hidden = !showDataDownloads;
    elements.removeHeading.hidden = !showRemoveActions;
    elements.contentFileTable.classList.toggle("has-data", showDataDownloads);
    elements.contentFileTable.classList.toggle("has-remove", showRemoveActions);
    const rows = contentItems.map(({
      file,
      entry,
      contentKind,
      details,
      removeAction,
    }) => {
      const row = document.createElement("tr");
      row.dataset.state = details.state;
      row.dataset.contentKind = contentKind;
      const contentCellText = details.index === "\u2014" || details.count === "\u2014"
        ? details.title
        : `${details.title} (${details.index}/${details.count})`;
      const values = [
        ["filename", file.name],
        ["region", details.region],
        ["content", contentCellText],
      ];
      for (const [field, value] of values) {
        const cell = document.createElement("td");
        cell.dataset.field = field;
        cell.textContent = value;
        cell.title = value;
        row.append(cell);
      }
      if (showDataDownloads) {
        const downloadCell = document.createElement("td");
        downloadCell.className = "data-column";
        downloadCell.dataset.field = "data";
        if (entry && contentKind === "application") {
          const actions = document.createElement("div");
          actions.className = "data-download-actions";

          const rawFilename = dotcodeDataFilename(entry, "raw");
          const rawButton = document.createElement("button");
          rawButton.type = "button";
          rawButton.className = "ghost-button data-download-button raw-download-button";
          rawButton.textContent = "RAW";
          rawButton.title = `Download ${rawFilename}`;
          rawButton.setAttribute(
            "aria-label",
            `Download RAW dot-code data as ${rawFilename}`,
          );
          rawButton.addEventListener("click", () => {
            downloadBytes(entry.bytes, rawFilename, "application/octet-stream");
          });

          const svgFilename = dotcodeDataFilename(entry, "svg");
          const svgButton = document.createElement("button");
          svgButton.type = "button";
          svgButton.className = "ghost-button data-download-button svg-download-button";
          svgButton.textContent = "SVG";
          svgButton.title = `Download ${svgFilename}`;
          svgButton.setAttribute(
            "aria-label",
            `Download 2400 ppi vector dot code as ${svgFilename}`,
          );
          svgButton.addEventListener("click", () => {
            const svg = rawDotcodeToSvg(entry.bytes, entry.sourceName);
            downloadBytes(svg, svgFilename, "image/svg+xml;charset=utf-8");
          });

          actions.append(rawButton, svgButton);
          downloadCell.append(actions);
        }
        row.append(downloadCell);
      }
      if (showRemoveActions) {
        const removeCell = document.createElement("td");
        removeCell.className = "remove-column";
        removeCell.dataset.field = "remove";
        if (removeAction) {
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "ghost-button small content-remove-button";
          removeButton.textContent = "Remove";
          removeButton.disabled = state.busy || state.preparing;
          let contentLabel;
          if (removeAction === "save-calibration") {
            contentLabel = `calibration data from ${file.name}`;
          } else if (removeAction === "save-application") {
            contentLabel = `saved card content from ${file.name}`;
          } else if (removeAction === "save-file") {
            contentLabel = `SAV source file ${file.name}`;
          } else if (details.title === "\u2014") {
            contentLabel = `dot code from ${file.name}`;
          } else {
            contentLabel = `${details.title}, dot code ${details.index} of ${details.count}`;
          }
          removeButton.title = `Remove ${contentLabel}`;
          removeButton.setAttribute("aria-label", `Remove ${contentLabel}`);
          removeButton.addEventListener("click", () => {
            if (removeAction === "dotcode") {
              removePreparedDotcode(file, entry);
            } else if (removeAction === "save-file") {
              removeSaveFile(file);
            } else {
              removeSaveComponent(
                file,
                removeAction === "save-calibration" ? "calibration" : "application",
              );
            }
          });
          removeCell.append(removeButton);
        }
        row.append(removeCell);
      }
      return row;
    });
    elements.contentFileRows.replaceChildren(...rows);
  }

  function renderOptions() {
    const saveDataMode = isSaveDataMode();
    const usingDotcodeContent = selectedDotcodeFiles().length > 0;
    const currentTitle = (
      usingDotcodeContent
        ? state.preparedApplication?.title
          || state.preparedNative?.metadata?.embeddedTitle
        : state.preparedSave?.application?.metadata?.title
    ) || "Application title";
    elements.outputModeToggle.setAttribute("aria-checked", String(saveDataMode));
    elements.outputModeToggle.disabled = state.busy;
    elements.romSelection.hidden = saveDataMode;
    elements.saveDataOptions.hidden = !saveDataMode;
    elements.saveDataWarning.hidden = Boolean(state.preparedSave?.calibration);
    elements.applicationTitle.disabled = state.busy;
    elements.applicationTitle.placeholder = currentTitle;
    elements.applicationTitle.setAttribute("aria-invalid", String(Boolean(state.optionError)));
    if (elements.applicationTitle.value !== state.applicationTitle) {
      elements.applicationTitle.value = state.applicationTitle;
    }
    elements.buttonIdle.textContent = saveDataMode
      ? "Build Save Data"
      : "Build Standalone ROM";
    elements.buttonWorking.textContent = saveDataMode
      ? "Generating save data…"
      : "Validating and building…";
  }

  function renderInputs() {
    renderOptions();
    if (!state.romFile) {
      renderFileCard(elements.romSelection, {
        state: "empty",
        name: "No ROM selected.",
        detailHtml: isSaveDataMode()
          ? "A base ROM is not required for Save Data output."
          : "Supported: <b>e-Reader (USA)</b> or <b>Card e-Reader+ (Japan)</b>",
        badge: isSaveDataMode() ? "Optional" : "Missing",
      });
    } else {
      renderFileCard(elements.romSelection, {
        state: state.romError ? "error" : state.preparedRom ? "ready" : "pending",
        name: state.romFile.name,
        detail: state.romError || `${formatBytes(state.romFile.size)} · GBA ROM`,
        badge: state.romError ? "Invalid" : state.preparedRom ? "Validated" : "Reading",
      });
    }

    renderContentFileRows();
    elements.clearContentButton.hidden = (
      state.sourceFiles.length === 0 && queuedContentFiles().length === 0
    );

    const hasAnyFiles = Boolean(state.romFile || state.sourceFiles.length);
    const sourceReady = selectedApplicationIsReady();
    const outputReady = isSaveDataMode()
      ? !state.preparedNative
      : Boolean(
        state.romFile
        && state.preparedRom?.file === state.romFile
        && !state.romError
        && !state.compatibilityError
      );
    const ready = Boolean(
      sourceReady
      && outputReady
      && !state.sourceError
      && !state.sourceNotice
      && !state.optionError
      && !state.preparing
      && !state.busy
    );
    elements.clearButton.disabled = !hasAnyFiles || state.busy || state.preparing;
    elements.buildButton.disabled = !ready;
    elements.fileInput.disabled = state.busy;
    document.querySelectorAll("[data-clear]").forEach((button) => {
      button.disabled = state.busy || state.preparing;
    });
  }

  function refreshInputStatus() {
    if (state.preparing) {
      return;
    }
    if (state.optionError) {
      setStatus(state.optionError, "error");
    } else if (!isSaveDataMode() && state.romError) {
      setStatus(state.romError, "error");
    } else if (state.sourceError) {
      setStatus(state.sourceError, "error");
    } else if (!isSaveDataMode() && state.compatibilityError) {
      setStatus(state.compatibilityError, "error");
    } else if (state.sourceNotice) {
      setStatus(state.sourceNotice, "warning");
    } else if (state.inputNotice) {
      setStatus(state.inputNotice, "warning");
    } else if (isSaveDataMode() && state.preparedNative) {
      setStatus(
        "This card type cannot be stored as an e-Reader saved application. Use ROM output instead.",
        "warning",
      );
    } else if (isSaveDataMode() && !selectedApplicationIsReady()) {
      if (state.preparedSave?.calibration && selectedDotcodeFiles().length === 0) {
        setStatus(
          "Calibration data imported. Add RAW strips or dot-code images to continue.",
        );
      } else {
        setStatus("Add a SAV with an application, RAW strips, or dot-code images to continue.");
      }
    } else if (isSaveDataMode()) {
      setStatus("Content is complete and validated. Ready to build save data.");
    } else if (!state.romFile && state.sourceFiles.length === 0) {
      setStatus("Add a base ROM and content files to continue.");
    } else if (!state.romFile) {
      setStatus("Add a supported base ROM to continue.");
    } else if (state.sourceFiles.length === 0) {
      setStatus("Add a SAV, RAW strips, or dot-code images to continue.");
    } else if (!selectedApplicationIsReady()) {
      setStatus("Add application content to continue.");
    } else {
      setStatus("Inputs are complete and validated. Ready to build.");
    }
  }

  async function expandZipInputs(requestedFiles) {
    const files = [];
    const notices = [];
    for (const file of requestedFiles) {
      if (fileKind(file) !== "ZIP") {
        files.push(file);
        continue;
      }
      if (file.size > zipArchive.MAX_ARCHIVE_SIZE) {
        notices.push(`Ignored ZIP archive ${file.name}: the archive exceeds the 64 MiB limit.`);
        continue;
      }
      try {
        setStatus(`Reading ZIP archive: ${file.name}…`);
        await nextFrame();
        const bytes = await readFileBytes(file);
        const extracted = await zipArchive.extractSupportedFiles(
          bytes,
          ARCHIVE_ENTRY_EXTENSIONS,
        );
        if (extracted.files.length === 0) {
          notices.push(
            `Ignored ZIP archive ${file.name}: it contains no supported input files.`,
          );
          continue;
        }
        for (const entry of extracted.files) {
          const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
          files.push(new File([entry.bytes], entry.name, {
            type: ARCHIVE_ENTRY_MIME_TYPES[extension] || "application/octet-stream",
            lastModified: file.lastModified,
          }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notices.push(`Ignored ZIP archive ${file.name}: ${message}`);
      }
    }
    return { files, notices };
  }

  async function processFileBatch(requestedFiles) {
    state.inputNotice = "";
    const notices = [];
    const archiveExpansion = await expandZipInputs(requestedFiles);
    requestedFiles = archiveExpansion.files;
    notices.push(...archiveExpansion.notices);
    setStatus("Checking added files for duplicates…");
    await nextFrame();
    const duplicateCheck = await fileServices.filterDuplicateFiles(requestedFiles, state);
    const files = duplicateCheck.accepted;
    if (duplicateCheck.ignored.length > 0) {
      notices.push(
        `Ignored duplicate file${duplicateCheck.ignored.length === 1 ? "" : "s"}: `
        + duplicateCheck.ignored.map((file) => file.name).join(", "),
      );
    }
    const unknown = files.filter((file) => !fileKind(file));
    if (unknown.length > 0) {
      notices.push(
        `Ignored unsupported file${unknown.length === 1 ? "" : "s"}: `
        + unknown.map((file) => file.name).join(", "),
      );
    }

    const romFiles = files.filter((file) => fileKind(file) === "ROM");
    if (romFiles.length > 1) {
      notices.push("Add only one base ROM at a time.");
    } else if (romFiles.length === 1) {
      const file = romFiles[0];
      const sizeError = fileSizeError(file);
      const previousRom = state.preparedRom;
      if (sizeError) {
        if (previousRom) {
          notices.push(`Ignored invalid base ROM input: ${sizeError}`);
        } else {
          state.romFile = file;
          state.preparedRom = null;
          state.romError = sizeError;
        }
      } else {
        try {
          setStatus(`Reading and validating base ROM: ${file.name}…`);
          await nextFrame();
          const bytes = await readFileBytes(file);
          const profile = await patcher.validateRom(bytes);
          state.romFile = file;
          state.preparedRom = { file, bytes, profile };
          state.romError = "";
          state.compatibilityError = "";
          state.optionError = "";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (previousRom) {
            notices.push(`Ignored invalid base ROM input: ${message}`);
          } else {
            state.romFile = file;
            state.preparedRom = null;
            state.romError = message;
          }
        }
      }
    }

    const contentFiles = files.filter((file) => (
      ["SAV", "RAW", "SCAN", "SVG"].includes(fileKind(file))
    ));
    const acceptedContentFiles = [];
    const incomingDotcodeFiles = [];
    let incomingSaveFile = null;
    let saveAlreadySelected = selectedSaveFiles().length > 0;
    for (const file of contentFiles) {
      const sizeError = fileSizeError(file);
      if (sizeError) {
        notices.push(`Ignored invalid content input: ${sizeError}`);
        continue;
      }
      const kind = fileKind(file);
      if (kind === "SAV") {
        if (saveAlreadySelected) {
          notices.push(`Ignored additional SAV file: ${file.name}. Remove the selected SAV first.`);
          continue;
        }
        saveAlreadySelected = true;
        incomingSaveFile = file;
      } else {
        incomingDotcodeFiles.push(file);
      }
      acceptedContentFiles.push(file);
    }

    state.inputNotice = notices.join(" ");
    if (acceptedContentFiles.length > 0) {
      state.sourceFiles.push(...acceptedContentFiles);
      state.compatibilityError = "";
      state.optionError = "";
      state.sourceError = "";
      state.sourceNotice = "";
      renderInputs();
      refreshInputStatus();
      if (incomingSaveFile) {
        await prepareSaveFile(incomingSaveFile);
      }
      if (incomingDotcodeFiles.length > 0) {
        await prepareDotcodeFiles(incomingDotcodeFiles);
      }
      return;
    }
    renderInputs();
    refreshInputStatus();
  }

  function enqueueFiles(fileList) {
    if (state.busy) {
      return;
    }
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }
    state.pendingFileBatches.push(files);
    if (state.drainingFileBatches) {
      const queuedCount = state.pendingFileBatches.reduce(
        (total, batch) => total + batch.length,
        0,
      );
      state.inputNotice =
        `${queuedCount} file${queuedCount === 1 ? "" : "s"} queued `
        + "until the current import finishes.";
      renderInputs();
      setStatus(state.inputNotice, "warning");
    }
    void drainPendingFileBatches();
  }

  function clearKind(kind) {
    if (state.busy || state.preparing) {
      return;
    }
    if (kind === "rom" || kind === "all") {
      state.romFile = null;
      state.preparedRom = null;
      state.romError = "";
      state.compatibilityError = "";
      state.optionError = "";
    }
    if (kind === "source" || kind === "all") {
      state.preparationId += 1;
      state.sourceFiles = [];
      state.compatibilityError = "";
      state.optionError = "";
      state.sourceError = "";
      state.sourceNotice = "";
      state.sourceFileErrors = new Map();
      state.preparedDotcodes = new Map();
      state.preparedApplication = null;
      state.preparedNative = null;
      state.preparedSave = null;
      state.applicationTitle = "";
    }
    state.inputNotice = "";
    elements.fileInput.value = "";
    renderInputs();
    refreshInputStatus();
  }

  function refreshDuplicateDotcodes() {
    const uniqueEntries = [];
    const retainedFiles = [];
    let duplicateCount = 0;
    for (const file of state.sourceFiles) {
      const entries = state.preparedDotcodes.get(file);
      if (!entries) {
        retainedFiles.push(file);
        continue;
      }
      const retainedEntries = [];
      for (const entry of entries) {
        if (uniqueEntries.some((candidate) => dotcodeEntriesMatch(candidate, entry))) {
          duplicateCount += 1;
        } else {
          uniqueEntries.push(entry);
          retainedEntries.push(entry);
        }
      }
      if (retainedEntries.length > 0) {
        state.preparedDotcodes.set(file, retainedEntries);
        retainedFiles.push(file);
      } else {
        state.preparedDotcodes.delete(file);
        state.sourceFileErrors.delete(file);
      }
    }
    state.sourceFiles = retainedFiles;
    if (duplicateCount > 0) {
      const duplicateNotice =
        `Ignored ${duplicateCount} duplicate dot-code ${duplicateCount === 1 ? "entry" : "entries"}.`;
      state.inputNotice = [state.inputNotice, duplicateNotice].filter(Boolean).join(" ");
    }
  }

  function analyzePreparedDotcodes() {
    state.sourceError = "";
    state.sourceNotice = "";
    state.preparedApplication = null;
    state.preparedNative = null;
    const saveFiles = selectedSaveFiles();
    const dotcodeFiles = selectedDotcodeFiles();
    if (saveFiles.length > 0 && state.sourceFileErrors.has(saveFiles[0])) {
      state.sourceError = state.sourceFileErrors.get(saveFiles[0]);
      return;
    }
    if (dotcodeFiles.length === 0 && saveFiles.length > 0) {
      if (state.preparedSave?.file !== saveFiles[0]) {
        state.sourceError = state.sourceFileErrors.get(saveFiles[0])
          || "The save file has not finished validating.";
      }
      return;
    }
    if (dotcodeFiles.length === 0) {
      return;
    }
    const allFilesPrepared = dotcodeFiles.every((file) => {
      const entries = state.preparedDotcodes.get(file);
      return entries && entries.length > 0;
    });
    const allEntries = dotcodeFiles.flatMap(
      (file) => state.preparedDotcodes.get(file) || [],
    );
    if (!allFilesPrepared || allEntries.length === 0) {
      return;
    }
    const entries = allEntries;

    const contentKinds = new Set(
      entries.map((entry) => entry.metadata.contentKind || "application"),
    );
    if (contentKinds.size !== 1) {
      state.sourceError = "Different content types cannot be combined. Please remove all but one.";
      return;
    }
    if (!contentKinds.has("application")) {
      if (entries.length !== 1) {
        state.sourceError = "Only one item of this content type can be used at a time. Please remove all but one.";
        return;
      }
      state.preparedNative = entries[0];
      return;
    }
    const setIds = new Set(entries.map((entry) => entry.metadata.setId));
    if (setIds.size !== 1) {
      state.sourceError = "The selected files contain different content sets. Please remove all but one set.";
      return;
    }

    const cardCount = entries[0].metadata.cardCount;
    const indices = new Set();
    for (const entry of entries) {
      const cardIndex = entry.metadata.cardIndex;
      if (indices.has(cardIndex)) {
        state.sourceError = `Duplicate internal dot-code strip index ${cardIndex}.`;
        return;
      }
      indices.add(cardIndex);
    }

    const missing = [];
    for (let index = 1; index <= cardCount; index += 1) {
      if (!indices.has(index)) {
        missing.push(index);
      }
    }
    if (missing.length > 0 || indices.size !== cardCount) {
      state.sourceNotice =
        `Dot-code set incomplete: ${indices.size} of ${cardCount} strips added; `
        + `missing internal strip${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. `
        + "Add the remaining file(s) using the same drop zone.";
      return;
    }

    const fallbackTitle = entries.some((entry) => entry.metadata.embeddedTitle)
      ? ""
      : "Untitled";

    try {
      state.preparedApplication = patcher.rawFilesToApplication(
        entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
        fallbackTitle,
      );
    } catch (error) {
      state.sourceError = error instanceof Error ? error.message : String(error);
    }
  }

  async function prepareSaveFile(file) {
    if (!file || fileKind(file) !== "SAV" || !state.sourceFiles.includes(file)) {
      return;
    }
    const preparationId = state.preparationId + 1;
    state.preparationId = preparationId;
    state.sourceError = "";
    state.sourceNotice = "";
    state.sourceFileErrors.delete(file);
    state.preparedSave = null;
    renderInputs();

    try {
      setStatus(`Reading and validating save data: ${file.name}…`);
      await nextFrame();
      const bytes = await readFileBytes(file);
      const inspected = saveData.inspect(bytes, file.name);
      if (state.preparationId === preparationId) {
        state.preparedSave = {
          file,
          bytes,
          application: inspected.application,
          calibration: inspected.calibration,
        };
        state.inputNotice = [state.inputNotice, inspected.notice].filter(Boolean).join(" ");
        analyzePreparedDotcodes();
      }
    } catch (error) {
      if (state.preparationId === preparationId) {
        const message = error instanceof Error ? error.message : String(error);
        state.sourceError = message;
        state.sourceFileErrors.set(file, state.sourceError);
      }
    }
  }

  async function drainPendingFileBatches() {
    if (state.drainingFileBatches) {
      return;
    }
    state.drainingFileBatches = true;
    try {
      while (state.pendingFileBatches.length > 0) {
        const batch = state.pendingFileBatches.shift();
        let importFailure = "";
        state.preparing = true;
        renderInputs();
        try {
          await processFileBatch(batch);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          importFailure = `Ignored unreadable input: ${message}`;
          state.inputNotice = importFailure;
        } finally {
          state.preparing = false;
          renderInputs();
          refreshInputStatus();
          if (importFailure) {
            setStatus(importFailure, "warning");
          }
        }
      }
    } finally {
      state.preparing = false;
      state.drainingFileBatches = false;
    }
  }

  async function prepareDotcodeFiles(incomingFiles = selectedDotcodeFiles()) {
    incomingFiles = incomingFiles.filter((file) => (
      ["RAW", "SCAN", "SVG"].includes(fileKind(file))
    ));
    if (incomingFiles.length === 0) {
      return;
    }

    const preparationId = state.preparationId + 1;
    state.preparationId = preparationId;
    state.sourceError = "";
    state.sourceNotice = "";
    for (const file of incomingFiles) {
      state.sourceFileErrors.delete(file);
    }
    state.preparedApplication = null;
    state.preparedNative = null;
    renderInputs();

    let currentFile = null;
    const stagedDotcodes = new Map();
    try {
      for (let index = 0; index < incomingFiles.length; index += 1) {
        if (state.preparationId !== preparationId) {
          return;
        }
        const file = incomingFiles[index];
        const sourceKind = fileKind(file);
        currentFile = file;

        setStatus(
          sourceKind === "RAW"
            ? `Reading RAW strip ${index + 1} of ${incomingFiles.length}: ${file.name}…`
            : `Decoding dot-code image ${index + 1} of ${incomingFiles.length}: ${file.name}…`,
        );
        await nextFrame();
        let decodedStrips;
        let preparedBaseName;
        if (sourceKind === "SVG") {
          const svgInput = await readSvgInput(file);
          if (svgInput.rawMetadata) {
            decodedStrips = [svgInput.rawMetadata];
          } else {
            setStatus(`Rasterizing SVG dot-code image: ${file.name}…`);
            await nextFrame();
            const pixels = await loadSvgImagePixels(file, svgInput);
            decodedStrips = dotcode.decodeDotcodeImages(pixels);
          }
          preparedBaseName = file.name.replace(/\.svg$/i, "");
        } else if (sourceKind === "SCAN") {
          const pixels = await loadImagePixels(
            file,
            scanImageDimensionsForFile,
          );
          decodedStrips = dotcode.decodeDotcodeImages(pixels);
          preparedBaseName = file.name.replace(/\.(?:jpe?g|png)$/i, "");
        } else {
          decodedStrips = [await readFileBytes(file)];
          preparedBaseName = file.name.replace(/\.raw$/i, "");
        }

        const fileEntries = [];
        for (let stripIndex = 0; stripIndex < decodedStrips.length; stripIndex += 1) {
          const bytes = decodedStrips[stripIndex];
          const stripLabel = decodedStrips.length === 1
            ? file.name
            : `${file.name} (dot code ${stripIndex + 1}/${decodedStrips.length})`;
          const preparedName = decodedStrips.length === 1
            ? `${preparedBaseName}.raw`
            : `${preparedBaseName} [dot code ${stripIndex + 1}].raw`;
          const metadata = patcher.inspectRawDotcode(bytes, stripLabel);
          fileEntries.push({
            name: preparedName,
            sourceName: file.name,
            bytes,
            metadata,
          });
        }
        rememberDecodedDotcodes(file, fileEntries);
        stagedDotcodes.set(file, fileEntries);
        renderInputs();
      }

      for (const [file, entries] of stagedDotcodes) {
        state.preparedDotcodes.set(file, entries);
      }
      refreshDuplicateDotcodes();
      analyzePreparedDotcodes();
    } catch (error) {
      if (state.preparationId === preparationId) {
        const message = error instanceof Error ? error.message : String(error);
        for (const [file, entries] of stagedDotcodes) {
          state.preparedDotcodes.set(file, entries);
        }
        const rejectedFiles = new Set(
          incomingFiles.filter((file) => !stagedDotcodes.has(file)),
        );
        state.sourceFiles = state.sourceFiles.filter((file) => !rejectedFiles.has(file));
        for (const file of rejectedFiles) {
          state.preparedDotcodes.delete(file);
          state.sourceFileErrors.delete(file);
        }
        refreshDuplicateDotcodes();
        analyzePreparedDotcodes();
        const failedName = currentFile ? `${currentFile.name}: ` : "";
        state.inputNotice = [
          state.inputNotice,
          `Ignored invalid content input: ${failedName}${message}`,
        ].filter(Boolean).join(" ");
      }
    }
  }

  async function loadSource() {
    const saveFiles = selectedSaveFiles();
    const dotcodeFiles = selectedDotcodeFiles();
    if (dotcodeFiles.length > 0) {
      const dotcodeKinds = new Set(dotcodeFiles.map(fileKind));
      const sourceKind = dotcodeKinds.size === 1 ? [...dotcodeKinds][0] : "DOTCODE";

      if (state.preparedNative) {
        return {
          nativeRaw: state.preparedNative.bytes,
          metadata: {
            ...state.preparedNative.metadata,
            sourceKind,
            stripCount: 1,
          },
        };
      }

      const application = state.preparedApplication;
      if (!application) {
        throw new Error("The dot-code content set has not finished validating.");
      }
      const save = patcher.buildVirtualSave(application);
      const metadata = patcher.validateSave(save);
      return {
        save,
        metadata: {
          ...metadata,
          applicationRegion: application.region === 1 ? "usa" : "japan",
          scanRegion: application.region,
          sourceKind,
          stripCount: application.stripCount,
        },
      };
    }

    if (saveFiles.length === 1) {
      if (state.preparedSave?.file !== saveFiles[0]) {
        throw new Error("The save file has not finished validating.");
      }
      if (!state.preparedSave.application) {
        throw new Error(
          "The selected SAV contains calibration data but no saved application. "
          + "Add RAW strips or dot-code images to continue.",
        );
      }
      return {
        save: state.preparedSave.bytes,
        metadata: {
          ...state.preparedSave.application.metadata,
          sourceKind: "SAV",
          stripCount: 0,
        },
      };
    }

    throw new Error("No application content has finished validating.");
  }

  function markBuildError(error) {
    const message = error instanceof Error ? error.message : String(error);
    state.compatibilityError = "";
    state.optionError = "";
    if (/application title|title is too long|title must/i.test(message)) {
      state.optionError = message;
    } else if (/requires the .*base ROM/i.test(message)) {
      state.compatibilityError = message;
    } else if (/\bROM\b|base ROM|ROM header|ROM space/i.test(message)) {
      state.romError = message;
    } else if (/save|application|title|RAW|VPK|CRC|payload|program|strip|scan|image|JPEG|PNG|SVG|dot-code|marker|Reed-Solomon/i.test(message)) {
      state.sourceError = message;
    }
    renderInputs();
    setStatus(`Error: ${message}`, "error");
    elements.status.focus({ preventScroll: true });
  }

  async function build() {
    if (state.busy || elements.buildButton.disabled) {
      return;
    }

    state.busy = true;
    state.romError = "";
    state.compatibilityError = "";
    state.optionError = "";
    state.sourceError = "";
    elements.buttonIdle.hidden = true;
    elements.buttonWorking.hidden = false;
    renderInputs();
    setStatus("Reading content data…");
    await nextFrame();

    try {
      const source = await loadSource();
      if (isSaveDataMode()) {
        if (source.nativeRaw) {
          throw new Error(
            "This card type cannot be stored as an e-Reader saved application. Use ROM output instead.",
          );
        }
        setStatus("Generating e-Reader save data…");
        await nextFrame();
        const configuredTitle = state.applicationTitle;
        const hasConfiguredTitle = configuredTitle.trim().length > 0;
        const save = saveData.build({
          sourceSave: source.save,
          applicationMetadata: source.metadata,
          fallbackRegion: state.preparedRom?.profile?.key || null,
          calibration: state.preparedSave?.calibration || null,
          title: hasConfiguredTitle ? configuredTitle : "",
        });
        const title = hasConfiguredTitle ? configuredTitle : source.metadata.title;
        const baseName = safeFilename(title, "e-Reader application");
        const saveFilename = `${baseName}.sav`;
        downloadBytes(save, saveFilename, "application/octet-stream");
        setStatus(`Download started: ${saveFilename}`, "success");
        return;
      }
      setStatus("Validating the base ROM and applying checked patches…");
      await nextFrame();

      if (!state.preparedRom || state.preparedRom.file !== state.romFile) {
        throw new Error("The base ROM has not finished validating.");
      }
      const romBytes = state.preparedRom.bytes;
      const built = source.nativeRaw
        ? await patcher.buildNativeDotcodeRom(
          romBytes,
          source.nativeRaw,
          state.preparedNative.name,
        )
        : await patcher.buildPatchedRom(
          romBytes,
          source.save,
          source.metadata.applicationRegion,
        );
      const metadata = { ...source.metadata, ...built.metadata };
      const baseName = safeFilename(metadata.title, "e-Reader application");
      const romFilename = `${baseName}.gba`;
      downloadBytes(built.rom, romFilename, "application/octet-stream");
      setStatus(`Download started: ${romFilename}`, "success");
    } catch (error) {
      markBuildError(error);
    } finally {
      state.busy = false;
      elements.buttonIdle.hidden = false;
      elements.buttonWorking.hidden = true;
      renderInputs();
    }
  }

  function initialize() {
    if (
      !patcher
      || !svgServices
      || !dotcode
      || !zipArchive
      || !fileServices
      || !browserRuntime
      || !saveData
    ) {
      elements.buildButton.disabled = true;
      setStatus("A required processing module could not be loaded.", "error");
      return;
    }
    if (!window.File || !File.prototype.arrayBuffer || !window.TextDecoder) {
      elements.buildButton.disabled = true;
      setStatus("This browser does not provide the file and text APIs required by the patcher.", "error");
      return;
    }
    if (!window.crypto?.subtle || typeof window.crypto.subtle.digest !== "function") {
      elements.buildButton.disabled = true;
      setStatus("This browser does not provide the secure hashing API required by the patcher.", "error");
      return;
    }

    wireDropZone(
      elements.fileDropZone,
      elements.fileInput,
      enqueueFiles,
      () => state.busy,
    );
    elements.clearButton.addEventListener("click", () => clearKind("all"));
    document.querySelectorAll("[data-clear]").forEach((button) => {
      button.addEventListener("click", () => clearKind(button.dataset.clear));
    });
    elements.buildButton.addEventListener("click", build);
    elements.outputModeToggle.addEventListener("click", () => {
      if (state.busy) {
        return;
      }
      state.outputMode = isSaveDataMode() ? "rom" : "save";
      state.optionError = "";
      renderInputs();
      refreshInputStatus();
    });
    elements.applicationTitle.addEventListener("input", () => {
      state.applicationTitle = elements.applicationTitle.value;
      state.optionError = "";
      renderInputs();
      refreshInputStatus();
    });

    renderInputs();
    refreshInputStatus();
  }

  initialize();
})();
