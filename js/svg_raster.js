(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./svg_format.js"));
  } else {
    root.EReaderSvgRaster = factory(root.EReaderSvgFormat);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (format) {
  "use strict";

  const {
    MAX_DOTCODE_IMAGE_PIXELS,
    MAX_CANVAS_DIMENSION,
    MAX_SVG_FILE_BYTES,
    DEFAULT_SVG_RASTER_DPI,
    MAX_SVG_RASTER_DPI,
    SVG_NAMESPACE,
  } = format.constants;
  const { decodeSvgText } = format;

  const SAFE_SVG_CSS_PROPERTIES = new Set([
    "alignment-baseline",
    "baseline-shift",
    "clip",
    "clip-path",
    "clip-rule",
    "color",
    "color-interpolation",
    "color-interpolation-filters",
    "color-rendering",
    "d",
    "direction",
    "display",
    "dominant-baseline",
    "enable-background",
    "fill",
    "fill-opacity",
    "fill-rule",
    "filter",
    "flood-color",
    "flood-opacity",
    "font",
    "font-family",
    "font-feature-settings",
    "font-kerning",
    "font-optical-sizing",
    "font-size",
    "font-stretch",
    "font-style",
    "font-synthesis",
    "font-variant",
    "font-variant-caps",
    "font-variant-east-asian",
    "font-variant-ligatures",
    "font-variant-numeric",
    "font-variation-settings",
    "font-weight",
    "glyph-orientation-horizontal",
    "glyph-orientation-vertical",
    "image-rendering",
    "inline-size",
    "isolation",
    "kerning",
    "letter-spacing",
    "lighting-color",
    "line-height",
    "marker",
    "marker-end",
    "marker-mid",
    "marker-start",
    "mask",
    "mix-blend-mode",
    "opacity",
    "overflow",
    "paint-order",
    "pointer-events",
    "r",
    "rx",
    "ry",
    "shape-inside",
    "shape-rendering",
    "stop-color",
    "stop-opacity",
    "stroke",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-opacity",
    "stroke-width",
    "tab-size",
    "text-align",
    "text-anchor",
    "text-decoration",
    "text-decoration-color",
    "text-decoration-line",
    "text-decoration-style",
    "text-indent",
    "text-orientation",
    "text-overflow",
    "text-rendering",
    "text-transform",
    "transform",
    "transform-box",
    "transform-origin",
    "unicode-bidi",
    "vector-effect",
    "visibility",
    "white-space",
    "word-break",
    "word-spacing",
    "writing-mode",
    "x",
    "y",
  ]);
  const SAFE_CSS_COLOR_FUNCTIONS = [
    "color",
    "color-mix",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "oklab",
    "oklch",
    "rgb",
    "rgba",
  ];
  const SAFE_CSS_MATH_FUNCTIONS = ["calc", "clamp", "max", "min"];
  const SAFE_SVG_CSS_FUNCTIONS = new Map();

  function allowSvgCssFunctions(properties, functions) {
    for (const property of properties) {
      SAFE_SVG_CSS_FUNCTIONS.set(property, new Set(functions));
    }
  }

  allowSvgCssFunctions(
    ["color", "flood-color", "lighting-color", "stop-color", "text-decoration-color"],
    SAFE_CSS_COLOR_FUNCTIONS,
  );
  allowSvgCssFunctions(["fill", "stroke"], ["url", ...SAFE_CSS_COLOR_FUNCTIONS]);
  allowSvgCssFunctions(
    ["clip-path"],
    ["url", "circle", "ellipse", "inset", "path", "polygon", ...SAFE_CSS_MATH_FUNCTIONS],
  );
  allowSvgCssFunctions(["clip"], ["rect", ...SAFE_CSS_MATH_FUNCTIONS]);
  allowSvgCssFunctions(
    ["filter"],
    [
      "url",
      "blur",
      "brightness",
      "contrast",
      "drop-shadow",
      "grayscale",
      "hue-rotate",
      "invert",
      "opacity",
      "saturate",
      "sepia",
      ...SAFE_CSS_COLOR_FUNCTIONS,
      ...SAFE_CSS_MATH_FUNCTIONS,
    ],
  );
  allowSvgCssFunctions(
    ["marker", "marker-end", "marker-mid", "marker-start", "mask", "shape-inside"],
    ["url"],
  );
  allowSvgCssFunctions(
    [
      "baseline-shift",
      "font-size",
      "inline-size",
      "letter-spacing",
      "line-height",
      "r",
      "rx",
      "ry",
      "stroke-dasharray",
      "stroke-dashoffset",
      "stroke-width",
      "text-indent",
      "transform-origin",
      "word-spacing",
      "x",
      "y",
    ],
    SAFE_CSS_MATH_FUNCTIONS,
  );
  allowSvgCssFunctions(
    ["text-decoration"],
    [...SAFE_CSS_COLOR_FUNCTIONS, ...SAFE_CSS_MATH_FUNCTIONS],
  );
  allowSvgCssFunctions(
    ["transform"],
    [
      "matrix",
      "matrix3d",
      "perspective",
      "rotate",
      "rotate3d",
      "rotateX",
      "rotateY",
      "rotateZ",
      "scale",
      "scale3d",
      "scaleX",
      "scaleY",
      "scaleZ",
      "skew",
      "skewX",
      "skewY",
      "translate",
      "translate3d",
      "translateX",
      "translateY",
      "translateZ",
      ...SAFE_CSS_MATH_FUNCTIONS,
    ].map((name) => name.toLowerCase()),
  );
  allowSvgCssFunctions(["d"], ["path"]);
  const FORBIDDEN_CSS_RESOURCE_FUNCTIONS = new Set([
    "-webkit-cross-fade",
    "-webkit-image-set",
    "cross-fade",
    "element",
    "env",
    "image",
    "image-set",
    "paint",
    "src",
    "var",
  ]);

  function svgRasterError(label, detail) {
    return new Error(`${label} cannot be rasterized safely: ${detail}`);
  }

  function parseSvgDocument(source, label) {
    if (/<!DOCTYPE\b/i.test(source)) {
      throw svgRasterError(label, "document type and entity declarations are not allowed");
    }
    if (typeof DOMParser !== "function") {
      throw svgRasterError(label, "this browser has no SVG XML parser");
    }
    const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
    const root = documentNode.documentElement;
    const hasParserError =
      !root ||
      root.localName === "parsererror" ||
      Array.from(documentNode.getElementsByTagName("*")).some(
        (element) => element.localName === "parsererror",
      );
    if (hasParserError) {
      throw svgRasterError(label, "the SVG XML is malformed");
    }
    if (root.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
      throw svgRasterError(label, "the document root is not an SVG element");
    }
    return root;
  }

  function assertSafeCssReferences(value, label) {
    if (value.includes("\\")) {
      throw svgRasterError(label, "CSS escapes are not allowed in imported SVG images");
    }
    if (/@/.test(value)) {
      throw svgRasterError(label, "CSS at-rules are not allowed in imported SVG images");
    }
    const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
    let match;
    while ((match = urlPattern.exec(value)) !== null) {
      const reference = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (reference && !reference.startsWith("#")) {
        throw svgRasterError(label, "external SVG resources are not allowed");
      }
    }
  }

  function cssFunctionNames(value) {
    const names = [];
    let index = 0;
    while (index < value.length) {
      const character = value[index];
      if (character === '"' || character === "'") {
        const quote = character;
        index += 1;
        while (index < value.length && value[index] !== quote) {
          index += 1;
        }
        index += 1;
        continue;
      }
      if (character === "/" && value[index + 1] === "*") {
        const end = value.indexOf("*/", index + 2);
        index = end < 0 ? value.length : end + 2;
        continue;
      }
      if (/[A-Za-z_-]/.test(character)) {
        const start = index;
        index += 1;
        while (index < value.length && /[A-Za-z0-9_-]/.test(value[index])) {
          index += 1;
        }
        if (value[index] === "(") {
          names.push(value.slice(start, index).toLowerCase());
        }
        continue;
      }
      index += 1;
    }
    return names;
  }

  function assertSafeCssDeclaration(property, value, label) {
    const functions = cssFunctionNames(value);
    for (const functionName of functions) {
      if (FORBIDDEN_CSS_RESOURCE_FUNCTIONS.has(functionName)) {
        throw svgRasterError(label, `${functionName}() is not allowed in imported SVG styles`);
      }
    }
    assertSafeCssReferences(value, label);
    if (property.startsWith("--")) {
      throw svgRasterError(label, "CSS custom properties are not allowed in imported SVG images");
    }
    if (!SAFE_SVG_CSS_PROPERTIES.has(property)) {
      throw svgRasterError(label, `CSS property ${property} is not allowed in imported SVG images`);
    }
    const allowedFunctions = SAFE_SVG_CSS_FUNCTIONS.get(property) || new Set();
    for (const functionName of functions) {
      if (!allowedFunctions.has(functionName)) {
        throw svgRasterError(
          label,
          `${functionName}() is not allowed for SVG CSS property ${property}`,
        );
      }
    }
  }

  function sanitizedCssDeclaration(declaration, label) {
    const parts = [];
    for (let index = 0; index < declaration.length; index += 1) {
      const property = declaration.item(index).toLowerCase();
      const value = declaration.getPropertyValue(property).trim();
      assertSafeCssDeclaration(property, value, label);
      const priority = declaration.getPropertyPriority(property);
      parts.push(`${property}:${value}${priority ? " !important" : ""};`);
    }
    return parts.join("");
  }

  function parsedCssRules(source, label) {
    assertSafeCssReferences(source, label);
    let sheet = null;
    if (typeof CSSStyleSheet === "function") {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(source);
      } catch (_error) {
        sheet = null;
      }
    }
    if (!sheet) {
      if (
        !document.implementation ||
        typeof document.implementation.createHTMLDocument !== "function"
      ) {
        throw svgRasterError(label, "this browser has no safe CSS parser");
      }
      const cssDocument = document.implementation.createHTMLDocument("");
      const style = cssDocument.createElement("style");
      style.textContent = source;
      cssDocument.head.append(style);
      sheet = style.sheet;
    }
    if (!sheet) {
      throw svgRasterError(label, "the SVG stylesheet could not be parsed");
    }
    try {
      return Array.from(sheet.cssRules);
    } catch (_error) {
      throw svgRasterError(label, "the SVG stylesheet could not be inspected safely");
    }
  }

  function sanitizedCssStylesheet(source, label) {
    const serializedRules = [];
    for (const rule of parsedCssRules(source, label)) {
      if (rule.type !== 1 || !rule.style || typeof rule.selectorText !== "string") {
        throw svgRasterError(label, "only ordinary CSS style rules are allowed in SVG stylesheets");
      }
      if (rule.cssRules && rule.cssRules.length > 0) {
        throw svgRasterError(label, "nested CSS rules are not allowed in SVG stylesheets");
      }
      assertSafeCssReferences(rule.selectorText, label);
      serializedRules.push(`${rule.selectorText}{${sanitizedCssDeclaration(rule.style, label)}}`);
    }
    return serializedRules.join("\n");
  }

  function sanitizedInlineCss(source, label) {
    assertSafeCssReferences(source, label);
    const parser = document.createElementNS(SVG_NAMESPACE, "g");
    parser.style.cssText = source;
    return sanitizedCssDeclaration(parser.style, label);
  }

  function sanitizedSvgRoot(root, label) {
    const clone = root.cloneNode(true);
    const elements = [clone, ...Array.from(clone.getElementsByTagName("*"))];
    const forbiddenElements = new Set([
      "animate",
      "animateMotion",
      "animateTransform",
      "discard",
      "embed",
      "foreignObject",
      "iframe",
      "object",
      "script",
      "set",
    ]);
    for (const element of elements) {
      const elementName = element.localName || "";
      if (forbiddenElements.has(elementName)) {
        throw svgRasterError(label, `<${elementName}> is not allowed in imported SVG images`);
      }
      if (elementName === "style") {
        if (element.namespaceURI !== SVG_NAMESPACE) {
          throw svgRasterError(label, "non-SVG style elements are not allowed");
        }
        element.textContent = sanitizedCssStylesheet(element.textContent || "", label);
      }
      for (const attribute of Array.from(element.attributes || [])) {
        const attributeName = (attribute.localName || attribute.name || "").toLowerCase();
        if (attributeName.startsWith("on")) {
          throw svgRasterError(label, "event-handler attributes are not allowed");
        }
        if (attributeName === "style") {
          const sanitizedStyle = sanitizedInlineCss(attribute.value, label);
          if (sanitizedStyle) {
            element.setAttribute("style", sanitizedStyle);
          } else {
            element.removeAttributeNode(attribute);
          }
          continue;
        }
        if (
          (attribute.name || "").toLowerCase() === "xml:base" ||
          (attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace" &&
            attributeName === "base")
        ) {
          throw svgRasterError(label, "xml:base is not allowed in imported SVG images");
        }
        if (
          (attributeName === "href" || attributeName === "src") &&
          attribute.value.trim() !== "" &&
          !attribute.value.trim().startsWith("#")
        ) {
          throw svgRasterError(label, "external SVG resource references are not allowed");
        }
        assertSafeCssReferences(attribute.value, label);
      }
    }
    return clone;
  }

  function parseViewBox(root, label) {
    const value = root.getAttribute("viewBox");
    if (value === null || value.trim() === "") {
      return null;
    }
    const parts = value
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) {
      throw svgRasterError(label, "viewBox must contain four finite numbers with positive size");
    }
    return { width: parts[2], height: parts[3] };
  }

  function svgRasterDpi(root, label) {
    const value = root.getAttribute("data-raster-dpi");
    if (value === null || value.trim() === "") {
      return DEFAULT_SVG_RASTER_DPI;
    }
    const dpi = Number(value);
    if (!Number.isFinite(dpi) || dpi <= 0 || dpi > MAX_SVG_RASTER_DPI) {
      throw svgRasterError(
        label,
        `data-raster-dpi must be greater than 0 and no more than ${MAX_SVG_RASTER_DPI}`,
      );
    }
    return dpi;
  }

  function svgLengthInPixels(value, dpi, label, attributeName) {
    if (value === null || value.trim() === "" || /%$/.test(value.trim())) {
      return null;
    }
    const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|q|pt|pc)?$/i.exec(
      value.trim(),
    );
    if (!match) {
      return null;
    }
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw svgRasterError(label, `${attributeName} must be a finite positive length`);
    }
    const unit = (match[2] || "px").toLowerCase();
    const inchesPerUnit = {
      px: 1 / 96,
      in: 1,
      cm: 1 / 2.54,
      mm: 1 / 25.4,
      q: 1 / 101.6,
      pt: 1 / 72,
      pc: 1 / 6,
    }[unit];
    return amount * inchesPerUnit * dpi;
  }

  function checkedSvgRasterSize(root, label) {
    const dpi = svgRasterDpi(root, label);
    const viewBox = parseViewBox(root, label);
    const defaultWidth = (300 * dpi) / 96;
    const defaultHeight = (150 * dpi) / 96;
    let width = svgLengthInPixels(root.getAttribute("width"), dpi, label, "width");
    let height = svgLengthInPixels(root.getAttribute("height"), dpi, label, "height");

    if (width === null && height === null) {
      width = defaultWidth;
      height = defaultHeight;
    } else if (width === null) {
      width = viewBox ? (height * viewBox.width) / viewBox.height : defaultWidth;
    } else if (height === null) {
      height = viewBox ? (width * viewBox.height) / viewBox.width : defaultHeight;
    }

    width = Math.round(width);
    height = Math.round(height);
    const pixelCount = width * height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_CANVAS_DIMENSION ||
      height > MAX_CANVAS_DIMENSION ||
      !Number.isSafeInteger(pixelCount) ||
      pixelCount > MAX_DOTCODE_IMAGE_PIXELS
    ) {
      throw svgRasterError(label, `the requested dimensions (${width} x ${height}) are too large`);
    }
    return { width, height };
  }

  function createSvgRasterizer(readSvgFileBytes) {
    async function loadSvgImagePixels(file, preparedInput = null) {
      let svgInput = preparedInput;
      if (svgInput === null) {
        const bytes = await readSvgFileBytes(file);
        svgInput = {
          bytes,
          source: decodeSvgText(bytes, file.name),
        };
      }
      if (!(svgInput.bytes instanceof Uint8Array) || typeof svgInput.source !== "string") {
        throw new TypeError("Prepared SVG input must contain bytes and decoded source text");
      }
      const { bytes, source } = svgInput;
      if (bytes.length > MAX_SVG_FILE_BYTES) {
        throw svgRasterError(file.name, "the file exceeds the 32 MiB image limit");
      }

      const parsedRoot = parseSvgDocument(source, file.name);
      const size = checkedSvgRasterSize(parsedRoot, file.name);
      const root = sanitizedSvgRoot(parsedRoot, file.name);
      if (typeof XMLSerializer !== "function") {
        throw svgRasterError(file.name, "this browser has no SVG serializer");
      }
      const sanitizedSource = new XMLSerializer().serializeToString(root);
      const url = URL.createObjectURL(new Blob([sanitizedSource], { type: "image/svg+xml" }));
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        try {
          await image.decode();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw svgRasterError(file.name, `the browser rejected the SVG image (${message})`);
        }

        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          throw new Error("This browser cannot create a 2D canvas for the dot-code SVG.");
        }
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return loadSvgImagePixels;
  }

  return Object.freeze({ createSvgRasterizer });
});
