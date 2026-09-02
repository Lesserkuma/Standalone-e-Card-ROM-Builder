(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderSvg = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SVG_EXTENSION = ".svg";
  const RAW_METADATA_ID = "ereader-raw-data";
  const XML_NAME_PATTERN = /^[:A-Z_a-z][:A-Z_a-z0-9.\-]*/;
  const XML_WHITESPACE_PATTERN = /[\t\n\r ]/;

  const DOTCODE_BYTES_PER_BLOCK = 104;
  const DOTCODE_RENDER_DPI = 2400;
  const DOTCODE_RENDER_SCALE = 7;
  const DOTCODE_GRID_DPI = DOTCODE_RENDER_DPI / DOTCODE_RENDER_SCALE;
  const DOTCODE_DATA_DOT_SIZE = 6;
  const DOTCODE_DATA_DOT_RADIUS = 0;
  const DOTCODE_SYNC_MARKER_DIAMETER = 5 * DOTCODE_RENDER_SCALE;
  const DOTCODE_MODULATION = Object.freeze([
    0x00, 0x01, 0x02, 0x12,
    0x04, 0x05, 0x06, 0x16,
    0x08, 0x09, 0x0a, 0x14,
    0x0c, 0x0d, 0x11, 0x10,
  ]);

  const MAX_DOTCODE_IMAGE_PIXELS = 60_000_000;
  const MAX_CANVAS_DIMENSION = 32_767;
  const MAX_SVG_FILE_BYTES = 32 * 1024 * 1024;
  const DEFAULT_SVG_RASTER_DPI = 1200;
  const MAX_SVG_RASTER_DPI = 9600;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
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
  allowSvgCssFunctions(
    ["fill", "stroke"],
    ["url", ...SAFE_CSS_COLOR_FUNCTIONS],
  );
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

  const constants = Object.freeze({
    SVG_EXTENSION,
    RAW_METADATA_ID,
    DOTCODE_BYTES_PER_BLOCK,
    DOTCODE_RENDER_DPI,
    DOTCODE_RENDER_SCALE,
    DOTCODE_GRID_DPI,
    DOTCODE_DATA_DOT_SIZE,
    DOTCODE_DATA_DOT_RADIUS,
    DOTCODE_SYNC_MARKER_DIAMETER,
    MAX_DOTCODE_IMAGE_PIXELS,
    MAX_CANVAS_DIMENSION,
    MAX_SVG_FILE_BYTES,
    DEFAULT_SVG_RASTER_DPI,
    MAX_SVG_RASTER_DPI,
    SVG_NAMESPACE,
  });

  function extensionOf(filename) {
    const match = /\.([^.]+)$/.exec(filename);
    return match ? `.${match[1].toLocaleLowerCase("en-US")}` : "";
  }

  function isSvgFile(file) {
    const filename = typeof file === "string" ? file : file && file.name;
    return typeof filename === "string" && extensionOf(filename) === SVG_EXTENSION;
  }

  function decodeSvgText(bytes, label) {
    let encoding = "utf-8";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = "utf-16le";
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = "utf-16be";
    } else if (
      bytes.length >= 4
      && bytes[0] === 0x3c
      && bytes[1] === 0x00
      && bytes[2] !== 0x00
      && bytes[3] === 0x00
    ) {
      encoding = "utf-16le";
    } else if (
      bytes.length >= 4
      && bytes[0] === 0x00
      && bytes[1] === 0x3c
      && bytes[2] === 0x00
      && bytes[3] !== 0x00
    ) {
      encoding = "utf-16be";
    }
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} is not valid ${encoding.toUpperCase()} XML: ${message}`);
    }
  }

  function xmlError(label, detail) {
    return new Error(`${label} has malformed RAW metadata: ${detail}`);
  }

  function findXmlTagEnd(source, start, label) {
    let quote = "";
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) {
          quote = "";
        } else if (character === "<") {
          throw xmlError(label, "an attribute value contains '<'");
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        return index;
      }
    }
    throw xmlError(label, "an XML tag is not terminated");
  }

  function decodeXmlAttribute(value, label) {
    let result = "";
    let offset = 0;
    const referencePattern = /&([^;]+);/g;
    let match;
    while ((match = referencePattern.exec(value)) !== null) {
      if (value.slice(offset, match.index).includes("&")) {
        throw xmlError(label, "an attribute contains an invalid entity reference");
      }
      result += value.slice(offset, match.index);
      const reference = match[1];
      const named = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"',
      }[reference];
      if (named !== undefined) {
        result += named;
      } else {
        const numeric = /^#([0-9]+)$/.exec(reference);
        const hexadecimal = /^#x([0-9a-f]+)$/i.exec(reference);
        const codePoint = numeric
          ? Number.parseInt(numeric[1], 10)
          : hexadecimal
            ? Number.parseInt(hexadecimal[1], 16)
            : -1;
        if (
          !Number.isInteger(codePoint)
          || codePoint <= 0
          || codePoint > 0x10ffff
          || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          throw xmlError(label, `unsupported entity reference '&${reference};'`);
        }
        result += String.fromCodePoint(codePoint);
      }
      offset = match.index + match[0].length;
    }
    if (value.slice(offset).includes("&")) {
      throw xmlError(label, "an attribute contains an unterminated entity reference");
    }
    return result + value.slice(offset);
  }

  function parseXmlStartTag(source, start, end, label) {
    let offset = start + 1;
    const nameMatch = XML_NAME_PATTERN.exec(source.slice(offset));
    if (!nameMatch) {
      throw xmlError(label, "an XML element has no valid name");
    }
    const name = nameMatch[0];
    offset += name.length;
    const attributes = new Map();
    let selfClosing = false;

    while (offset < end) {
      let hadWhitespace = false;
      while (offset < end && XML_WHITESPACE_PATTERN.test(source[offset])) {
        hadWhitespace = true;
        offset += 1;
      }
      if (offset >= end) {
        break;
      }
      if (source[offset] === "/") {
        if (source.slice(offset + 1, end).trim() !== "") {
          throw xmlError(label, "a self-closing XML tag has trailing data");
        }
        selfClosing = true;
        offset = end;
        break;
      }
      if (!hadWhitespace) {
        throw xmlError(label, `attributes on <${name}> are not separated by whitespace`);
      }
      const attributeMatch = XML_NAME_PATTERN.exec(source.slice(offset));
      if (!attributeMatch) {
        throw xmlError(label, `<${name}> contains an invalid attribute name`);
      }
      const attributeName = attributeMatch[0];
      offset += attributeName.length;
      while (offset < end && XML_WHITESPACE_PATTERN.test(source[offset])) {
        offset += 1;
      }
      if (source[offset] !== "=") {
        throw xmlError(label, `attribute '${attributeName}' has no value`);
      }
      offset += 1;
      while (offset < end && XML_WHITESPACE_PATTERN.test(source[offset])) {
        offset += 1;
      }
      const quote = source[offset];
      if (quote !== '"' && quote !== "'") {
        throw xmlError(label, `attribute '${attributeName}' is not quoted`);
      }
      const valueStart = offset + 1;
      const valueEnd = source.indexOf(quote, valueStart);
      if (valueEnd < 0 || valueEnd > end) {
        throw xmlError(label, `attribute '${attributeName}' is not terminated`);
      }
      if (attributes.has(attributeName)) {
        throw xmlError(label, `attribute '${attributeName}' occurs more than once`);
      }
      attributes.set(
        attributeName,
        decodeXmlAttribute(source.slice(valueStart, valueEnd), label),
      );
      offset = valueEnd + 1;
    }
    return { name, attributes, selfClosing };
  }

  function parseXmlEndTag(source, start, end, label) {
    const contents = source.slice(start + 2, end).trim();
    const match = XML_NAME_PATTERN.exec(contents);
    if (!match || match[0].length !== contents.length) {
      throw xmlError(label, "an XML closing tag is malformed");
    }
    return match[0];
  }

  function localXmlName(name) {
    return name.slice(name.lastIndexOf(":") + 1);
  }

  function dotcodeAddressPair(address) {
    let left = 0;
    let right = 0x3ff;
    for (let value = 1; value <= address + 1; value += 1) {
      left = right;
      let base = 0x769;
      right = (left ^ ((value & -value) * base)) >>> 0;
      for (let mask = 0x1fff, bits = 0x651; bits > 0; mask >>>= 1, bits >>>= 1) {
        if ((value & mask) === 0) {
          if (bits & 1) {
            right = (right ^ base) >>> 0;
          }
          base = (base << 1) >>> 0;
        }
      }
    }
    return [left, right];
  }

  function dotcodeDataPosition(index) {
    if (index < 78) {
      return [9 + (index % 26), 6 + Math.floor(index / 26)];
    }
    if (index < 962) {
      const middleIndex = index - 78;
      return [5 + (middleIndex % 34), 9 + Math.floor(middleIndex / 34)];
    }
    const bottomIndex = index - 962;
    return [9 + (bottomIndex % 26), 35 + Math.floor(bottomIndex / 26)];
  }

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
    const hasParserError = !root
      || root.localName === "parsererror"
      || Array.from(documentNode.getElementsByTagName("*")).some(
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
        throw svgRasterError(
          label,
          `${functionName}() is not allowed in imported SVG styles`,
        );
      }
    }
    assertSafeCssReferences(value, label);
    if (property.startsWith("--")) {
      throw svgRasterError(label, "CSS custom properties are not allowed in imported SVG images");
    }
    if (!SAFE_SVG_CSS_PROPERTIES.has(property)) {
      throw svgRasterError(
        label,
        `CSS property ${property} is not allowed in imported SVG images`,
      );
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
      if (!document.implementation || typeof document.implementation.createHTMLDocument !== "function") {
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
      serializedRules.push(
        `${rule.selectorText}{${sanitizedCssDeclaration(rule.style, label)}}`,
      );
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
          (attribute.name || "").toLowerCase() === "xml:base"
          || (attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace"
            && attributeName === "base")
        ) {
          throw svgRasterError(label, "xml:base is not allowed in imported SVG images");
        }
        if (
          (attributeName === "href" || attributeName === "src")
          && attribute.value.trim() !== ""
          && !attribute.value.trim().startsWith("#")
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
    const parts = value.trim().split(/[\s,]+/).map(Number);
    if (
      parts.length !== 4
      || !parts.every(Number.isFinite)
      || parts[2] <= 0
      || parts[3] <= 0
    ) {
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
    const defaultWidth = 300 * dpi / 96;
    const defaultHeight = 150 * dpi / 96;
    let width = svgLengthInPixels(root.getAttribute("width"), dpi, label, "width");
    let height = svgLengthInPixels(root.getAttribute("height"), dpi, label, "height");

    if (width === null && height === null) {
      width = defaultWidth;
      height = defaultHeight;
    } else if (width === null) {
      width = viewBox ? height * viewBox.width / viewBox.height : defaultWidth;
    } else if (height === null) {
      height = viewBox ? width * viewBox.height / viewBox.width : defaultHeight;
    }

    width = Math.round(width);
    height = Math.round(height);
    const pixelCount = width * height;
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || width > MAX_CANVAS_DIMENSION
      || height > MAX_CANVAS_DIMENSION
      || !Number.isSafeInteger(pixelCount)
      || pixelCount > MAX_DOTCODE_IMAGE_PIXELS
    ) {
      throw svgRasterError(
        label,
        `the requested dimensions (${width} x ${height}) are too large`,
      );
    }
    return { width, height };
  }

  function createSvgServices(patcher, { readFileBytes } = {}) {
    if (
      !patcher
      || typeof patcher.asBytes !== "function"
      || typeof patcher.inspectRawDotcode !== "function"
      || typeof patcher.crc32 !== "function"
      || typeof patcher.bytesToHex !== "function"
      || typeof patcher.PatcherError !== "function"
      || !patcher.constants
      || !Number.isInteger(patcher.constants.RAW_LONG_SIZE)
      || !Number.isInteger(patcher.constants.RAW_SHORT_SIZE)
    ) {
      throw new TypeError("A complete e-Reader patcher API is required");
    }
    if (readFileBytes !== undefined && typeof readFileBytes !== "function") {
      throw new TypeError("SVG byte reader must be a function");
    }

    const {
      PatcherError,
      asBytes,
      bytesToHex,
      crc32,
      inspectRawDotcode,
    } = patcher;

    function parseRawMetadataCandidate(candidate, label) {
      const { attributes } = candidate;
      const encoding = attributes.get("data-encoding");
      if (typeof encoding !== "string" || encoding.toLowerCase() !== "hex") {
        throw xmlError(label, "expected data-encoding='hex'");
      }
      const byteLengthText = attributes.get("data-byte-length");
      if (!/^(?:0|[1-9][0-9]*)$/.test(byteLengthText || "")) {
        throw xmlError(label, "data-byte-length is not a decimal byte count");
      }
      const byteLength = Number(byteLengthText);
      if (
        byteLength !== patcher.constants.RAW_LONG_SIZE
        && byteLength !== patcher.constants.RAW_SHORT_SIZE
      ) {
        throw xmlError(
          label,
          `embedded RAW length ${byteLength} is not a supported long or short strip`,
        );
      }
      if (candidate.hasChildElement) {
        throw xmlError(label, "the RAW hex payload must not contain child elements");
      }
      const hex = candidate.text.replace(/[\t\n\r ]/g, "");
      if (!/^[0-9a-f]*$/i.test(hex)) {
        throw xmlError(label, "the RAW payload contains non-hexadecimal characters");
      }
      if (hex.length !== byteLength * 2) {
        throw xmlError(
          label,
          `mismatched byte length (declared ${byteLength}, found ${hex.length / 2})`,
        );
      }
      const raw = new Uint8Array(byteLength);
      for (let index = 0; index < byteLength; index += 1) {
        raw[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }

      const expectedCrc = attributes.get("data-crc32");
      if (!/^[0-9a-f]{8}$/i.test(expectedCrc || "")) {
        throw xmlError(
          label,
          "data-crc32 is required and must contain exactly eight hexadecimal digits",
        );
      }
      const actualCrc = crc32(raw).toString(16).padStart(8, "0");
      if (actualCrc.toLowerCase() !== expectedCrc.toLowerCase()) {
        throw xmlError(label, "the embedded RAW CRC32 does not match its payload");
      }
      try {
        inspectRawDotcode(raw, `${label} embedded RAW metadata`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw xmlError(label, `the embedded RAW strip is invalid (${message})`);
      }
      return raw;
    }

    function extractSvgRawMetadata(svgText, label = "SVG input") {
      if (typeof svgText !== "string") {
        throw new TypeError("SVG input must be text");
      }
      const stack = [];
      const candidates = [];
      let activeCandidate = null;
      let offset = 0;
      let rootSeen = false;
      let rootClosed = false;

      function appendText(value) {
        if (activeCandidate) {
          activeCandidate.text += value;
        } else if (stack.length === 0 && value.trim() !== "") {
          throw xmlError(label, "non-whitespace text occurs outside the root element");
        }
      }

      while (offset < svgText.length) {
        const tagStart = svgText.indexOf("<", offset);
        if (tagStart < 0) {
          appendText(svgText.slice(offset));
          offset = svgText.length;
          break;
        }
        appendText(svgText.slice(offset, tagStart));

        if (svgText.startsWith("<!--", tagStart)) {
          const end = svgText.indexOf("-->", tagStart + 4);
          if (end < 0) {
            throw xmlError(label, "an XML comment is not terminated");
          }
          offset = end + 3;
          continue;
        }
        if (svgText.startsWith("<![CDATA[", tagStart)) {
          const end = svgText.indexOf("]]>", tagStart + 9);
          if (end < 0) {
            throw xmlError(label, "a CDATA section is not terminated");
          }
          appendText(svgText.slice(tagStart + 9, end));
          offset = end + 3;
          continue;
        }
        if (svgText.startsWith("<?", tagStart)) {
          const end = svgText.indexOf("?>", tagStart + 2);
          if (end < 0) {
            throw xmlError(label, "an XML processing instruction is not terminated");
          }
          offset = end + 2;
          continue;
        }
        if (svgText.startsWith("<!", tagStart)) {
          throw xmlError(label, "document type and entity declarations are not allowed");
        }

        const tagEnd = findXmlTagEnd(svgText, tagStart + 1, label);
        if (svgText.startsWith("</", tagStart)) {
          const name = parseXmlEndTag(svgText, tagStart, tagEnd, label);
          const open = stack.pop();
          if (!open || open.name !== name) {
            throw xmlError(label, `closing tag </${name}> does not match its opening tag`);
          }
          if (open.candidate) {
            activeCandidate = null;
          }
          if (stack.length === 0) {
            rootClosed = true;
          }
        } else {
          if (rootClosed) {
            throw xmlError(label, "more than one root element is present");
          }
          const parsed = parseXmlStartTag(svgText, tagStart, tagEnd, label);
          if (stack.length === 0) {
            if (rootSeen || localXmlName(parsed.name) !== "svg") {
              throw xmlError(label, "the document root is not a single <svg> element");
            }
            rootSeen = true;
          }
          if (activeCandidate) {
            activeCandidate.hasChildElement = true;
          }
          let candidate = null;
          if (
            localXmlName(parsed.name) === "metadata"
            && parsed.attributes.get("id") === RAW_METADATA_ID
          ) {
            candidate = {
              attributes: parsed.attributes,
              hasChildElement: false,
              text: "",
            };
            candidates.push(candidate);
            if (!parsed.selfClosing) {
              activeCandidate = candidate;
            }
          }
          if (!parsed.selfClosing) {
            stack.push({ name: parsed.name, candidate });
          } else if (stack.length === 0) {
            rootClosed = true;
          }
        }
        offset = tagEnd + 1;
      }

      if (!rootSeen || !rootClosed || stack.length !== 0) {
        throw xmlError(label, "the SVG XML document is incomplete");
      }
      if (candidates.length === 0) {
        return null;
      }
      if (candidates.length !== 1) {
        throw xmlError(label, "more than one e-Reader RAW metadata element is present");
      }
      return parseRawMetadataCandidate(candidates[0], label);
    }

    function prepareSvgInput(bytesInput, label = "SVG input") {
      const bytes = asBytes(bytesInput, "SVG input");
      const source = decodeSvgText(bytes, label);
      return Object.freeze({
        bytes,
        source,
        rawMetadata: extractSvgRawMetadata(source, label),
      });
    }

    async function readSvgFileBytes(file) {
      if (readFileBytes) {
        return asBytes(await readFileBytes(file), file.name);
      }
      try {
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file.name} could not be read: ${message}`);
      }
    }

    async function readSvgInput(file) {
      if (!isSvgFile(file)) {
        throw new TypeError("SVG input can only be read from an .svg file");
      }
      const bytes = await readSvgFileBytes(file);
      return prepareSvgInput(bytes, file.name);
    }

    function rawDotcodeToSvg(rawInput, label = "RAW input", options = {}) {
      const raw = asBytes(rawInput, "RAW input");
      const metadata = inspectRawDotcode(raw, label);
      const embeddedTitle = metadata.titleEncoding !== "none"
        && metadata.titleEncoding !== "generic card-type name"
        ? metadata.embeddedTitle
        : "";
      const dotcodePosition = `(${metadata.cardIndex}/${metadata.cardCount})`;
      const documentTitle = embeddedTitle
        ? `Nintendo e-Reader dot code: ${embeddedTitle} ${dotcodePosition}`
        : `Nintendo e-Reader dot code ${dotcodePosition}`;
      const escapedDocumentTitle = documentTitle
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      const blockCount = raw.length / DOTCODE_BYTES_PER_BLOCK;
      const logicalWidth = blockCount * 35 + 9;
      const logicalHeight = 44;
      const viewWidth = logicalWidth * DOTCODE_RENDER_SCALE;
      const viewHeight = logicalHeight * DOTCODE_RENDER_SCALE;
      const configuredDotSize = options && options.dotSize !== undefined
        ? Number(options.dotSize)
        : DOTCODE_DATA_DOT_SIZE;
      if (!Number.isFinite(configuredDotSize)
          || configuredDotSize <= 0
          || configuredDotSize >= DOTCODE_RENDER_SCALE) {
        throw new PatcherError(
          `dotSize must be greater than 0 and smaller than ${DOTCODE_RENDER_SCALE}`,
        );
      }
      const dotSize = configuredDotSize;
      const configuredDotRadius = options && options.dotRadius !== undefined
        ? Number(options.dotRadius)
        : DOTCODE_DATA_DOT_RADIUS;
      if (!Number.isFinite(configuredDotRadius) || configuredDotRadius < 0) {
        throw new PatcherError("dotRadius must be a finite number greater than or equal to 0");
      }
      const dotInset = (DOTCODE_RENDER_SCALE - dotSize) / 2;
      const dotCornerRadius = Math.min(dotSize / 2, configuredDotRadius);
      const svgNumber = (value) => {
        const rounded = Math.round(value * 10000) / 10000;
        return Object.is(rounded, -0) ? "0" : String(rounded);
      };
      const widthPoints = (viewWidth * 72 / DOTCODE_RENDER_DPI).toFixed(2);
      const heightPoints = (viewHeight * 72 / DOTCODE_RENDER_DPI).toFixed(2);
      const dots = new Set();
      const addDot = (x, y) => dots.add(`${x},${y}`);

      const startAddress = raw[DOTCODE_BYTES_PER_BLOCK + 1];
      for (let block = 0; block < blockCount; block += 1) {
        const leftX = block * 35 + 4;
        const rightX = (block + 1) * 35 + 4;
        addDot(leftX, 9);
        addDot(rightX, 9);
        const addresses = dotcodeAddressPair(startAddress + block);
        for (let bit = 0; bit < 16; bit += 1) {
          if (addresses[0] & (1 << bit)) {
            addDot(leftX, 33 - bit);
          }
          if (addresses[1] & (1 << bit)) {
            addDot(rightX, 33 - bit);
          }
        }

        for (let index = 0; index <= 5; index += 1) {
          for (const x of [block * 35 + 10 + index * 2, block * 35 + 23 + index * 2]) {
            addDot(x, 4);
            addDot(x, 39);
          }
        }

        let sampleIndex = 0;
        const blockOffset = block * DOTCODE_BYTES_PER_BLOCK;
        for (let byteIndex = 0; byteIndex < DOTCODE_BYTES_PER_BLOCK; byteIndex += 1) {
          const value = raw[blockOffset + byteIndex];
          for (const nibble of [value >>> 4, value & 0x0f]) {
            const symbol = DOTCODE_MODULATION[nibble];
            for (let bit = 4; bit >= 0; bit -= 1) {
              if (symbol & (1 << bit)) {
                const [x, y] = dotcodeDataPosition(sampleIndex);
                addDot(block * 35 + x, y);
              }
              sampleIndex += 1;
            }
          }
        }
        if (sampleIndex !== 1040) {
          throw new Error("Generated dot-code block has an invalid modulation size");
        }
      }

      const markerRadius = DOTCODE_SYNC_MARKER_DIAMETER / 2;
      const markerElements = [];
      for (let marker = 0; marker <= blockCount; marker += 1) {
        const centerX = (marker * 35 + 4.5) * DOTCODE_RENDER_SCALE;
        for (const centerY of [
          4.5 * DOTCODE_RENDER_SCALE,
          39.5 * DOTCODE_RENDER_SCALE,
        ]) {
          markerElements.push(
            `<circle cx="${svgNumber(centerX)}" cy="${svgNumber(centerY)}"`
              + ` r="${svgNumber(markerRadius)}"/>`,
          );
        }
      }

      const dotElements = Array.from(dots, (coordinate) => {
        const [x, y] = coordinate.split(",").map(Number);
        const left = x * DOTCODE_RENDER_SCALE + dotInset;
        const top = y * DOTCODE_RENDER_SCALE + dotInset;
        return (
          `<rect x="${svgNumber(left)}" y="${svgNumber(top)}"`
          + ` width="${svgNumber(dotSize)}" height="${svgNumber(dotSize)}"`
          + ` rx="${svgNumber(dotCornerRadius)}" ry="${svgNumber(dotCornerRadius)}"/>`
        );
      });
      const vectorPaths = [
        '<g fill="#000000" stroke="none" stroke-width="0"'
          + ' shape-rendering="geometricPrecision">',
        ...markerElements,
        "</g>",
      ];
      const elementsPerGroup = 512;
      for (let offset = 0; offset < dotElements.length; offset += elementsPerGroup) {
        vectorPaths.push(
          '<g fill="#000000" stroke="none" stroke-width="0"'
            + ' shape-rendering="geometricPrecision">',
          ...dotElements.slice(offset, offset + elementsPerGroup),
          "</g>",
        );
      }

      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${widthPoints}pt"`
          + ` height="${heightPoints}pt" viewBox="0 0 ${viewWidth} ${viewHeight}"`
          + ' shape-rendering="geometricPrecision" color-interpolation="sRGB"'
          + ` data-dpi="${DOTCODE_RENDER_DPI}"`
          + ` data-raster-dpi="${DOTCODE_RENDER_DPI}"`
          + ` data-grid-dpi="${DOTCODE_GRID_DPI.toFixed(6)}"`
          + ` data-grid-scale="${DOTCODE_RENDER_SCALE}"`
          + ` data-data-dot-size="${dotSize}"`
          + ' data-data-dot-shape="rounded-square"'
          + ` data-data-dot-radius="${svgNumber(dotCornerRadius)}"`
          + ' data-sync-marker-shape="circle"'
          + ` data-sync-marker-diameter="${svgNumber(DOTCODE_SYNC_MARKER_DIAMETER)}">`,
        `<title>${escapedDocumentTitle}</title>`,
        `<metadata id="${RAW_METADATA_ID}" data-encoding="hex"`
          + ` data-byte-length="${raw.length}"`
          + ` data-crc32="${crc32(raw).toString(16).toUpperCase().padStart(8, "0")}">`
          + `${bytesToHex(raw)}</metadata>`,
        `<desc>Original-size, binary black-and-white dot code. Rasterize at `
          + `${DOTCODE_RENDER_DPI} ppi without resampling.</desc>`,
        `<rect width="${viewWidth}" height="${viewHeight}" fill="#ffffff"`
          + ' stroke="none" stroke-width="0" shape-rendering="crispEdges"/>',
        ...vectorPaths,
        "</svg>",
        "",
      ].join("\n");
    }

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

    return Object.freeze({
      rawDotcodeToSvg,
      isSvgFile,
      decodeSvgText,
      prepareSvgInput,
      extractSvgRawMetadata,
      readSvgInput,
      loadSvgImagePixels,
    });
  }

  return Object.freeze({ constants, createSvgServices });
});
