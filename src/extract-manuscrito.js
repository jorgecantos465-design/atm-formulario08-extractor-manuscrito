const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const JSZip = require("jszip");

let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch (_) {
  pdfParse = null;
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const INPUT_DIR = path.join(PROJECT_ROOT, "input");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
const DEBUG_DIR = path.join(PROJECT_ROOT, "debug");
const TEMPLATE_DIR = path.join(PROJECT_ROOT, "templates");
const LOG_DIR = path.join(PROJECT_ROOT, "logs");
const MAPPING_PATH = path.join(__dirname, "field-mapping.json");

loadDotEnv(path.join(PROJECT_ROOT, ".env"));

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);
const CONFIDENCE = ["alta", "media", "baja", "baja_confianza"];
const PLACEHOLDER_ROW = 2;
const FIRST_DATA_ROW = 3;
const INICIADOR_PLACEHOLDER = "@atributo10@";
const DATE_PLACEHOLDERS = new Set(["@atributo17@", "@atributo30@"]);
const NEVER_FILL = new Set([
  "@atributo23@",
  "@atributo24@",
  "@atributo25@",
  "@atributo26@",
  "@atributo27@",
  "@atributo32@",
  "@atributo34@",
]);
const OCR_MIN_CHARS = 50;
const OCR_MIN_WORDS = 8;
const OCR_HARD_FAIL_CHARS = 50;
const OCR_MODE = String(process.env.MANUSCRITO_OCR_MODE || "openai_vision").toLowerCase();
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const OCR_FAILURE_MESSAGE = "NO SE DETECTARON DATOS SUFICIENTES DEL FORMULARIO";
const OCR_ENGINE_FAILURE_MESSAGE = "Falla de OCR: el motor actual no puede leer este manuscrito con precision suficiente.";
const VISION_API_KEY_MESSAGE = "Falta configurar OPENAI_API_KEY para usar extraccion manuscrita con Vision AI";

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null && process.env[key] !== "") continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

const TEMPLATE_PLACEHOLDERS = [
  "@usuario@",
  "@apellido@",
  "@nombre@",
  "@email@",
  "@atributo8@",
  "@atributo9@",
  "@atributo7@",
  "@atributo10@",
  "@atributo11@",
  "@atributo12@",
  "@atributo13@",
  "@atributo14@",
  "@atributo15@",
  "@atributo16@",
  "@atributo17@",
  "@atributo18@",
  "@atributo19@",
  "@atributo20@",
  "@atributo21@",
  "@atributo22@",
  "@atributo30@",
  "@atributo33@",
];

function ensureDirs() {
  for (const dir of [INPUT_DIR, OUTPUT_DIR, DEBUG_DIR, TEMPLATE_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let counter = 1;
  let candidate = path.join(dir, `${base}_${counter}${ext}`);
  while (fs.existsSync(candidate)) {
    counter += 1;
    candidate = path.join(dir, `${base}_${counter}${ext}`);
  }
  return candidate;
}

function moveExistingAuxiliaryOutputFiles() {
  const archiveDir = path.join(DEBUG_DIR, "archived-output");
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/\.ods$/i.test(entry.name)) continue;
    const source = path.join(OUTPUT_DIR, entry.name);
    const target = uniquePath(path.join(archiveDir, entry.name));
    fs.renameSync(source, target);
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function compactText(text) {
  return normalizeText(text).split(/\n+/).map((line) => line.trim()).filter(Boolean).join(" ");
}

function stripAccents(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function columnName(columnNumber) {
  let value = columnNumber;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function safeValue(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) return null;
  return text;
}

function field(value, confidence, evidence = "", notes = "") {
  const normalizedConfidence = CONFIDENCE.includes(confidence) ? confidence : "baja_confianza";
  if (value == null || value === "") {
    return { value: null, confidence: "baja_confianza", evidence: evidence || null, notes: notes || "No legible o no encontrado." };
  }
  return { value, confidence: normalizedConfidence, evidence: evidence || null, notes: notes || null };
}

function emptyDetectedFields() {
  return {
    dominio: field(null, "baja"),
    numeroFormulario: field(null, "baja"),
    fecha: field(null, "baja"),
    cuitCuilCompradorAdquirente: field(null, "baja"),
    nombreCompletoCompradorAdquirente: field(null, "baja"),
    apellidoCompradorAdquirente: field(null, "baja"),
    nombreCompradorAdquirente: field(null, "baja"),
    domicilio: field(null, "baja"),
    localidad: field(null, "baja"),
    provincia: field(null, "baja"),
    codigoPostal: field(null, "baja"),
    correoElectronico: field(null, "baja"),
    telefono: field(null, "baja"),
    iniciadorNombre: field(null, "baja"),
    iniciadorCuitCuil: field(null, "baja"),
    iniciadorCaracter: field(null, "baja"),
    observacionesRelevantes: field(null, "baja"),
    expediente: field(null, "baja"),
    registro: field(null, "baja"),
    marcaModelo: field(null, "baja"),
    anio: field(null, "baja"),
    cuitCuilVendedor: field(null, "baja"),
    nombreVendedor: field(null, "baja"),
    fechaInicioTramite: field(null, "baja"),
    montoOperacion: field(null, "baja"),
  };
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function runTextCommand(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function responseText(responseJson) {
  if (responseJson.output_text) return responseJson.output_text;
  const chunks = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function structuredVisionToText(data) {
  const fields = data?.detectedFields || data?.fields || {};
  const lines = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    if (typeof value === "object" && value.value != null) lines.push(`${key}: ${value.value}`);
    else lines.push(`${key}: ${value}`);
  }
  if (Array.isArray(data?.rawLines)) lines.push(...data.rawLines);
  if (typeof data?.rawText === "string") lines.push(data.rawText);
  return normalizeText(lines.join("\n"));
}

async function runOpenAiVision(filePath, log) {
  const apiKey = getOpenAiApiKey();
  const model = OPENAI_VISION_MODEL;
  if (!apiKey) {
    log.push({
      phase: "vision_ai",
      status: "no_configurado",
      value: VISION_API_KEY_MESSAGE,
    });
    return {
      text: "",
      method: "openai_vision",
      diagnostic: {
        bestVariant: "openai_vision",
        bestImagePath: filePath,
        configurationError: VISION_API_KEY_MESSAGE,
        stats: textStats(""),
        variants: [{ variant: "openai_vision", chars: 0, words: 0, useful: false, blocks: 0, error: VISION_API_KEY_MESSAGE }],
      },
      blocks: [],
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  let workDir = null;
  let visionInputs = [];
  if (ext === ".pdf") {
    visionInputs = [
      {
        type: "input_file",
        filename: path.basename(filePath),
        file_data: `data:application/pdf;base64,${fs.readFileSync(filePath).toString("base64")}`,
      },
    ];
  } else if (!/^image\//.test(mimeTypeFor(filePath))) {
    log.push({ phase: "vision_ai", status: "formato_no_soportado", value: "OpenAI Vision requiere imagen o PDF renderizable." });
    return {
      text: "",
      method: "openai_vision",
      diagnostic: {
        bestVariant: "openai_vision",
        bestImagePath: filePath,
        stats: textStats(""),
        variants: [{ variant: "openai_vision", chars: 0, words: 0, useful: false, blocks: 0, error: "Formato no soportado por Vision AI" }],
      },
      blocks: [],
    };
  } else {
    visionInputs = [
      {
        type: "input_image",
        detail: "high",
        image_url: `data:${mimeTypeFor(filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`,
      },
    ];
  }

  const prompt = [
    "Lee la imagen completa de un Formulario 08 manuscrito argentino.",
    "No inventes datos. Devuelve candidatos aunque sean parciales o dudosos.",
    "Responde solo JSON con detectedFields, candidates, rawLines y rawText.",
    "Campos esperados: dominio, numeroFormulario, fecha, cuitCuilCompradorAdquirente, nombreCompletoCompradorAdquirente, domicilio, localidad, provincia, correoElectronico, telefono, iniciadorNombre, iniciadorCuitCuil, registro, marcaModelo, anio, cuitCuilVendedor, nombreVendedor, montoOperacion.",
    "Cada detectedFields.<campo> debe tener value, confidence y evidence.",
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              ...visionInputs,
            ],
          },
        ],
      }),
    });
    const responseJson = await response.json();
    if (!response.ok) {
      throw new Error(responseJson.error?.message || `OpenAI API HTTP ${response.status}`);
    }
    const raw = responseText(responseJson);
    let structured = null;
    try {
      structured = JSON.parse(raw);
    } catch (_) {
      structured = { rawText: raw };
    }
    const text = structuredVisionToText(structured) || raw;
    const stats = textStats(text);
    log.push({ phase: "vision_ai", status: stats.useful ? "texto_suficiente" : "texto_insuficiente", chars: stats.chars, words: stats.words });
    return {
      text,
      method: "openai_vision",
      diagnostic: {
        bestVariant: "openai_vision",
        bestImagePath: filePath,
        workDir,
        stats,
        visionStructured: structured,
        variants: [{ variant: "openai_vision", chars: stats.chars, words: stats.words, useful: stats.useful, blocks: 0, error: null }],
      },
      blocks: [],
    };
  } catch (error) {
    log.push({ phase: "vision_ai", status: "error", value: error.message });
    return {
      text: "",
      method: "openai_vision",
      diagnostic: {
        bestVariant: "openai_vision",
        bestImagePath: filePath,
        workDir,
        stats: textStats(""),
        variants: [{ variant: "openai_vision", chars: 0, words: 0, useful: false, blocks: 0, error: error.message }],
      },
      blocks: [],
    };
  }
}

function textStats(text) {
  const normalized = normalizeText(text);
  const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  return {
    chars: normalized.length,
    words: words.length,
    useful: normalized.length >= OCR_MIN_CHARS && words.length >= OCR_MIN_WORDS,
  };
}

function parseTesseractTsv(tsv) {
  const lines = String(tsv || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t");
  const index = Object.fromEntries(headers.map((name, i) => [name, i]));
  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const text = (cols[index.text] || "").trim();
    return {
      level: Number(cols[index.level] || 0),
      page: Number(cols[index.page_num] || 0),
      block: Number(cols[index.block_num] || 0),
      paragraph: Number(cols[index.par_num] || 0),
      line: Number(cols[index.line_num] || 0),
      word: Number(cols[index.word_num] || 0),
      left: Number(cols[index.left] || 0),
      top: Number(cols[index.top] || 0),
      width: Number(cols[index.width] || 0),
      height: Number(cols[index.height] || 0),
      confidence: Number(cols[index.conf] || -1),
      text,
    };
  }).filter((block) => block.text);
}

function ocrImageDetailed(imagePath, variantName, log) {
  const result = { variant: variantName, imagePath, text: "", stats: textStats(""), blocks: [], error: null };
  if (!commandExists("tesseract")) {
    result.error = "No se encontro tesseract en PATH.";
    log.push({ phase: "ocr", variant: variantName, status: "no_disponible", value: result.error });
    return result;
  }

  try {
    result.text = normalizeText(runTextCommand("tesseract", [imagePath, "stdout", "-l", "spa+eng", "--psm", "6"]));
    result.stats = textStats(result.text);
  } catch (error) {
    result.error = error.message;
  }

  try {
    const tsv = runTextCommand("tesseract", [imagePath, "stdout", "-l", "spa+eng", "--psm", "6", "tsv"]);
    result.blocks = parseTesseractTsv(tsv);
  } catch (error) {
    if (!result.error) result.error = `TSV: ${error.message}`;
  }

  log.push({
    phase: "ocr",
    variant: variantName,
    status: result.stats.useful ? "texto_suficiente" : result.text ? "texto_insuficiente" : "sin_texto",
    chars: result.stats.chars,
    words: result.stats.words,
    blocks: result.blocks.length,
    error: result.error,
  });
  return result;
}

function makeImageVariants(imagePath, workDir, log) {
  const variants = [{ name: "original", path: imagePath, operation: "sin_modificar" }];
  if (!commandExists("magick")) {
    log.push({ phase: "preprocess", status: "no_disponible", value: "No se encontro magick en PATH. Solo se prueba imagen original." });
    return variants;
  }

  const specs = [
    { name: "grayscale", args: ["-colorspace", "Gray"] },
    { name: "contrast", args: ["-colorspace", "Gray", "-contrast-stretch", "2%x2%"] },
    { name: "adaptive_threshold", args: ["-colorspace", "Gray", "-adaptive-threshold", "35x35+10%"] },
    { name: "scale_2x", args: ["-resize", "200%", "-colorspace", "Gray", "-sharpen", "0x1"] },
    { name: "scale_3x", args: ["-resize", "300%", "-colorspace", "Gray", "-sharpen", "0x1"] },
    { name: "deskew", args: ["-colorspace", "Gray", "-deskew", "40%"] },
    { name: "sharpen", args: ["-colorspace", "Gray", "-sharpen", "0x2"] },
  ];

  for (const spec of specs) {
    const outPath = path.join(workDir, `${spec.name}.png`);
    try {
      execFileSync("magick", [imagePath, ...spec.args, outPath], { stdio: "ignore" });
      variants.push({ name: spec.name, path: outPath, operation: spec.args.join(" ") });
      log.push({ phase: "preprocess", variant: spec.name, status: "generado", value: outPath });
    } catch (error) {
      log.push({ phase: "preprocess", variant: spec.name, status: "error", value: error.message });
    }
  }

  return variants;
}

function chooseBestOcrResult(results) {
  return [...results].sort((a, b) => {
    const scoreA = a.stats.chars + a.stats.words * 8 + a.blocks.length * 2;
    const scoreB = b.stats.chars + b.stats.words * 8 + b.blocks.length * 2;
    return scoreB - scoreA;
  })[0] || { text: "", stats: textStats(""), blocks: [], variant: "none", imagePath: null };
}

function acquireImageText(imagePath, log) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f08-ocr-variants-"));
  const variants = makeImageVariants(imagePath, workDir, log);
  const results = variants.map((variant) => ocrImageDetailed(variant.path, variant.name, log));
  const best = chooseBestOcrResult(results);
  log.push({
    phase: "ocr_best",
    status: best.stats.useful ? "texto_suficiente" : "texto_insuficiente",
    variant: best.variant,
    chars: best.stats.chars,
    words: best.stats.words,
    blocks: best.blocks.length,
  });
  if (!best.stats.useful) {
    log.push({ phase: "diagnostic", status: "ocr_insuficiente", value: "OCR no recupero texto suficiente del manuscrito." });
  }
  return {
    text: best.text,
    method: "image_ocr_multi_variant",
    diagnostic: {
      bestVariant: best.variant,
      bestImagePath: best.imagePath,
      workDir,
      stats: best.stats,
      variants: results.map((result) => ({
        variant: result.variant,
        imagePath: result.imagePath,
        chars: result.stats.chars,
        words: result.stats.words,
        useful: result.stats.useful,
        blocks: result.blocks.length,
        error: result.error,
        textPreview: result.text.slice(0, 500),
      })),
    },
    blocks: best.blocks,
  };
}

async function readPdfText(pdfPath, log) {
  if (!pdfParse) {
    log.push({ phase: "pdf_text", status: "omitido", value: "Dependencia pdf-parse no instalada." });
    return "";
  }
  const parsed = await pdfParse(fs.readFileSync(pdfPath));
  const text = normalizeText(parsed.text || "");
  log.push({ phase: "pdf_text", status: text ? "capturado" : "sin_texto_embebido", valueLength: text.length });
  return text;
}

function ocrImage(imagePath, log) {
  if (!commandExists("tesseract")) {
    log.push({ phase: "ocr", status: "no_disponible", value: "No se encontro tesseract en PATH." });
    return "";
  }

  const baseArgs = [imagePath, "stdout", "-l", "spa+eng", "--psm", "6"];
  try {
    const text = normalizeText(runTextCommand("tesseract", baseArgs));
    log.push({ phase: "ocr", status: text ? "capturado" : "sin_texto", valueLength: text.length });
    return text;
  } catch (error) {
    log.push({ phase: "ocr", status: "error", value: error.message });
    return "";
  }
}

function renderPdfForOcr(pdfPath, workDir, log) {
  const prefix = path.join(workDir, "page");
  if (commandExists("pdftoppm")) {
    try {
      execFileSync("pdftoppm", ["-png", "-r", "300", pdfPath, prefix], { stdio: "ignore" });
      const pages = fs.readdirSync(workDir).filter((name) => /^page-\d+\.png$/i.test(name)).sort().map((name) => path.join(workDir, name));
      log.push({ phase: "pdf_render", status: pages.length ? "capturado" : "sin_paginas", value: `pdftoppm paginas=${pages.length}` });
      return pages;
    } catch (error) {
      log.push({ phase: "pdf_render", status: "error_pdftoppm", value: error.message });
    }
  }

  if (commandExists("magick")) {
    try {
      const outputPattern = path.join(workDir, "page-%03d.png");
      execFileSync("magick", ["-density", "300", pdfPath, "-quality", "100", outputPattern], { stdio: "ignore" });
      const pages = fs.readdirSync(workDir).filter((name) => /^page-\d+\.png$/i.test(name)).sort().map((name) => path.join(workDir, name));
      log.push({ phase: "pdf_render", status: pages.length ? "capturado" : "sin_paginas", value: `magick paginas=${pages.length}` });
      return pages;
    } catch (error) {
      log.push({ phase: "pdf_render", status: "error_magick", value: error.message });
    }
  }

  log.push({ phase: "pdf_render", status: "no_disponible", value: "No se encontro pdftoppm ni magick para convertir PDF escaneado a imagen." });
  return [];
}

async function acquireClassicText(filePath, log) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const embeddedText = await readPdfText(filePath, log);
    const embeddedStats = textStats(embeddedText);
    if (embeddedStats.useful) {
      return {
        text: embeddedText,
        method: "pdf_text",
        diagnostic: { bestVariant: "pdf_embedded_text", bestImagePath: null, stats: embeddedStats, variants: [] },
        blocks: [],
      };
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f08-manuscrito-"));
    try {
      const pageImages = renderPdfForOcr(filePath, workDir, log);
      const pageResults = pageImages.map((imagePath) => acquireImageText(imagePath, log));
      const text = normalizeText(pageResults.map((result) => result.text).join("\n"));
      const blocks = pageResults.flatMap((result, pageIndex) => result.blocks.map((block) => ({ ...block, sourcePage: pageIndex + 1 })));
      const stats = textStats(text);
      if (!stats.useful) {
        log.push({ phase: "diagnostic", status: "ocr_insuficiente", value: "OCR no recupero texto suficiente del manuscrito." });
      }
      return {
        text,
        method: "pdf_ocr_multi_variant",
        diagnostic: { bestVariant: "pdf_pages", bestImagePath: pageResults[0]?.diagnostic.bestImagePath || null, stats, variants: pageResults.flatMap((result) => result.diagnostic.variants) },
        blocks,
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  return acquireImageText(filePath, log);
}

async function acquireText(filePath, log) {
  const apiKey = getOpenAiApiKey();
  log.push({
    phase: "configuration",
    status: apiKey ? "openai_api_key_detectada" : "openai_api_key_faltante",
    value: apiKey ? "process.env.OPENAI_API_KEY detectada" : VISION_API_KEY_MESSAGE,
  });

  if (apiKey) {
    const modeMessage = "Modo usado: OpenAI Vision";
    console.log(`${path.basename(filePath)}: ${modeMessage}`);
    log.push({ phase: "mode", status: "openai_vision", value: modeMessage });
    const visionResult = await runOpenAiVision(filePath, log);
    const visionStats = textStats(visionResult.text);
    if (visionStats.useful) return visionResult;

    log.push({
      phase: "mode",
      status: "fallback_ocr_clasico",
      value: "OpenAI Vision no devolvio texto suficiente; se intenta OCR clasico fallback.",
    });
    const fallbackResult = await acquireClassicText(filePath, log);
    return {
      ...fallbackResult,
      method: `${visionResult.method}_with_ocr_fallback`,
      diagnostic: {
        ...fallbackResult.diagnostic,
        primaryMethod: visionResult.method,
        primaryDiagnostic: visionResult.diagnostic,
      },
    };
  }

  const modeMessage = "Modo usado: OCR clásico fallback";
  console.error(`${path.basename(filePath)}: ${VISION_API_KEY_MESSAGE}`);
  console.log(`${path.basename(filePath)}: ${modeMessage}`);
  log.push({ phase: "mode", status: "ocr_clasico_fallback", value: modeMessage });
  const fallbackResult = await acquireClassicText(filePath, log);
  return {
    ...fallbackResult,
    diagnostic: {
      ...fallbackResult.diagnostic,
      configurationError: VISION_API_KEY_MESSAGE,
    },
  };
}

function cleanCuit(value) {
  const digits = String(value || "")
    .replace(/[IiLl]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 12) return null;
  if (digits.length !== 11) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function findCuits(text) {
  const matches = [];
  const source = String(text || "");
  const regex = /(?:^|[^\d])([0-9ISLl]{2}\s*[- ]?\s*[0-9ISLl]{7,9}\s*[- ]?\s*[0-9ISLl]?)(?=$|[^\d])/gi;
  for (const match of source.matchAll(regex)) {
    const cuit = cleanCuit(match[1]);
    if (cuit && !matches.includes(cuit)) matches.push(cuit);
  }
  return matches;
}

function findDnis(text) {
  const matches = [];
  const source = String(text || "");
  for (const match of source.matchAll(/(?:^|[^\d])(\d[\d .-]{5,10}\d)(?=$|[^\d])/g)) {
    const digits = match[1].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 9 && !matches.includes(digits)) {
      matches.push(digits);
    }
  }
  return matches;
}

function cleanDomain(value) {
  const raw = (String(value || "").match(/\b[A-Z]{3}\s*-?\s*\d{2,4}\b|\b[A-Z]{2}\s*-?\s*\d{2,4}\s*-?\s*[A-Z]{1,2}\b|\b[A-Z0-9]{5,8}\b/i) || [""])[0];
  const domain = raw.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (/^[A-Z]{3}\d{2,4}$/.test(domain) || /^[A-Z]{2}\d{2,4}[A-Z]{1,2}$/.test(domain) || /^[A-Z0-9]{5,8}$/.test(domain)) return domain;
  return null;
}

function cleanEmail(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].replace(/[.,;:]+$/g, "").toUpperCase() : null;
}

function cleanPhone(value) {
  const match = String(value || "").match(/(?:\+?54\s*)?(?:\(?0?\d{2,5}\)?[\s-]*)?\d{3,4}[\s-]?\d{4}/);
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

function cleanDate(value) {
  const match = String(value || "").match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${day}/${month}/${year}`;
}

function formatDateDdMmYy(value) {
  const dateText = cleanDate(value);
  const match = String(dateText || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  return `${match[1]}/${match[2]}/${match[3].slice(-2)}`;
}

function cleanPostalCode(value) {
  const match = String(value || "").match(/\b([A-Z]\d{4}[A-Z]{3}|\d{4})\b/i);
  return match ? match[1].toUpperCase() : null;
}

function firstLabelValue(text, labelRegexes, stopRegexes = []) {
  const lines = normalizeText(text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const labelRegex of labelRegexes) {
      const match = line.match(labelRegex);
      if (!match) continue;
      const sameLine = safeValue(line.slice(match.index + match[0].length).replace(/^[:.\-\s]+/, ""));
      if (sameLine) return { value: sameLine, evidence: line };
      const nextLine = lines[i + 1] || "";
      if (nextLine && !stopRegexes.some((stop) => stop.test(nextLine))) {
        const nextValue = safeValue(nextLine.replace(/^[:.\-\s]+/, ""));
        if (nextValue) return { value: nextValue, evidence: `${line} ${nextLine}` };
      }
    }
  }
  return { value: null, evidence: "" };
}

function firstRegexValue(text, regex, cleaner = (value) => safeValue(value)) {
  const source = compactText(text);
  const match = source.match(regex);
  if (!match) return { value: null, evidence: "" };
  return { value: cleaner(match[1] || match[0]), evidence: match[0] };
}

function confidenceFor(value, evidence, type = "generic") {
  if (!value) return "baja_confianza";
  if (type === "structured") return "alta";
  if (!evidence) return "media";
  const ratio = String(value).length / Math.max(String(evidence).length, 1);
  return ratio > 0.25 ? "media" : "baja_confianza";
}

function assignField(fields, key, candidate, type = "generic") {
  if (!candidate || !candidate.value) return;
  const notes = candidate.notes || "";
  fields[key] = field(candidate.value, candidate.confidence || confidenceFor(candidate.value, candidate.evidence, type), candidate.evidence, notes);
}

function linesNearLabels(text, labelRegexes, stopRegexes = [], windowSize = 2) {
  const lines = normalizeText(text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!labelRegexes.some((labelRegex) => labelRegex.test(line))) continue;
    const pieces = [];
    for (let offset = 0; offset <= windowSize; offset += 1) {
      const current = lines[i + offset];
      if (!current) continue;
      if (offset > 0 && stopRegexes.some((stop) => stop.test(current))) break;
      pieces.push(current);
    }
    const joined = safeValue(pieces.join(" ").replace(/^[^:.-]+[:.-]\s*/, ""));
    if (joined) candidates.push({ value: joined, evidence: pieces.join(" ") });
  }
  return candidates;
}

function relaxedTextValue(text) {
  const cleaned = String(text || "")
    .replace(/[_|~^*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.:;\-\s]+|[.:;\-\s]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length < 2) return null;
  return cleaned.toUpperCase();
}

function addRelaxedCandidate(debug, key, value, evidence, confidence, reason) {
  if (!value) {
    debug.discarded.push({ field: key, evidence: evidence || null, reason });
    return null;
  }
  const candidate = { value, evidence, confidence, notes: reason };
  debug.detected.push({ field: key, ...candidate });
  return candidate;
}

function applyRelaxedFallbacks(fields, text, sourceFile, debug) {
  const normalized = normalizeText(text);
  const compact = compactText(text);

  if (!fields.dominio.value) {
    const dominio = cleanDomain(compact);
    assignField(
      fields,
      "dominio",
      addRelaxedCandidate(debug, "dominio", dominio, dominio || compact, "baja_confianza", "Dominio/patente detectado con patron alfanumerico flexible.")
    );
  }

  const cuits = findCuits(compact);
  if (!fields.cuitCuilCompradorAdquirente.value && cuits[0]) {
    assignField(
      fields,
      "cuitCuilCompradorAdquirente",
      addRelaxedCandidate(debug, "cuitCuilCompradorAdquirente", cuits[0], cuits[0], "baja_confianza", "Numero largo aceptado como CUIT/CUIL posible.")
    );
  }
  if (!fields.iniciadorCuitCuil.value && cuits[1]) {
    assignField(
      fields,
      "iniciadorCuitCuil",
      addRelaxedCandidate(debug, "iniciadorCuitCuil", cuits[1], cuits[1], "baja_confianza", "Segundo numero largo aceptado como CUIT/CUIL posible.")
    );
  }

  const dnis = findDnis(compact);
  if (!fields.cuitCuilCompradorAdquirente.value && dnis[0]) {
    assignField(
      fields,
      "cuitCuilCompradorAdquirente",
      addRelaxedCandidate(debug, "cuitCuilCompradorAdquirente", dnis[0], dnis[0], "baja_confianza", "DNI posible usado como identificador parcial del comprador.")
    );
  }

  if (!fields.nombreCompletoCompradorAdquirente.value) {
    const candidate = linesNearLabels(
      normalized,
      [/APELLIDO/i, /NOMBRE/i, /COMPRADOR/i, /ADQUIRENTE/i],
      [/CUIT|CUIL|DNI|DOMICILIO|CALLE|LOCALIDAD|PROVINCIA|TELEFONO|EMAIL/i],
      2
    ).map((item) => ({ ...item, value: relaxedTextValue(item.value) })).find((item) => item.value && /[A-Z]{2}/i.test(item.value));
    assignField(
      fields,
      "nombreCompletoCompradorAdquirente",
      addRelaxedCandidate(
        debug,
        "nombreCompletoCompradorAdquirente",
        candidate?.value,
        candidate?.evidence,
        "baja_confianza",
        "Nombre aceptado por proximidad a etiqueta conocida."
      )
    );
  }

  if (!fields.domicilio.value) {
    const candidate = linesNearLabels(
      normalized,
      [/DOMICILIO/i, /CALLE/i, /DIRECCION/i, /LOCALIDAD/i],
      [/CUIT|CUIL|DNI|TELEFONO|EMAIL|PROVINCIA/i],
      2
    ).map((item) => ({ ...item, value: relaxedTextValue(item.value) })).find((item) => item.value);
    assignField(
      fields,
      "domicilio",
      addRelaxedCandidate(debug, "domicilio", candidate?.value, candidate?.evidence, "baja_confianza", "Direccion aceptada por proximidad a domicilio/calle/localidad.")
    );
  }

  if (!fields.numeroFormulario.value) {
    const match = compact.match(/\b(?:F(?:ORM)?\.?\s*0?8|FORMULARIO|SOLICITUD)\D{0,12}([A-Z0-9][A-Z0-9 .-]{4,18})/i);
    const value = match ? relaxedTextValue(match[1]).replace(/[^A-Z0-9-]/g, "") : null;
    assignField(
      fields,
      "numeroFormulario",
      addRelaxedCandidate(debug, "numeroFormulario", value, match?.[0], "baja_confianza", "Numero de formulario parcial detectado con etiqueta flexible.")
    );
  }

  return fields;
}

function collectUnvalidatedCandidates(text) {
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const labelCandidates = linesNearLabels(
    normalized,
    [/ADQUIRENTE/i, /COMPRADOR/i, /DOMICILIO/i, /DOMINIO/i, /MOTOR/i, /CHASIS/i, /TITULAR/i, /APELLIDO/i, /NOMBRE/i],
    [],
    2
  ).map((item) => ({ value: relaxedTextValue(item.value), evidence: item.evidence })).filter((item) => item.value);

  return {
    possibleCuitCuil: findCuits(compact),
    possibleDni: findDnis(compact),
    possibleDomains: [...new Set([...compact.matchAll(/\b[A-Z0-9]{5,8}\b/gi)].map((match) => match[0].toUpperCase()))],
    possibleExpedientes: [...new Set([...compact.matchAll(/\b(?:EXP(?:EDIENTE)?\.?\s*)?([A-Z0-9][A-Z0-9./-]{5,})\b/gi)].map((match) => match[1].toUpperCase()))],
    possibleNames: labelCandidates.filter((item) => /ADQUIRENTE|COMPRADOR|APELLIDO|NOMBRE|TITULAR/i.test(item.evidence)),
    possibleAddresses: labelCandidates.filter((item) => /DOMICILIO|CALLE|LOCALIDAD/i.test(item.evidence)),
    nearKnownLabels: labelCandidates,
  };
}

function valueFromVisionField(data) {
  if (data == null) return null;
  if (typeof data === "object" && !Array.isArray(data)) {
    if (data.value != null) return safeValue(data.value);
    if (data.text != null) return safeValue(data.text);
  }
  return safeValue(data);
}

function confidenceFromVisionField(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const raw = String(data.confidence || data.confianza || "").toLowerCase().replace(/\s+/g, "_");
    if (raw.includes("alta")) return "alta";
    if (raw.includes("media")) return "media";
    if (raw.includes("baja")) return "baja_confianza";
  }
  return "baja_confianza";
}

function evidenceFromVisionField(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data.evidence || data.evidencia || data.sourceText || data.raw || null;
  }
  return null;
}

function applyVisionStructuredFields(fields, structured, debug) {
  const detected = structured?.detectedFields || structured?.fields || {};
  const aliases = {
    dominio: ["dominio", "patente", "dominioPatente"],
    numeroFormulario: ["numeroFormulario", "nroFormulario", "formulario08", "numero_formulario"],
    fecha: ["fecha", "fechaFormulario", "lugarYFecha"],
    cuitCuilCompradorAdquirente: ["cuitCuilCompradorAdquirente", "cuitComprador", "cuilComprador", "dniComprador", "documentoComprador"],
    nombreCompletoCompradorAdquirente: ["nombreCompletoCompradorAdquirente", "comprador", "adquirente", "nombreComprador", "apellidoYNombreComprador"],
    apellidoCompradorAdquirente: ["apellidoCompradorAdquirente", "apellidoComprador"],
    nombreCompradorAdquirente: ["nombreCompradorAdquirente", "nombreComprador"],
    domicilio: ["domicilio", "domicilioComprador", "direccionComprador"],
    localidad: ["localidad"],
    provincia: ["provincia"],
    codigoPostal: ["codigoPostal", "cp"],
    correoElectronico: ["correoElectronico", "email", "mail"],
    telefono: ["telefono", "celular"],
    iniciadorNombre: ["iniciadorNombre", "iniciador", "presentante", "gestor"],
    iniciadorCuitCuil: ["iniciadorCuitCuil", "cuitIniciador", "cuilIniciador"],
    iniciadorCaracter: ["iniciadorCaracter", "caracter"],
    observacionesRelevantes: ["observacionesRelevantes", "observaciones", "notas"],
    expediente: ["expediente"],
    registro: ["registro", "registroSeccional"],
    marcaModelo: ["marcaModelo", "marca", "modelo", "marcaYModelo"],
    anio: ["anio", "ano", "modeloAnio"],
    cuitCuilVendedor: ["cuitCuilVendedor", "cuitVendedor", "cuilVendedor"],
    nombreVendedor: ["nombreVendedor", "vendedor"],
    fechaInicioTramite: ["fechaInicioTramite", "fechaInicio"],
    montoOperacion: ["montoOperacion", "monto", "precio"],
  };

  for (const [targetKey, sourceKeys] of Object.entries(aliases)) {
    if (fields[targetKey]?.value) continue;
    const sourceKey = sourceKeys.find((key) => Object.prototype.hasOwnProperty.call(detected, key));
    if (!sourceKey) continue;
    const rawField = detected[sourceKey];
    const value = valueFromVisionField(rawField);
    if (!value) continue;
    fields[targetKey] = field(value, confidenceFromVisionField(rawField), evidenceFromVisionField(rawField), "Extraido por Vision AI.");
    debug.detected.push({ field: targetKey, value, confidence: fields[targetKey].confidence, evidence: fields[targetKey].evidence, source: "vision_ai" });
  }

  return fields;
}

function extractDetectedFields(text, sourceFile = "") {
  const fields = emptyDetectedFields();
  const debug = { detected: [], discarded: [] };
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const plain = stripAccents(compact).toUpperCase();

  const dominio = cleanDomain(compact);
  if (dominio) fields.dominio = field(dominio, "alta", dominio);

  const numeroFormulario = firstRegexValue(compact, /\b(?:FORMULARIO|F\.?\s*08|08)\s*(?:N(?:RO|UM|°|º)?\.?|NUMERO)?\s*[:#-]?\s*([A-Z0-9-]{6,})\b/i, (value) => safeValue(value.toUpperCase()));
  assignField(fields, "numeroFormulario", numeroFormulario, "structured");

  const fecha = firstRegexValue(compact, /\b(?:FECHA|LUGAR\s+Y\s+FECHA|DIA)\s*[:.-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/i, cleanDate);
  if (fecha.value) assignField(fields, "fecha", fecha, "structured");
  else {
    const anyDate = firstRegexValue(compact, /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/i, cleanDate);
    assignField(fields, "fecha", anyDate, "structured");
  }

  const cuits = findCuits(compact);
  if (cuits[0]) fields.cuitCuilCompradorAdquirente = field(cuits[0], "media", cuits[0], "Primer CUIT/CUIL legible detectado; requiere revision humana.");
  if (cuits[1]) fields.iniciadorCuitCuil = field(cuits[1], "baja", cuits[1], "Segundo CUIT/CUIL legible detectado; confirmar si corresponde al iniciador.");
  if (cuits[2]) fields.cuitCuilVendedor = field(cuits[2], "baja", cuits[2], "Tercer CUIT/CUIL legible detectado; confirmar si corresponde al vendedor.");

  const comprador = firstLabelValue(normalized, [
    /(?:COMPRADOR|ADQUIRENTE|ADQUIRENTE\/COMPRADOR|APELLIDO\s+Y\s+NOMBRE|NOMBRE\s+Y\s+APELLIDO|RAZON\s+SOCIAL)\s*[:.-]?/i,
  ], [/CUIT|CUIL|DOMICILIO|LOCALIDAD|PROVINCIA|TELEFONO|EMAIL/i]);
  assignField(fields, "nombreCompletoCompradorAdquirente", comprador, "generic");

  const domicilio = firstLabelValue(normalized, [/DOMICILIO\s*[:.-]?/i], [/LOCALIDAD|PROVINCIA|CODIGO|C\.?P\.?|TELEFONO|EMAIL|CUIT|CUIL/i]);
  assignField(fields, "domicilio", domicilio, "generic");

  const localidad = firstLabelValue(normalized, [/LOCALIDAD\s*[:.-]?/i], [/PROVINCIA|CODIGO|C\.?P\.?|TELEFONO|EMAIL|CUIT|CUIL/i]);
  assignField(fields, "localidad", localidad, "generic");

  const provincia = firstLabelValue(normalized, [/PROVINCIA\s*[:.-]?/i], [/LOCALIDAD|CODIGO|C\.?P\.?|TELEFONO|EMAIL|CUIT|CUIL/i]);
  assignField(fields, "provincia", provincia, "generic");

  const codigoPostal = firstRegexValue(compact, /\b(?:C\.?P\.?|CODIGO\s+POSTAL)\s*[:.-]?\s*([A-Z]?\d{4}[A-Z]{0,3})\b/i, cleanPostalCode);
  assignField(fields, "codigoPostal", codigoPostal, "structured");

  const email = cleanEmail(compact);
  if (email) fields.correoElectronico = field(email, "alta", email);

  const telefono = firstRegexValue(compact, /\b(?:TEL(?:EFONO)?|CEL(?:ULAR)?)\s*[:.-]?\s*((?:\+?54\s*)?(?:\(?0?\d{2,5}\)?[\s-]*)?\d{3,4}[\s-]?\d{4})\b/i, cleanPhone);
  assignField(fields, "telefono", telefono, "structured");

  const iniciador = firstLabelValue(normalized, [/INICIADOR\s*[:.-]?/i, /PRESENTANTE\s*[:.-]?/i, /GESTOR\s*[:.-]?/i], [/CUIT|CUIL|CARACTER|REGISTRO|DOMICILIO/i]);
  assignField(fields, "iniciadorNombre", iniciador, "generic");

  const caracter = firstLabelValue(normalized, [/CARACTER\s*[:.-]?/i], [/INICIADOR|REGISTRO|DOMICILIO|CUIT|CUIL/i]);
  assignField(fields, "iniciadorCaracter", caracter, "generic");

  const registro = firstLabelValue(normalized, [/REGISTRO\s*(?:SECCIONAL)?\s*[:.-]?/i], [/INICIADOR|CARACTER|DOMICILIO|CUIT|CUIL/i]);
  assignField(fields, "registro", registro, "generic");

  const observaciones = firstLabelValue(normalized, [/OBSERVACIONES?\s*[:.-]?/i, /NOTAS?\s*[:.-]?/i], []);
  assignField(fields, "observacionesRelevantes", observaciones, "generic");

  const marcaModelo = firstLabelValue(normalized, [/MARCA\s*(?:Y|\/)?\s*MODELO\s*[:.-]?/i, /MARCA\s*[:.-]?/i], [/DOMINIO|MOTOR|CHASIS|ANO|AÑO|CUIT|CUIL/i]);
  assignField(fields, "marcaModelo", marcaModelo, "generic");

  const anio = firstRegexValue(compact, /\b(?:A[NÑ]O|MODELO)\s*[:.-]?\s*((?:19|20)\d{2})\b/i, (value) => safeValue(value));
  assignField(fields, "anio", anio, "structured");

  const monto = firstRegexValue(compact, /\b(?:MONTO|PRECIO|VALUACION|OPERACION)\s*[:.-]?\s*(\$?\s*\d[\d.\s]*(?:,\d{2})?)\b/i, (value) => safeValue(value.replace(/\s+/g, "")));
  assignField(fields, "montoOperacion", monto, "structured");

  if (!fields.observacionesRelevantes.value && /ENMIENDA|SALVADO|TACHADO|ILEGIBLE|CERTIFICO|SELLO/.test(plain)) {
    fields.observacionesRelevantes = field("Se detectaron terminos de observacion/sello, revisar documento.", "baja_confianza", "terminos relevantes detectados");
  }

  return { fields: applyRelaxedFallbacks(fields, text, sourceFile, debug), debug };
}

function buildTemplateOutput(detectedFields) {
  const valueOf = (key) => detectedFields[key]?.value ?? null;
  const confidenceOf = (key) => detectedFields[key]?.confidence ?? "baja_confianza";
  const output = {};
  const confidence = {};

  for (const placeholder of TEMPLATE_PLACEHOLDERS) {
    output[placeholder] = null;
    confidence[placeholder] = "baja_confianza";
  }

  const assignments = {
    "@usuario@": "cuitCuilCompradorAdquirente",
    "@apellido@": "apellidoCompradorAdquirente",
    "@nombre@": "nombreCompradorAdquirente",
    "@email@": "correoElectronico",
    "@atributo8@": "cuitCuilCompradorAdquirente",
    "@atributo9@": "nombreCompletoCompradorAdquirente",
    "@atributo7@": "expediente",
    "@atributo10@": "iniciadorNombre",
    "@atributo11@": "iniciadorCuitCuil",
    "@atributo12@": "iniciadorCaracter",
    "@atributo13@": "registro",
    "@atributo14@": "numeroFormulario",
    "@atributo15@": "dominio",
    "@atributo16@": "domicilio",
    "@atributo17@": "fecha",
    "@atributo18@": "marcaModelo",
    "@atributo19@": "anio",
    "@atributo20@": "anio",
    "@atributo21@": "cuitCuilVendedor",
    "@atributo22@": "nombreVendedor",
    "@atributo30@": "fechaInicioTramite",
    "@atributo33@": "montoOperacion",
  };

  for (const [placeholder, sourceKey] of Object.entries(assignments)) {
    output[placeholder] = valueOf(sourceKey);
    confidence[placeholder] = confidenceOf(sourceKey);
  }

  return { output, confidence };
}

function isAutomaticFallbackValue(value) {
  return /\b(NO TIENE|SIN DATOS|N\/A|NA|NO APLICA|NO CORRESPONDE)\b/.test(stripAccents(String(value || "")).toUpperCase());
}

function isValidIniciadorValue(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length >= 3 && !isAutomaticFallbackValue(text);
}

function findTemplate() {
  const templates = fs.readdirSync(TEMPLATE_DIR).filter((name) => /\.ods$/i.test(name)).sort();
  if (templates.length !== 1) {
    throw new Error(`Debe haber exactamente una plantilla .ods en ${TEMPLATE_DIR}. Encontradas: ${templates.length}`);
  }
  return path.join(TEMPLATE_DIR, templates[0]);
}

function copyDebugFile(sourcePath, targetPath, log, label) {
  try {
    if (sourcePath && fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      log.push({ phase: "debug_file", status: "escrito", field: label, value: targetPath });
      return targetPath;
    }
    fs.writeFileSync(targetPath, "", "utf8");
    log.push({ phase: "debug_file", status: "vacio_sin_origen", field: label, value: targetPath });
    return targetPath;
  } catch (error) {
    log.push({ phase: "debug_file", status: "error", field: label, value: error.message });
    return null;
  }
}

function getRepeatedCount(cellXml) {
  const repeat = cellXml.match(/\stable:number-columns-repeated="(\d+)"/);
  return repeat ? Number(repeat[1]) : 1;
}

function removeRepeatedCount(cellXml) {
  return cellXml.replace(/\stable:number-columns-repeated="\d+"/, "");
}

function getOdsRows(contentXml) {
  return [...contentXml.matchAll(/<table:table-row\b[\s\S]*?<\/table:table-row>/g)].map((match) => ({
    index: match.index,
    xml: match[0],
  }));
}

function splitOdsRow(rowXml) {
  const open = rowXml.match(/^<table:table-row\b[^>]*>/);
  if (!open) throw new Error("Fila ODS invalida.");
  const openTag = open[0];
  const closeTag = "</table:table-row>";
  const inner = rowXml.slice(openTag.length, -closeTag.length);
  return { openTag, inner, closeTag };
}

function parseOdsCells(rowXml) {
  const { openTag, closeTag, inner } = splitOdsRow(rowXml);
  const cellMatches = [
    ...inner.matchAll(
      /<table:(?:table-cell|covered-table-cell)\b[^>]*\/>|<table:(?:table-cell|covered-table-cell)\b[^>]*>[\s\S]*?<\/table:(?:table-cell|covered-table-cell)>/g
    ),
  ];
  const cells = [];

  for (const match of cellMatches) {
    const repeat = getRepeatedCount(match[0]);
    const cellXml = removeRepeatedCount(match[0]);
    for (let i = 0; i < repeat; i += 1) {
      cells.push(cellXml);
    }
  }

  return { openTag, closeTag, cells };
}

function odsCellText(cellXml) {
  if (/table:formula=/.test(cellXml)) return "[formula]";
  if (/office:value=/.test(cellXml) || /office:string-value=/.test(cellXml) || /office:date-value=/.test(cellXml)) {
    const text = [...cellXml.matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>|<text:p\s*\/>/g)]
      .map((match) => match[1] || "")
      .join("")
      .replace(/<[^>]+>/g, "")
      .trim();
    return text || "[value]";
  }
  return [...cellXml.matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>|<text:p\s*\/>/g)]
    .map((match) => match[1] || "")
    .join("")
    .replace(/<text:s\s*\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function odsPlaceholderFromCell(cellXml) {
  return unescapeXml(odsCellText(cellXml));
}

function makeOdsCell(value, placeholder) {
  if (typeof value === "number") {
    return `<table:table-cell office:value-type="float" office:value="${value}" calcext:value-type="float"><text:p>${value}</text:p></table:table-cell>`;
  }
  if (DATE_PLACEHOLDERS.has(placeholder)) {
    const text = escapeXml(formatDateDdMmYy(value));
    return `<table:table-cell office:value-type="string" calcext:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
  }
  const text = escapeXml(value);
  return `<table:table-cell office:value-type="string" calcext:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
}

function writeOdsDataRow(targetRow, rowData, columns, targetRowNumber, log) {
  const requiredCols = Math.max(...columns.map((column) => column.colNumber));
  while (targetRow.cells.length < requiredCols) {
    targetRow.cells.push("<table:table-cell/>");
  }

  for (const { placeholder, colNumber } of columns) {
    const cellIndex = colNumber - 1;
    const address = `${columnName(colNumber)}${targetRowNumber}`;
    const existingXml = targetRow.cells[cellIndex] || "<table:table-cell/>";
    const existing = odsCellText(existingXml);

    if (NEVER_FILL.has(placeholder)) {
      log.push({ phase: "write_ods", placeholder, cell: address, status: "omitido_no_completar", value: "" });
      continue;
    }

    const value = rowData[placeholder] ?? "";
    if (existing !== "") {
      log.push({ phase: "write_ods", placeholder, cell: address, status: "omitido_celda_ocupada", value, existing });
      continue;
    }

    if (placeholder === INICIADOR_PLACEHOLDER && !isValidIniciadorValue(value)) {
      log.push({ phase: "write_ods", placeholder, cell: address, status: "omitido_iniciador_sin_valor", value: "" });
      continue;
    }

    const cleanValue = DATE_PLACEHOLDERS.has(placeholder) ? formatDateDdMmYy(value) : value;
    targetRow.cells[cellIndex] = cleanValue === "" ? "<table:table-cell/>" : makeOdsCell(cleanValue, placeholder);
    log.push({
      phase: "write_ods",
      placeholder,
      cell: address,
      status: cleanValue === "" ? "escrito_vacio_no_encontrado" : "escrito",
      value: cleanValue,
    });
  }

  log.push({ phase: "write_ods", field: "ods_row", status: "completado", value: targetRowNumber });
  return `${targetRow.openTag}${targetRow.cells.join("")}${targetRow.closeTag}`;
}

async function writeOdsWorkbook(templatePath, rowData, outPath, log) {
  const buffer = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(buffer);
  const contentFile = zip.file("content.xml");
  if (!contentFile) throw new Error("ODS invalido: no contiene content.xml.");

  const contentXml = await contentFile.async("string");
  const rows = getOdsRows(contentXml);
  if (rows.length < FIRST_DATA_ROW) {
    throw new Error(`ODS invalido: no existen filas suficientes. Ultima fila requerida: ${FIRST_DATA_ROW}.`);
  }

  const placeholderRow = parseOdsCells(rows[PLACEHOLDER_ROW - 1].xml);
  const expected = new Set([...TEMPLATE_PLACEHOLDERS, ...NEVER_FILL]);
  const columns = [];

  placeholderRow.cells.forEach((cellXml, index) => {
    const placeholder = odsPlaceholderFromCell(cellXml);
    if (expected.has(placeholder)) {
      columns.push({ placeholder, colNumber: index + 1 });
    }
  });

  if (columns.length < 5) {
    throw new Error(`No se encontraron placeholders suficientes en la fila ${PLACEHOLDER_ROW} del ODS.`);
  }

  const targetRowNumber = FIRST_DATA_ROW;
  const targetRow = parseOdsCells(rows[targetRowNumber - 1].xml);
  const newRowXml = writeOdsDataRow(targetRow, rowData, columns, targetRowNumber, log);
  const targetRowInfo = rows[targetRowNumber - 1];
  const newContentXml =
    contentXml.slice(0, targetRowInfo.index) + newRowXml + contentXml.slice(targetRowInfo.index + targetRowInfo.xml.length);

  zip.file("content.xml", newContentXml);
  const outBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outPath, outBuffer);
  return outPath;
}

function summarizeFields(detectedFields) {
  const found = [];
  const doubtful = [];
  const missing = [];

  for (const [name, data] of Object.entries(detectedFields)) {
    if (data.value == null) missing.push(name);
    else if (data.confidence === "baja" || data.confidence === "baja_confianza") doubtful.push(name);
    else found.push(name);
  }

  return { found, doubtful, missing };
}

async function processFile(filePath) {
  const fileName = path.basename(filePath);
  const log = [{ phase: "file", status: "inicio", file: fileName, value: filePath }];
  const { text, method, diagnostic, blocks } = await acquireText(filePath, log);
  const stats = textStats(text);
  log.push({ phase: "text", status: text ? "capturado" : "vacio", method, chars: stats.chars, words: stats.words, useful: stats.useful });

  const extraction = extractDetectedFields(text, fileName);
  const detectedFields = extraction.fields;
  const debug = extraction.debug;
  applyVisionStructuredFields(detectedFields, diagnostic?.visionStructured, debug);
  const candidates = collectUnvalidatedCandidates(text);
  const { output, confidence } = buildTemplateOutput(detectedFields);
  const summary = summarizeFields(detectedFields);
  const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, "utf8"));
  const diagnosis = stats.useful
    ? "OCR recupero texto suficiente. Si el ODS queda vacio, revisar field_mapping/extractores."
    : "OCR no recupero texto suficiente del manuscrito. El problema esta en preprocessing/OCR antes del mapeo.";

  log.push({ phase: "fields_found", status: "ok", value: summary.found });
  log.push({ phase: "fields_doubtful", status: summary.doubtful.length ? "revision" : "ok", value: summary.doubtful });
  log.push({ phase: "fields_missing", status: summary.missing.length ? "faltantes" : "ok", value: summary.missing });
  log.push({ phase: "debug_detected", status: debug.detected.length ? "ok" : "sin_datos", value: debug.detected });
  log.push({ phase: "debug_discarded", status: debug.discarded.length ? "revision" : "ok", value: debug.discarded });
  log.push({ phase: "ocr_diagnosis", status: stats.useful ? "mapeo_a_revisar_si_vacio" : "ocr_insuficiente", value: diagnosis });

  return {
    sourceFile: fileName,
    processedAt: new Date().toISOString(),
    documentType: "Formulario 08 manuscrito",
    extractionMode: method,
    reviewRequired: true,
    ocrStats: stats,
    ocrDiagnostic: diagnostic,
    ocrBlocks: blocks,
    extractorDiagnosis: diagnosis,
    detectedFields,
    templateOutput: output,
    templateConfidence: confidence,
    auxiliaryFields: {
      localidad: detectedFields.localidad,
      provincia: detectedFields.provincia,
      codigoPostal: detectedFields.codigoPostal,
      telefono: detectedFields.telefono,
      observacionesRelevantes: detectedFields.observacionesRelevantes,
    },
    mappingVersion: mapping.version,
    summary,
    debug,
    candidates,
    rawOcrText: text,
    rawTextPreview: text.slice(0, 3000),
    log,
  };
}

async function main() {
  ensureDirs();
  moveExistingAuxiliaryOutputFiles();
  const allLogs = [];
  const templatePath = findTemplate();
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(INPUT_DIR, name));

  if (files.length === 0) {
    throw new Error(`No hay imagenes o PDFs soportados en ${INPUT_DIR}`);
  }

  let processed = 0;
  let failed = 0;
  for (const filePath of files) {
    const fileName = path.basename(filePath);
    try {
      const result = await processFile(filePath);
      const baseName = path.basename(fileName, path.extname(fileName)).replace(/[^A-Z0-9_-]+/gi, "_");
      const stamp = nowStamp();
      const debugRunDir = path.join(DEBUG_DIR, `${baseName}_manuscrito_${stamp}`);
      fs.mkdirSync(debugRunDir, { recursive: true });
      const jsonPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}.json`);
      const odsPath = path.join(OUTPUT_DIR, `${baseName}_manuscrito_${stamp}.ods`);
      const rawOcrPath = path.join(debugRunDir, `${baseName}_manuscrito_raw_ocr.txt`);
      const originalDebugPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_original${path.extname(fileName).toLowerCase()}`);
      const preprocessedDebugPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_preprocessed.png`);
      const blocksPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_ocr_blocks.json`);
      const diagnosticPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_diagnostico.json`);
      fs.writeFileSync(rawOcrPath, result.rawOcrText || "", "utf8");
      copyDebugFile(filePath, originalDebugPath, result.log, "imagen_original");
      copyDebugFile(result.ocrDiagnostic?.bestImagePath || filePath, preprocessedDebugPath, result.log, "imagen_preprocesada_final");
      fs.writeFileSync(blocksPath, JSON.stringify({ sourceFile: fileName, blocks: result.ocrBlocks || [] }, null, 2), "utf8");
      const mappedValues = Object.values(result.templateOutput || {}).filter((value) => value != null && value !== "");
      const candidateCount = Object.values(result.candidates || {}).reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
      const ocrFailed = result.ocrStats.chars < OCR_HARD_FAIL_CHARS;
      const hasUsefulDetectedData = mappedValues.length > 0 || candidateCount > 0;
      const shouldWriteOds = !ocrFailed && hasUsefulDetectedData && mappedValues.length > 0;
      const configurationError = result.ocrDiagnostic?.configurationError || null;
      result.extractionStatus = {
        ok: shouldWriteOds,
        message: shouldWriteOds ? "Datos suficientes detectados para generar ODS parcial." : OCR_FAILURE_MESSAGE,
        reason: configurationError
          ? configurationError
          : ocrFailed
          ? OCR_ENGINE_FAILURE_MESSAGE
          : hasUsefulDetectedData
            ? "OCR recupero texto/candidatos, pero no hay campos mapeados suficientes para completar el ODS."
            : "No se detectaron campos ni candidatos utiles del formulario.",
        ocrEngineNote:
          result.extractionMode.startsWith("openai_vision")
            ? "Modo principal Vision AI/OpenAI Vision seleccionado para manuscritos."
            : "Se esta usando OCR clasico/Tesseract. No es adecuado para manuscritos complejos si no recupera texto suficiente.",
      };
      result.outputFiles = {
        json: jsonPath,
        ods: shouldWriteOds ? odsPath : null,
        rawOcr: rawOcrPath,
        originalImage: originalDebugPath,
        preprocessedImage: preprocessedDebugPath,
        ocrBlocks: blocksPath,
        diagnostic: diagnosticPath,
        debugDir: debugRunDir,
      };
      fs.writeFileSync(
        diagnosticPath,
        JSON.stringify(
          {
            sourceFile: fileName,
            extractionStatus: result.extractionStatus,
            diagnosis: result.extractorDiagnosis,
            ocrStats: result.ocrStats,
            ocrDiagnostic: result.ocrDiagnostic,
            summary: result.summary,
            candidates: result.candidates,
            outputFiles: result.outputFiles,
          },
          null,
          2
        ),
        "utf8"
      );
      result.log.push({ phase: "output", status: "raw_ocr_escrito", value: rawOcrPath });
      result.log.push({ phase: "output", status: "ocr_blocks_escrito", value: blocksPath });
      result.log.push({ phase: "output", status: "diagnostico_escrito", value: diagnosticPath });
      if (!shouldWriteOds) {
        result.log.push({ phase: "output", status: "ods_no_generado", value: result.extractionStatus });
        fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
        if (result.ocrDiagnostic?.workDir) {
          fs.rmSync(result.ocrDiagnostic.workDir, { recursive: true, force: true });
        }
        allLogs.push(...result.log.map((entry) => ({ file: fileName, ...entry })));
        allLogs.push({ file: fileName, phase: "output", status: "json_debug_escrito", value: jsonPath });
        failed += 1;
        console.error(`${fileName}: ${OCR_FAILURE_MESSAGE}`);
        console.error(`${fileName}: ${result.extractionStatus.reason}`);
        console.log(`${fileName}: Debug generado ${debugRunDir}`);
        continue;
      }

      const odsRowData = { __source: fileName, ...result.templateOutput };
      const odsLog = [];
      await writeOdsWorkbook(templatePath, odsRowData, odsPath, odsLog);
      result.log.push({ phase: "output", status: "ods_escrito", value: odsPath });
      result.log.push(...odsLog);
      fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
      if (result.ocrDiagnostic?.workDir) {
        fs.rmSync(result.ocrDiagnostic.workDir, { recursive: true, force: true });
      }
      allLogs.push(...result.log.map((entry) => ({ file: fileName, ...entry })));
      allLogs.push({ file: fileName, phase: "output", status: "json_escrito", value: jsonPath });
      processed += 1;
      console.log(`${fileName}: ODS generado ${odsPath}`);
      console.log(`${fileName}: Debug generado ${debugRunDir}`);
    } catch (error) {
      allLogs.push({ file: fileName, phase: "processing", status: "error", value: error.message });
      console.warn(`${fileName}: no se pudo procesar (${error.message})`);
    }
  }

  const logPath = path.join(LOG_DIR, `manuscrito_log_${nowStamp()}.jsonl`);
  fs.writeFileSync(logPath, allLogs.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  console.log(`Archivos encontrados: ${files.length}`);
  console.log(`Archivos procesados: ${processed}`);
  console.log(`Archivos con falla de lectura: ${failed}`);
  console.log(`Log: ${logPath}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
