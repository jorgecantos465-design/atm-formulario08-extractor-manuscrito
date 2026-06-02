const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { SaxesParser } = require("saxes");
const dotenv = require("dotenv");
const { createCanvas, DOMMatrix, DOMPoint, DOMRect, ImageData, Path2D } = require("@napi-rs/canvas");
dotenv.config({ quiet: true });

let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch (_) {
  pdfParse = null;
}

let pdfJsModulePromise = null;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const INPUT_DIR = path.join(PROJECT_ROOT, "input");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
const DEBUG_DIR = path.join(PROJECT_ROOT, "debug");
const TEMPLATE_DIR = path.join(PROJECT_ROOT, "templates");
const LOG_DIR = path.join(PROJECT_ROOT, "logs");
const EASYOCR_PROBE_PATH = path.join(__dirname, "easyocr_probe.py");
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, ".env.example");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const TEMPLATE_ODS_PATH = path.join(TEMPLATE_DIR, "Modelo Resolucion General.ods");
const TEMPLATE_XLSX_PATH = path.join(TEMPLATE_DIR, "Modelo Resolucion General.xlsx");
const READBACK_XLSX_DEBUG_PATH = path.join(DEBUG_DIR, "readback_xlsx.json");
const READBACK_ODS_DEBUG_PATH = path.join(DEBUG_DIR, "readback_ods.json");
const ALLOWED_FIELDS_MAPPING_DEBUG_PATH = path.join(DEBUG_DIR, "allowed_fields_mapping.json");

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);
const CONFIDENCE = ["alta", "media", "baja", "baja_confianza"];
const OCR_MIN_CHARS = 50;
const OCR_MIN_WORDS = 8;
const OCR_HARD_FAIL_CHARS = 50;
const VISION_MIN_IMAGE_BYTES = 1024;
const OCR_MODE = String(process.env.MANUSCRITO_OCR_MODE || "openai_vision").toLowerCase();
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const EASY_OCR_ENABLED = process.argv.includes("--easyocr") || String(process.env.MANUSCRITO_EASYOCR || "").trim() === "1";
const EXPERIMENTAL_XLSX_ENABLED = process.argv.includes("--experimental-xlsx");
const OCR_FAILURE_MESSAGE = "NO SE DETECTARON DATOS SUFICIENTES DEL FORMULARIO";
const OCR_ENGINE_FAILURE_MESSAGE = "Falla de OCR: el motor actual no puede leer este manuscrito con precision suficiente.";
const VISION_API_KEY_MESSAGE = "Falta configurar OPENAI_API_KEY en el archivo .env";
const BASIC_VISION_PROMPT = "Describi todo lo que ves en esta imagen.";
const STRUCTURED_VISION_PROMPT = [
  "Lee la imagen completa de un Formulario 08 manuscrito argentino.",
  "No inventes datos. Si un dato no aparece, devuelve valor null.",
  "No extraigas campos manuales, formulas ni campos marcados como NO PONER.",
  "Responde solo JSON valido, sin Markdown.",
  "El JSON debe tener detectedFields, candidates, rawLines, rawText y observations.",
  "Dentro de detectedFields devuelve exactamente estos campos automaticos permitidos: cuit_adquirente, nombre_adquirente, email, cuit_adquirente_f08, nombre_adquirente_f08, numero_formulario_08, dominio, domicilio_adquirente, lugar_fecha_impresion_osd, marca, modelo, modelo_anio, anio_fabricacion, cuit_vendedor, nombre_vendedor, letra_multa, fecha_liquidacion, fecha_inicio_tramite, periodo, monto_operacion.",
  "Cada detectedFields.<campo> debe tener valor, confianza y observacion.",
  "confianza debe ser alta, media, baja o baja_confianza.",
].join("\n");
const AUTOMATIC_FIELD_ORDER = [
  "cuit_adquirente",
  "nombre_adquirente",
  "email",
  "cuit_adquirente_f08",
  "nombre_adquirente_f08",
  "numero_formulario_08",
  "dominio",
  "domicilio_adquirente",
  "lugar_fecha_impresion_osd",
  "marca",
  "modelo",
  "modelo_anio",
  "anio_fabricacion",
  "cuit_vendedor",
  "nombre_vendedor",
  "letra_multa",
  "fecha_liquidacion",
  "fecha_inicio_tramite",
  "periodo",
  "monto_operacion",
];

function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function hasConfiguredOpenAiApiKey() {
  const apiKey = getOpenAiApiKey();
  return Boolean(apiKey && apiKey !== "pegar_api_key_aqui" && apiKey !== "tu_api_key");
}

function ensureOpenAiEnvFiles() {
  const exampleContent = "OPENAI_API_KEY=pegar_api_key_aqui\n";
  if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
    fs.writeFileSync(ENV_EXAMPLE_PATH, exampleContent, "utf8");
  }
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, exampleContent, "utf8");
  }
  dotenv.config({ path: ENV_PATH, quiet: true });
}

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
    if (/\.(ods|xlsx)$/i.test(entry.name)) continue;
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

function safeValue(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (isNullLikeValue(text) || text.length < 2) return null;
  return text;
}

function isNullLikeValue(value) {
  if (value == null) return true;
  const text = stripAccents(String(value)).trim().toUpperCase();
  return text === "" || text === "NULL" || text === "N/A" || text === "NA" || text === "NO LEGIBLE" || text === "ILEGIBLE" || text === "NO ENCONTRADO";
}

function field(value, confidence, evidence = "", notes = "") {
  const normalizedConfidence = CONFIDENCE.includes(confidence) ? confidence : "baja_confianza";
  if (isNullLikeValue(value)) {
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
    domicilioLegal: field(null, "baja"),
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

function parseJsonLoose(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch (_) {
        return null;
      }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function makeImageInput(imagePath) {
  return {
    type: "input_image",
    detail: "high",
    image_url: `data:${mimeTypeFor(imagePath)};base64,${fs.readFileSync(imagePath).toString("base64")}`,
  };
}

function imageSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

function validateVisionImage(imagePath, log) {
  const bytes = imageSizeBytes(imagePath);
  if (bytes >= VISION_MIN_IMAGE_BYTES) return null;
  const message = "Conversión PDF → imagen fallida";
  log.push({ phase: "vision_image", status: "conversion_pdf_imagen_fallida", value: message, bytes });
  return message;
}

async function loadPdfJs() {
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
  if (!globalThis.DOMPoint) globalThis.DOMPoint = DOMPoint;
  if (!globalThis.DOMRect) globalThis.DOMRect = DOMRect;
  if (!globalThis.ImageData) globalThis.ImageData = ImageData;
  if (!globalThis.Path2D) globalThis.Path2D = Path2D;

  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfJsModulePromise;
}

async function renderPdfFirstPageWithPdfJs(pdfPath, outPath, log) {
  try {
    const pdfjsLib = await loadPdfJs();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(fs.readFileSync(pdfPath)),
      disableWorker: true,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 3 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const canvasContext = canvas.getContext("2d");
    await page.render({ canvasContext, viewport }).promise;
    fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
    const bytes = imageSizeBytes(outPath);
    log.push({ phase: "pdf_render", status: bytes >= VISION_MIN_IMAGE_BYTES ? "capturado_pdfjs" : "pdfjs_imagen_invalida", value: outPath, bytes });
    return bytes >= VISION_MIN_IMAGE_BYTES ? outPath : null;
  } catch (error) {
    log.push({ phase: "pdf_render", status: "error_pdfjs", value: error.message });
    return null;
  }
}

async function renderFirstPageForVision(filePath, log) {
  const ext = path.extname(filePath).toLowerCase();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f08-vision-"));
  const outPath = path.join(workDir, "input_page_1.png");

  if (ext !== ".pdf") {
    if (!/^image\//.test(mimeTypeFor(filePath))) {
      log.push({ phase: "vision_image", status: "formato_no_soportado", value: filePath });
      return { imagePath: null, workDir, error: "OpenAI Vision requiere imagen o PDF renderizable." };
    }
    if (ext === ".png") {
      fs.copyFileSync(filePath, outPath);
      log.push({ phase: "vision_image", status: "imagen_png_copiada", value: outPath });
      const imageError = validateVisionImage(outPath, log);
      if (imageError) return { imagePath: null, workDir, error: imageError };
      return { imagePath: outPath, workDir, error: null };
    }
    if (commandExists("magick")) {
      try {
        execFileSync("magick", [filePath, outPath], { stdio: "ignore" });
        log.push({ phase: "vision_image", status: "imagen_convertida_png", value: outPath });
        const imageError = validateVisionImage(outPath, log);
        if (imageError) return { imagePath: null, workDir, error: imageError };
        return { imagePath: outPath, workDir, error: null };
      } catch (error) {
        log.push({ phase: "vision_image", status: "error_conversion_imagen", value: error.message });
        return { imagePath: null, workDir, error: error.message };
      }
    }
    fs.copyFileSync(filePath, outPath);
    log.push({ phase: "vision_image", status: "imagen_copiada_sin_conversion", value: outPath });
    const imageError = validateVisionImage(outPath, log);
    if (imageError) return { imagePath: null, workDir, error: imageError };
    return { imagePath: outPath, workDir, error: null };
  }

  const pdfJsImage = await renderPdfFirstPageWithPdfJs(filePath, outPath, log);
  if (pdfJsImage) {
    log.push({ phase: "vision_image", status: "pdf_pagina_1_renderizada_pdfjs", value: outPath, bytes: imageSizeBytes(outPath) });
    return { imagePath: outPath, workDir, error: null };
  }

  const pages = renderPdfForOcr(filePath, workDir, log);
  if (!pages.length) {
    return { imagePath: null, workDir, error: "Conversión PDF → imagen fallida" };
  }
  fs.copyFileSync(pages[0], outPath);
  log.push({ phase: "vision_image", status: "pdf_pagina_1_renderizada", value: outPath });
  const imageError = validateVisionImage(outPath, log);
  if (imageError) return { imagePath: null, workDir, error: imageError };
  return { imagePath: outPath, workDir, error: null };
}

async function callOpenAiVision(imagePath, prompt, log, phase) {
  const apiKey = getOpenAiApiKey();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            makeImageInput(imagePath),
          ],
        },
      ],
    }),
  });
  const responseJson = await response.json();
  const rawText = responseText(responseJson);
  log.push({ phase, status: response.ok ? "ok" : "error", chars: rawText.length, httpStatus: response.status });
  if (!response.ok) {
    throw new Error(responseJson.error?.message || `OpenAI API HTTP ${response.status}`);
  }
  return { responseJson, rawText };
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

  const rendered = await renderFirstPageForVision(filePath, log);
  if (!rendered.imagePath) {
    log.push({ phase: "vision_ai", status: "sin_imagen_para_vision", value: rendered.error });
    return {
      text: "",
      method: "openai_vision",
      diagnostic: {
        bestVariant: "openai_vision",
        bestImagePath: null,
        workDir: rendered.workDir,
        imageError: rendered.error,
        stats: textStats(""),
        variants: [{ variant: "openai_vision", chars: 0, words: 0, useful: false, blocks: 0, error: rendered.error }],
      },
      blocks: [],
    };
  }

  try {
    const basic = await callOpenAiVision(rendered.imagePath, BASIC_VISION_PROMPT, log, "vision_basic_test");
    const structuredResponse = await callOpenAiVision(rendered.imagePath, STRUCTURED_VISION_PROMPT, log, "vision_structured");
    const raw = structuredResponse.rawText;
    const parsed = parseJsonLoose(raw);
    const structured = parsed || { rawText: raw, parseError: "No se pudo parsear JSON desde la respuesta de Vision." };
    const text = structuredVisionToText(structured) || raw;
    const stats = textStats(text);
    log.push({ phase: "vision_ai", status: stats.useful ? "texto_suficiente" : "texto_insuficiente", chars: stats.chars, words: stats.words });
    return {
      text,
      method: "openai_vision",
      diagnostic: {
        bestVariant: "openai_vision",
        bestImagePath: rendered.imagePath,
        workDir: rendered.workDir,
        stats,
        visionImagePath: rendered.imagePath,
        visionPrompt: STRUCTURED_VISION_PROMPT,
        visionBasicPrompt: BASIC_VISION_PROMPT,
        visionBasicRawResponse: basic.rawText,
        visionBasicResponseJson: basic.responseJson,
        visionRawResponse: raw,
        visionResponseJson: structuredResponse.responseJson,
        visionStructured: structured,
        visionParseError: parsed ? null : structured.parseError,
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
        bestImagePath: rendered.imagePath,
        workDir: rendered.workDir,
        visionImagePath: rendered.imagePath,
        visionPrompt: STRUCTURED_VISION_PROMPT,
        visionBasicPrompt: BASIC_VISION_PROMPT,
        visionBasicRawResponse: null,
        visionRawResponse: null,
        visionStructured: null,
        visionParseError: error.message,
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
  if (digits.length !== 11) return null;
  if (!isValidCuit(digits)) return null;
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

function isValidCuit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
  const mod = 11 - (sum % 11);
  const check = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return check === Number(digits[10]);
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
  const source = stripAccents(String(value || "")).replace(/\s+/g, " ").trim();
  const monthNames = {
    ENERO: "01",
    FEBRERO: "02",
    MARZO: "03",
    ABRIL: "04",
    MAYO: "05",
    JUNIO: "06",
    JULIO: "07",
    AGOSTO: "08",
    SEPTIEMBRE: "09",
    SETIEMBRE: "09",
    OCTUBRE: "10",
    NOVIEMBRE: "11",
    DICIEMBRE: "12",
  };
  let match = source.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (!match) {
    match = source.match(/\b(\d{1,2})\s+DE\s+([A-Z]+)(?:\s+DE)?\s+(\d{2,4})\b/i) || source.match(/\b(\d{1,2})\s+([A-Z]+)\s+(\d{2,4})\b/i);
    if (match) match = [match[0], match[1], monthNames[String(match[2]).toUpperCase()], match[3]];
  }
  if (!match || !match[2]) return null;
  const day = String(match[1]).padStart(2, "0");
  const month = String(match[2]).padStart(2, "0");
  const year = String(match[3]).length === 2 ? `20${match[3]}` : String(match[3]);
  const dayNumber = Number(day);
  const monthNumber = Number(month);
  if (dayNumber < 1 || dayNumber > 31 || monthNumber < 1 || monthNumber > 12 || !/^\d{4}$/.test(year)) return null;
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
    if (data.valor != null && typeof data.valor !== "object") return safeValue(data.valor);
    if (data.value != null && typeof data.value !== "object") return safeValue(data.value);
    if (data.text != null && typeof data.text !== "object") return safeValue(data.text);
    if (data.valor != null || data.value != null || data.text != null) return null;
  }
  if (typeof data === "object") return null;
  return safeValue(data);
}

function visionFieldCandidate(structured, sourceKeys) {
  const detected = structured?.detectedFields || structured?.fields || {};
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(detected, sourceKey)) continue;
    const rawField = detected[sourceKey];
    const value = valueFromVisionField(rawField);
    if (!value) continue;
    return field(value, confidenceFromVisionField(rawField), evidenceFromVisionField(rawField), "Extraido por Vision AI.");
  }
  return null;
}

function confidenceFromVisionField(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const raw = String(data.confidence || data.confianza || data.confidenceLevel || "").toLowerCase().replace(/\s+/g, "_");
    if (raw.includes("alta")) return "alta";
    if (raw.includes("media")) return "media";
    if (raw.includes("baja")) return "baja_confianza";
  }
  return "baja_confianza";
}

function evidenceFromVisionField(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data.evidence || data.evidencia || data.observacion || data.observation || data.sourceText || data.raw || null;
  }
  return null;
}

function applyVisionStructuredFields(fields, structured, debug) {
  const detected = structured?.detectedFields || structured?.fields || {};
  const aliases = {
    dominio: ["dominio", "patente", "dominioPatente"],
    numeroFormulario: ["numeroFormulario", "numero_formulario_08", "nroFormulario", "formulario08", "numero_formulario"],
    fecha: ["fecha", "fechaFormulario", "lugarYFecha", "lugar_fecha_impresion_osd"],
    cuitCuilCompradorAdquirente: ["cuit_adquirente_f08", "cuit_adquirente", "cuitCuilCompradorAdquirente", "cuitComprador", "cuilComprador", "dniComprador", "documentoComprador"],
    nombreCompletoCompradorAdquirente: ["nombre_adquirente_f08", "nombre_adquirente", "nombreCompletoCompradorAdquirente", "comprador", "adquirente", "nombreComprador", "apellidoYNombreComprador"],
    apellidoCompradorAdquirente: ["apellidoCompradorAdquirente", "apellidoComprador"],
    nombreCompradorAdquirente: ["nombreCompradorAdquirente", "nombreComprador"],
    domicilio: ["domicilio_adquirente", "domicilio", "domicilioComprador", "direccionComprador"],
    domicilioLegal: ["domicilioLegal", "domicilio_legal", "direccionLegal", "domicilioVendedor"],
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
    anio: ["anio_fabricacion", "anio", "ano", "modeloAnio", "modelo_anio"],
    cuitCuilVendedor: ["cuit_vendedor", "cuitCuilVendedor", "cuitVendedor", "cuilVendedor"],
    nombreVendedor: ["nombre_vendedor", "nombreVendedor", "vendedor"],
    fechaInicioTramite: ["fecha_inicio_tramite", "fechaInicioTramite", "fechaInicio"],
    montoOperacion: ["monto_operacion", "montoOperacion", "monto", "precio"],
  };

  for (const [targetKey, sourceKeys] of Object.entries(aliases)) {
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

function findTemplate() {
  if (fs.existsSync(TEMPLATE_ODS_PATH)) return TEMPLATE_ODS_PATH;
  throw new Error(`No existe el template oficial requerido: ${TEMPLATE_ODS_PATH}`);
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

function pickVisionField(diagnostic, names) {
  const fields = diagnostic?.visionStructured?.detectedFields || diagnostic?.visionStructured?.fields || {};
  for (const name of names) {
    const item = fields[name];
    if (item == null) continue;
    if (typeof item === "object" && item.value != null) return item.value;
    if (typeof item !== "object") return item;
  }
  return null;
}

function buildEasyOcrVisionComparison(easyOcrParsed, diagnostic) {
  const fields = easyOcrParsed?.fields || {};
  const vision = {
    dominio: pickVisionField(diagnostic, ["dominio", "patente"]),
    fecha: pickVisionField(diagnostic, ["fecha", "fechaOperacion", "fechaInicioTramite"]),
    monto: pickVisionField(diagnostic, ["monto", "montoOperacion", "precio"]),
    cuit: pickVisionField(diagnostic, ["cuit", "cuitCuilCompradorAdquirente", "cuitCuilVendedor"]),
    nombre: pickVisionField(diagnostic, ["nombre", "nombreCompletoCompradorAdquirente", "nombreVendedor"]),
  };
  return Object.fromEntries(
    Object.entries(vision).map(([key, visionValue]) => [
      key,
      {
        easyocr: fields[key]?.value || null,
        vision: visionValue || null,
        comparable: Boolean(fields[key]?.value || visionValue),
        match: Boolean(fields[key]?.value && visionValue && String(fields[key].value).trim().toLowerCase() === String(visionValue).trim().toLowerCase()),
      },
    ])
  );
}

function runEasyOcrDebug(inputImagePath, files, diagnostic, log) {
  if (!EASY_OCR_ENABLED) return null;

  if (!inputImagePath || !fs.existsSync(inputImagePath) || imageSizeBytes(inputImagePath) < VISION_MIN_IMAGE_BYTES) {
    const payload = {
      ok: false,
      engine: "easyocr",
      error: "input_page_1.png no existe o pesa menos de 1 KB",
      fields: { dominio: null, fecha: null, monto: null, cuit: null, nombre: null },
    };
    fs.writeFileSync(files.easyOcrRawResponse, payload.error, "utf8");
    fs.writeFileSync(files.easyOcrParsedJson, JSON.stringify(payload, null, 2), "utf8");
    log.push({ phase: "easyocr", status: "sin_imagen_valida", value: payload.error });
    return payload;
  }

  try {
    execFileSync("python", [EASYOCR_PROBE_PATH, inputImagePath, files.easyOcrRawResponse, files.easyOcrParsedJson], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
    const parsed = JSON.parse(fs.readFileSync(files.easyOcrParsedJson, "utf8"));
    parsed.comparison = buildEasyOcrVisionComparison(parsed, diagnostic);
    fs.writeFileSync(files.easyOcrParsedJson, JSON.stringify(parsed, null, 2), "utf8");
    log.push({ phase: "easyocr", status: parsed.ok ? "ok" : "error", value: files.easyOcrParsedJson, lines: parsed.lineCount || 0 });
    return parsed;
  } catch (error) {
    let parsed = null;
    if (fs.existsSync(files.easyOcrParsedJson)) {
      try {
        parsed = JSON.parse(fs.readFileSync(files.easyOcrParsedJson, "utf8"));
      } catch (_) {
        parsed = null;
      }
    }
    const payload = parsed || {
      ok: false,
      engine: "easyocr",
      error: error.stderr || error.message,
      fields: { dominio: null, fecha: null, monto: null, cuit: null, nombre: null },
    };
    payload.comparison = buildEasyOcrVisionComparison(payload, diagnostic);
    fs.writeFileSync(files.easyOcrRawResponse, fs.existsSync(files.easyOcrRawResponse) ? fs.readFileSync(files.easyOcrRawResponse, "utf8") : payload.error, "utf8");
    fs.writeFileSync(files.easyOcrParsedJson, JSON.stringify(payload, null, 2), "utf8");
    log.push({ phase: "easyocr", status: "error", value: payload.error });
    return payload;
  }
}

async function writeDebugArtifacts(debugRunDir, result, log) {
  const diagnostic = result.ocrDiagnostic || {};
  let visionImagePath = diagnostic.visionImagePath || diagnostic.bestImagePath;
  let temporaryVisionRender = null;
  if ((!visionImagePath || !fs.existsSync(visionImagePath) || !/^image\//.test(mimeTypeFor(visionImagePath))) && result.sourcePath) {
    temporaryVisionRender = await renderFirstPageForVision(result.sourcePath, log);
    if (temporaryVisionRender.imagePath) visionImagePath = temporaryVisionRender.imagePath;
  }
  const files = {
    inputImage: path.join(debugRunDir, "input_page_1.png"),
    prompt: path.join(debugRunDir, "vision_prompt.txt"),
    rawResponse: path.join(debugRunDir, "vision_raw_response.txt"),
    parsedJson: path.join(debugRunDir, "vision_parsed.json"),
    validation: path.join(debugRunDir, "validation_report.json"),
    mapping: path.join(debugRunDir, "full_mapping.json"),
    outputMapping: path.join(debugRunDir, "output_mapping.json"),
    fullExtraction: path.join(debugRunDir, "full_extraction.json"),
    allowedFieldsMapping: path.join(debugRunDir, "allowed_fields_mapping.json"),
    basicPrompt: path.join(debugRunDir, "vision_basic_prompt.txt"),
    basicResponse: path.join(debugRunDir, "vision_basic_raw_response.txt"),
    easyOcrRawResponse: path.join(debugRunDir, "easyocr_raw_response.txt"),
    easyOcrParsedJson: path.join(debugRunDir, "easyocr_parsed.json"),
  };

  copyDebugFile(visionImagePath, files.inputImage, log, "vision_input_page_1");
  result.easyOcrComparison = runEasyOcrDebug(files.inputImage, files, diagnostic, log);
  fs.writeFileSync(files.prompt, diagnostic.visionPrompt || STRUCTURED_VISION_PROMPT, "utf8");
  fs.writeFileSync(files.basicPrompt, diagnostic.visionBasicPrompt || BASIC_VISION_PROMPT, "utf8");
  fs.writeFileSync(files.basicResponse, diagnostic.visionBasicRawResponse || "", "utf8");
  fs.writeFileSync(
    files.rawResponse,
    diagnostic.visionResponseJson ? JSON.stringify(diagnostic.visionResponseJson) : diagnostic.visionRawResponse || "",
    "utf8"
  );
  fs.writeFileSync(files.parsedJson, JSON.stringify(diagnostic.visionStructured || { parseError: diagnostic.visionParseError || "sin_respuesta_parseada" }, null, 2), "utf8");
  fs.writeFileSync(files.validation, JSON.stringify(result.validationReport || {}, null, 2), "utf8");
  fs.writeFileSync(files.mapping, JSON.stringify(result.fullMapping || result.outputMapping || {}, null, 2), "utf8");
  fs.writeFileSync(files.outputMapping, JSON.stringify(result.outputMapping || {}, null, 2), "utf8");
  fs.writeFileSync(files.fullExtraction, JSON.stringify(result.fullExtraction || {}, null, 2), "utf8");
  fs.writeFileSync(files.allowedFieldsMapping, JSON.stringify(result.allowedFieldsMapping || {}, null, 2), "utf8");

  log.push({ phase: "debug_file", status: "escrito", field: "vision_prompt", value: files.prompt });
  log.push({ phase: "debug_file", status: "escrito", field: "vision_raw_response", value: files.rawResponse });
  log.push({ phase: "debug_file", status: "escrito", field: "vision_parsed", value: files.parsedJson });
  log.push({ phase: "debug_file", status: "escrito", field: "validation_report", value: files.validation });
  log.push({ phase: "debug_file", status: "escrito", field: "full_mapping", value: files.mapping });
  log.push({ phase: "debug_file", status: "escrito", field: "output_mapping", value: files.outputMapping });
  log.push({ phase: "debug_file", status: "escrito", field: "full_extraction", value: files.fullExtraction });
  log.push({ phase: "debug_file", status: "escrito", field: "allowed_fields_mapping", value: files.allowedFieldsMapping });
  log.push({ phase: "debug_file", status: "escrito", field: "vision_basic_prompt", value: files.basicPrompt });
  log.push({ phase: "debug_file", status: "escrito", field: "vision_basic_raw_response", value: files.basicResponse });
  if (EASY_OCR_ENABLED) {
    log.push({ phase: "debug_file", status: "escrito", field: "easyocr_raw_response", value: files.easyOcrRawResponse });
    log.push({ phase: "debug_file", status: "escrito", field: "easyocr_parsed", value: files.easyOcrParsedJson });
  }
  if (temporaryVisionRender?.workDir) {
    fs.rmSync(temporaryVisionRender.workDir, { recursive: true, force: true });
  }
  return files;
}

function excelCellText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.formula) return "[formula]";
    if (value.richText) return value.richText.map((part) => part.text).join("");
    if (value.text) return value.text;
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

const AUTOMATIC_FIELD_CONFIG = {
  cuit_adquirente: { headers: ["CUIT ADQUIRENTE"], aliases: ["cuit_adquirente", "cuitCuilCompradorAdquirente"], validation: "cuit" },
  nombre_adquirente: { headers: ["NOMBRE ADQUIRENTE"], aliases: ["nombre_adquirente", "nombreCompletoCompradorAdquirente"], validation: "text" },
  email: { headers: ["EMAIL F 08 APARTADO D"], aliases: ["email", "correoElectronico", "mail"], validation: "email" },
  cuit_adquirente_f08: { headers: ["CUIT ADQUIRIENTE"], aliases: ["cuit_adquirente_f08", "cuit_adquirente", "cuitCuilCompradorAdquirente"], validation: "cuit" },
  nombre_adquirente_f08: { headers: ["NOMBRE ADQUIRIENTE"], aliases: ["nombre_adquirente_f08", "nombre_adquirente", "nombreCompletoCompradorAdquirente"], validation: "text" },
  numero_formulario_08: { headers: ["NRO FORMULARIO 08"], aliases: ["numero_formulario_08", "numeroFormulario", "nroFormulario"], validation: "text" },
  dominio: { headers: ["DOMINIO"], aliases: ["dominio", "patente", "dominioPatente"], validation: "domain" },
  domicilio_adquirente: { headers: ["DOMICILIO ADQUIRIENTE"], aliases: ["domicilio_adquirente", "domicilio", "domicilioComprador"], validation: "text" },
  lugar_fecha_impresion_osd: { headers: ["LUGARY FECHA DE IMPRESIDN DEL OSD:"], aliases: ["lugar_fecha_impresion_osd", "fecha", "fechaFormulario", "lugarYFecha"], validation: "date" },
  marca: { headers: ["MARCA, MODELO, TIPO (F.08/TOAD)"], aliases: ["marca", "marcaModelo", "marcaYModelo"], validation: "text", sharedCellGroup: "marca_modelo_tipo" },
  modelo: { headers: ["MARCA, MODELO, TIPO (F.08/TOAD)"], aliases: ["modelo", "marcaModelo", "marcaYModelo"], validation: "text", sharedCellGroup: "marca_modelo_tipo" },
  modelo_anio: { headers: ["MODELO (TAX-AÑO DE FABRICACIÓN)"], aliases: ["modelo_anio", "modeloAnio", "modeloAno"], validation: "text" },
  anio_fabricacion: { headers: ["ANIO (TAX-AÑO DE FABRICACIÓN)"], aliases: ["anio_fabricacion", "anio", "ano"], validation: "year" },
  cuit_vendedor: { headers: ["CUIT VENDEDOR (F.08)"], aliases: ["cuit_vendedor", "cuitCuilVendedor", "cuitVendedor", "cuilVendedor"], validation: "cuit" },
  nombre_vendedor: { headers: ["NOMBRE VENDEDOR"], aliases: ["nombre_vendedor", "nombreVendedor", "vendedor"], validation: "text" },
  letra_multa: { headers: ["LETRA MULTA"], aliases: ["letra_multa"], validation: "text" },
  fecha_liquidacion: { headers: ["FECHA DE LIQUIDACIÓN (HOY)"], aliases: ["fecha_liquidacion"], validation: "date" },
  fecha_inicio_tramite: { headers: ["FECHA INICIO TRÁMITE"], aliases: ["fecha_inicio_tramite", "fechaInicioTramite", "fechaInicio"], validation: "date" },
  periodo: { headers: ["PERÍODO F. 08"], aliases: ["periodo"], validation: "text" },
  monto_operacion: { headers: ["MONTO OPERACION"], aliases: ["monto_operacion", "montoOperacion", "monto", "precio"], validation: "amount" },
};

const NON_AUTOMATIC_COLUMNS = [
  { field: "remito_sinavico", headers: ["REMOTO SI/NO/VACIO", "REMITO SINAVICO"], tipo: "manual", rule: "NO PONER" },
  { field: "resolucion", headers: ["RESOLUCIÓN"], tipo: "manual" },
  { field: "tramite", headers: ["TRAMITE"], tipo: "manual" },
  { field: "indicador_titular_suplente", headers: ["INICIADOR (TITULAR/SUPLENTE)"], tipo: "manual" },
  { field: "cuit_iniciador", headers: ["CUIT INICIADOR"], tipo: "manual" },
  { field: "caracter", headers: ["CARÁCTER"], tipo: "fijo_template" },
  { field: "registro", headers: ["REGISTRO"], tipo: "fijo_template" },
  { field: "impuesto", headers: ["$ IMPUESTO"], tipo: "manual" },
  { field: "intereses", headers: ["$ INTERESES"], tipo: "manual" },
  { field: "sintesis_multa", headers: ["% MULTA (DOBLE)"], tipo: "manual" },
  { field: "multa", headers: ["$ MULTA"], tipo: "manual" },
  { field: "total", headers: ["TOTAL"], tipo: "manual" },
  { field: "avaluo", headers: ["AVALUO DNRPA (TOAD)"], tipo: "manual" },
  { field: "mayor_valor", headers: ["MAYOR VALOR"], tipo: "formula" },
  { field: "alicuota", headers: ["ALÍCUOTA"], tipo: "formula" },
  { field: "impuesto_determinado", headers: ["IMPUESTO DETERMINADO"], tipo: "fijo_template" },
];

function normalizeHeaderKey(value) {
  return stripAccents(String(value || "")).replace(/\s+/g, " ").trim().toUpperCase();
}

function columnLetter(columnNumber) {
  let value = columnNumber;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function cellHasFormula(cell) {
  return Boolean(cell?.formula || (cell?.value && typeof cell.value === "object" && cell.value.formula));
}

function xmlDecode(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function findIllegalXmlCharacter(value) {
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint > 0xffff) index += 1;
    const legal =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!legal) return { index, codePoint };
  }
  return null;
}

function validateXml(xml) {
  let parseError = null;
  const parser = new SaxesParser({ xmlns: false });
  parser.onerror = (error) => {
    parseError = {
      message: error.message,
      line: parser.line + 1,
      column: parser.column + 1,
    };
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    if (!parseError) {
      parseError = {
        message: error.message,
        line: parser.line + 1,
        column: parser.column + 1,
      };
    }
  }
  return parseError ? { ok: false, ...parseError } : { ok: true, message: "content.xml valido" };
}

function formulaSnapshot(xml) {
  return [...String(xml).matchAll(/\btable:formula="([^"]*)"/g)].map((match) => match[1]);
}

function extractTableXml(contentXml, worksheetName) {
  const escapedName = worksheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contentXml.match(new RegExp(`<table:table\\b[^>]*table:name="${escapedName}"[^>]*>[\\s\\S]*?<\\/table:table>`));
  if (!match) throw new Error(`ODS invalido: no se encontro la hoja ${worksheetName}.`);
  return { xml: match[0], start: match.index };
}

function extractRowXml(tableXml, rowNumber) {
  const rows = [...tableXml.matchAll(/<table:table-row\b[\s\S]*?<\/table:table-row>/g)];
  const row = rows[rowNumber - 1];
  if (!row) throw new Error(`ODS invalido: no se encontro la fila ${rowNumber}.`);
  return { xml: row[0], start: row.index };
}

function tokenizeOdsCells(rowXml) {
  return [...rowXml.matchAll(/<table:(?:table-cell|covered-table-cell)\b[^>]*\/>|<table:(?:table-cell|covered-table-cell)\b[^>]*>[\s\S]*?<\/table:(?:table-cell|covered-table-cell)>/g)].map((match) => {
    const repeated = match[0].match(/\btable:number-columns-repeated="(\d+)"/);
    return { xml: match[0], start: match.index, count: repeated ? Number(repeated[1]) : 1 };
  });
}

function odsCellText(cellXml) {
  return xmlDecode(
    String(cellXml || "")
      .replace(/<text:s(?:\s[^>]*)?\/>/g, " ")
      .replace(/<text:tab(?:\s[^>]*)?\/>/g, "\t")
      .replace(/<text:line-break(?:\s[^>]*)?\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

function removeRepeatedAttribute(cellXml) {
  return cellXml.replace(/\s+table:number-columns-repeated="\d+"/, "");
}

function withRepeatedCount(cellXml, count) {
  const base = removeRepeatedAttribute(cellXml);
  if (count <= 1) return base;
  return base.replace(/^(<table:(?:table-cell|covered-table-cell)\b)/, `$1 table:number-columns-repeated="${count}"`);
}

function replaceOdsCell(rowXml, columnNumber, replaceCell) {
  const cells = tokenizeOdsCells(rowXml);
  let currentColumn = 1;
  for (let index = 0; index < cells.length; index += 1) {
    const token = cells[index];
    const endColumn = currentColumn + token.count - 1;
    if (columnNumber >= currentColumn && columnNumber <= endColumn) {
      const offset = columnNumber - currentColumn;
      const before = offset;
      const after = token.count - offset - 1;
      const singleCellXml = removeRepeatedAttribute(token.xml);
      const replacement = replaceCell(singleCellXml);
      const parts = [];
      if (before > 0) parts.push(withRepeatedCount(singleCellXml, before));
      parts.push(replacement);
      if (after > 0) parts.push(withRepeatedCount(singleCellXml, after));
      return rowXml.slice(0, token.start) + parts.join("") + rowXml.slice(token.start + token.xml.length);
    }
    currentColumn = endColumn + 1;
  }
  throw new Error(`ODS invalido: no se encontro la columna ${columnNumber} en la fila destino.`);
}

function odsCellAt(rowXml, columnNumber) {
  let currentColumn = 1;
  for (const token of tokenizeOdsCells(rowXml)) {
    const endColumn = currentColumn + token.count - 1;
    if (columnNumber >= currentColumn && columnNumber <= endColumn) return removeRepeatedAttribute(token.xml);
    currentColumn = endColumn + 1;
  }
  return null;
}

function buildOdsCellXml(cellXml, value, validation) {
  if (/\btable:formula=/.test(cellXml)) return null;
  const illegal = findIllegalXmlCharacter(value);
  if (illegal) {
    throw new Error(`Valor rechazado: caracter XML ilegal U+${illegal.codePoint.toString(16).toUpperCase().padStart(4, "0")} en posicion ${illegal.index}.`);
  }
  const isAmount = validation === "amount";
  const serialized = isAmount ? String(Number(value)) : String(value);
  const openingMatch = cellXml.match(/^<table:(?:table-cell|covered-table-cell)\b[^>]*\/?>/);
  if (!openingMatch) throw new Error("ODS invalido: celda destino sin apertura XML reconocible.");
  let opening = openingMatch[0]
    .replace(/\/>$/, ">")
    .replace(/\s+(?:office:value-type|office:value|office:string-value|office:date-value|calcext:value-type)="[^"]*"/g, "");
  opening = opening.replace(
    />$/,
    isAmount
      ? ` office:value-type="float" office:value="${xmlEscape(serialized)}" calcext:value-type="float">`
      : ` office:value-type="string" calcext:value-type="string">`
  );
  return `${opening}<text:p>${xmlEscape(serialized)}</text:p></table:table-cell>`;
}

async function loadOdsContent(templatePath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const contentEntry = archive.file("content.xml");
  if (!contentEntry) throw new Error("ODS invalido: falta content.xml.");
  return { archive, contentXml: await contentEntry.async("string") };
}

async function buildAllowedFieldsMapping(templatePath) {
  const { contentXml } = await loadOdsContent(templatePath);
  const worksheetNameMatch = contentXml.match(/<table:table\b[^>]*table:name="([^"]+)"/);
  if (!worksheetNameMatch) throw new Error("ODS invalido: no contiene hojas.");
  const worksheetName = xmlDecode(worksheetNameMatch[1]);
  const tableXml = extractTableXml(contentXml, worksheetName).xml;
  const headerRowXml = extractRowXml(tableXml, 1).xml;
  const targetRowXml = extractRowXml(tableXml, 3).xml;
  const headerIndex = new Map();
  let col = 1;
  for (const token of tokenizeOdsCells(headerRowXml)) {
    const header = odsCellText(token.xml);
    if (header) {
      headerIndex.set(normalizeHeaderKey(header), { header, col, column: columnLetter(col), cell: `${columnLetter(col)}3` });
    }
    col += token.count;
  }

  const mapping = [];
  for (const fieldName of AUTOMATIC_FIELD_ORDER) {
    const config = AUTOMATIC_FIELD_CONFIG[fieldName];
    const match = (config.headers || []).map(normalizeHeaderKey).map((header) => headerIndex.get(header)).find(Boolean) || null;
    const targetCell = match ? odsCellAt(targetRowXml, match.col) : null;
    const hasFormula = targetCell ? /\btable:formula=/.test(targetCell) : false;
    mapping.push({
      campo: fieldName,
      encabezado_excel: match?.header || null,
      columna: match?.column || null,
      celda_destino: match?.cell || null,
      tipo: hasFormula ? "formula" : match ? "automatico" : "manual",
      regla: hasFormula ? "FORMULA" : match ? "automatico" : "sin_columna_en_template",
      aliases: config.aliases,
      validation: config.validation,
      sharedCellGroup: config.sharedCellGroup || null,
    });
  }

  for (const config of NON_AUTOMATIC_COLUMNS) {
    const match = (config.headers || []).map(normalizeHeaderKey).map((header) => headerIndex.get(header)).find(Boolean) || null;
    if (!match) continue;
    const targetCell = odsCellAt(targetRowXml, match.col);
    const hasFormula = /\btable:formula=/.test(targetCell);
    mapping.push({
      campo: config.field,
      encabezado_excel: match.header,
      columna: match.column,
      celda_destino: match.cell,
      tipo: hasFormula ? "formula" : config.tipo,
      regla: config.rule || (hasFormula ? "FORMULA" : config.tipo),
    });
  }

  return {
    template: templatePath,
    worksheet: worksheetName,
    fields: mapping,
  };
}

async function writeAllowedFieldsMappingDebug(templatePath) {
  const mapping = await buildAllowedFieldsMapping(templatePath);
  fs.writeFileSync(ALLOWED_FIELDS_MAPPING_DEBUG_PATH, JSON.stringify(mapping, null, 2), "utf8");
  return mapping;
}

async function readBackXlsxCells(xlsxPath, cellAddresses = []) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("XLSX invalido: no contiene hojas.");
  const cells = {};
  for (const cellAddress of cellAddresses) {
    const value = worksheet.getCell(cellAddress).value;
    cells[cellAddress] = value && typeof value === "object" && value.text ? value.text : value;
  }
  return {
    file: xlsxPath,
    worksheet: worksheet.name,
    cells,
  };
}

async function readBackOdsCells(odsPath, worksheetName, cellAddresses = []) {
  const { contentXml } = await loadOdsContent(odsPath);
  const rowXml = extractRowXml(extractTableXml(contentXml, worksheetName).xml, 3).xml;
  const cells = {};
  for (const cellAddress of cellAddresses) {
    const column = cellAddress.match(/^[A-Z]+/)[0]
      .split("")
      .reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
    cells[cellAddress] = odsCellText(odsCellAt(rowXml, column));
  }
  return { file: odsPath, worksheet: worksheetName, cells, formulas: formulaSnapshot(contentXml) };
}

function odsXmlValidationReport(originalXml, generatedXml) {
  const originalValidation = validateXml(originalXml);
  const generatedValidation = validateXml(generatedXml);
  const originalFormulas = formulaSnapshot(originalXml);
  const generatedFormulas = formulaSnapshot(generatedXml);
  return {
    originalContentXml: originalValidation,
    generatedContentXml: generatedValidation,
    formulasPreserved: JSON.stringify(originalFormulas) === JSON.stringify(generatedFormulas),
    originalFormulaCount: originalFormulas.length,
    generatedFormulaCount: generatedFormulas.length,
    numeroaletrasPreserved: generatedFormulas.some((formula) => /NUMEROALETRAS/i.test(xmlDecode(formula))),
  };
}

function formatOdsValidationReport(report) {
  const lines = [
    `original_content.xml: ${report.originalContentXml.ok ? "VALIDO" : "INVALIDO"}`,
    `generated_content.xml: ${report.generatedContentXml.ok ? "VALIDO" : "INVALIDO"}`,
    `formulas_preserved: ${report.formulasPreserved ? "SI" : "NO"}`,
    `formula_count_original: ${report.originalFormulaCount}`,
    `formula_count_generated: ${report.generatedFormulaCount}`,
    `numeroaletras_preserved: ${report.numeroaletrasPreserved ? "SI" : "NO"}`,
  ];
  if (!report.generatedContentXml.ok) {
    lines.push(`error: ${report.generatedContentXml.message}`);
    lines.push(`linea: ${report.generatedContentXml.line}`);
    lines.push(`columna: ${report.generatedContentXml.column}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeOdsWorkbook(templatePath, outPath, debugRunDir, log, fullExtraction, allowedFieldsMapping) {
  const { archive, contentXml: originalXml } = await loadOdsContent(templatePath);
  const xmlDebugDir = path.join(debugRunDir, "xml");
  fs.mkdirSync(xmlDebugDir, { recursive: true });
  const originalXmlPath = path.join(xmlDebugDir, "original_content.xml");
  const generatedXmlPath = path.join(xmlDebugDir, "generated_content.xml");
  const validationReportPath = path.join(xmlDebugDir, "xml_validation_report.txt");
  fs.writeFileSync(originalXmlPath, originalXml, "utf8");

  const table = extractTableXml(originalXml, allowedFieldsMapping.worksheet);
  const row = extractRowXml(table.xml, 3);
  let generatedRowXml = row.xml;
  const mapping = {};
  const writeGroups = new Map();
  for (const mapItem of allowedFieldsMapping.fields || []) {
    if (mapItem.tipo !== "automatico" || !mapItem.celda_destino) continue;
    const extraction = fullExtraction.fields?.[mapItem.campo];
    if (!extraction || !["validado", "revisar"].includes(extraction.estado)) continue;
    if (!writeGroups.has(mapItem.celda_destino)) {
      writeGroups.set(mapItem.celda_destino, { fields: [], values: [], validation: mapItem.validation, column: mapItem.columna });
    }
    const group = writeGroups.get(mapItem.celda_destino);
    group.fields.push(mapItem.campo);
    if (extraction.valor_normalizado != null && extraction.valor_normalizado !== "") group.values.push(extraction.valor_normalizado);
  }

  for (const [cellAddress, group] of writeGroups.entries()) {
    const columnNumber = group.column.split("").reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
    const previousCellXml = odsCellAt(generatedRowXml, columnNumber);
    const uniqueValues = [...new Set(group.values.map((value) => String(value).trim()).filter(Boolean))];
    let value = uniqueValues.join(" ");
    if (group.validation === "amount") value = Number(String(uniqueValues[0] || "").replace(/[^\d.-]/g, ""));
    mapping[cellAddress] = { cell: cellAddress, fields: group.fields, valueAttempted: value, worksheet: allowedFieldsMapping.worksheet, status: "pendiente" };
    if (/\btable:formula=/.test(previousCellXml)) {
      mapping[cellAddress].status = "omitido_formula_existente";
      log.push({ phase: "write_ods_allowed", cell: cellAddress, fields: group.fields, status: "omitido_formula_existente", value });
      continue;
    }
    if (value == null || value === "" || (typeof value === "number" && Number.isNaN(value))) {
      mapping[cellAddress].status = "omitido_valor_nulo";
      log.push({ phase: "write_ods_allowed", cell: cellAddress, fields: group.fields, status: "omitido_valor_nulo", value: null });
      continue;
    }
    const previous = odsCellText(previousCellXml);
    generatedRowXml = replaceOdsCell(generatedRowXml, columnNumber, (cellXml) => buildOdsCellXml(cellXml, value, group.validation));
    mapping[cellAddress].status = "escrito";
    mapping[cellAddress].previous = previous;
    mapping[cellAddress].valueWritten = value;
    log.push({ phase: "write_ods_allowed", cell: cellAddress, fields: group.fields, status: "escrito", value, previous });
  }

  const generatedTableXml = table.xml.slice(0, row.start) + generatedRowXml + table.xml.slice(row.start + row.xml.length);
  const generatedXml = originalXml.slice(0, table.start) + generatedTableXml + originalXml.slice(table.start + table.xml.length);
  fs.writeFileSync(generatedXmlPath, generatedXml, "utf8");
  const report = odsXmlValidationReport(originalXml, generatedXml);
  fs.writeFileSync(validationReportPath, formatOdsValidationReport(report), "utf8");
  if (!report.generatedContentXml.ok) {
    throw new Error(`ODS abortado: content.xml invalido en linea ${report.generatedContentXml.line}, columna ${report.generatedContentXml.column}: ${report.generatedContentXml.message}`);
  }
  if (!report.formulasPreserved || !report.numeroaletrasPreserved) {
    throw new Error("ODS abortado: las formulas originales, incluida NUMEROALETRAS, no fueron preservadas.");
  }

  archive.file("content.xml", generatedXml, { compression: "DEFLATE" });
  const mimetype = await archive.file("mimetype").async("string");
  archive.file("mimetype", mimetype, { compression: "STORE" });
  const outputBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/vnd.oasis.opendocument.spreadsheet" });
  const temporaryPath = `${outPath}.tmp`;
  fs.writeFileSync(temporaryPath, outputBuffer);
  const generatedArchive = await loadOdsContent(temporaryPath);
  const archiveValidation = validateXml(generatedArchive.contentXml);
  if (!archiveValidation.ok) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`ODS abortado: content.xml empaquetado invalido en linea ${archiveValidation.line}, columna ${archiveValidation.column}: ${archiveValidation.message}`);
  }
  fs.renameSync(temporaryPath, outPath);
  log.push({ phase: "write_ods_validation", status: "ok", value: validationReportPath, formulas: report.generatedFormulaCount, numeroaletras: report.numeroaletrasPreserved });
  return { path: outPath, fixedMapping: mapping, validationReport: report, xmlDebugDir };
}

async function writeXlsxWorkbook(templatePath, outPath, log, fullExtraction, allowedFieldsMapping) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("XLSX invalido: no contiene hojas.");

  const mapping = {};
  log.push({ phase: "write_xlsx_template", status: "hoja_detectada", value: worksheet.name, template: templatePath });

  const writeGroups = new Map();
  for (const mapItem of allowedFieldsMapping.fields || []) {
    if (mapItem.tipo !== "automatico" || !mapItem.celda_destino) continue;
    const extraction = fullExtraction.fields?.[mapItem.campo];
    if (!extraction || !["validado", "revisar"].includes(extraction.estado)) continue;
    if (!writeGroups.has(mapItem.celda_destino)) {
      writeGroups.set(mapItem.celda_destino, { fields: [], values: [], validation: mapItem.validation });
    }
    const group = writeGroups.get(mapItem.celda_destino);
    group.fields.push(mapItem.campo);
    if (extraction.valor_normalizado != null && extraction.valor_normalizado !== "") {
      group.values.push(extraction.valor_normalizado);
    }
  }

  for (const [cellAddress, group] of writeGroups.entries()) {
    const cell = worksheet.getCell(cellAddress);
    const uniqueValues = [...new Set(group.values.map((value) => String(value).trim()).filter(Boolean))];
    let value = uniqueValues.join(" ");
    if (group.validation === "amount") value = Number(String(uniqueValues[0] || "").replace(/[^\d.-]/g, ""));
    mapping[cellAddress] = {
      cell: cellAddress,
      fields: group.fields,
      valueAttempted: value,
      worksheet: worksheet.name,
      status: "pendiente",
    };

    if (cellHasFormula(cell)) {
      mapping[cellAddress].status = "omitido_formula_existente";
      log.push({ phase: "write_xlsx_allowed", cell: cellAddress, fields: group.fields, status: "omitido_formula_existente", value });
      continue;
    }

    if (value == null || value === "" || (typeof value === "number" && Number.isNaN(value))) {
      mapping[cellAddress].status = "omitido_valor_nulo";
      log.push({ phase: "write_xlsx_allowed", cell: cellAddress, fields: group.fields, status: "omitido_valor_nulo", value: null });
      continue;
    }

    const previous = excelCellText(cell);
    cell.value = value;
    mapping[cellAddress].status = "escrito";
    mapping[cellAddress].previous = previous;
    mapping[cellAddress].valueWritten = value;
    log.push({ phase: "write_xlsx_allowed", cell: cellAddress, fields: group.fields, status: "escrito", value, previous });
  }

  await workbook.xlsx.writeFile(outPath);
  return { path: outPath, fixedMapping: mapping };
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

function detectedFieldCandidate(detectedFields, aliases) {
  for (const alias of aliases || []) {
    const data = detectedFields[alias];
    if (data?.value != null && data.value !== "") return data;
  }
  return null;
}

function isClearFormBoilerplate(value) {
  const text = normalizeHeaderKey(value);
  if (!text) return true;
  if (text === "[OBJECT OBJECT]") return true;
  if (/^(NO|SI|S\/N|N\/A|NULL)$/.test(text)) return true;
  return ["SOLICITUD TIPO", "FORMULARIO 08", "REGISTRO NACIONAL", "DIRECCION NACIONAL", "CERTIFICACION DE FIRMAS", "NO PONER"].some((marker) => text.includes(marker));
}

function normalizeFlexibleValue(value, validation) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (isNullLikeValue(raw) || isClearFormBoilerplate(raw)) return { value: null, valid: false, reasonable: false, reason: "basura_o_texto_fijo" };
  if (validation === "cuit") {
    const normalized = cleanCuit(raw);
    return { value: normalized || raw, valid: Boolean(normalized), reasonable: /\d/.test(raw) && raw.replace(/\D/g, "").length >= 8, reason: normalized ? null : "cuit_no_validado" };
  }
  if (validation === "domain") {
    const normalized = cleanDomain(raw);
    return { value: normalized || raw.toUpperCase(), valid: Boolean(normalized), reasonable: /^[A-Z0-9 -]{5,12}$/i.test(raw), reason: normalized ? null : "dominio_no_validado" };
  }
  if (validation === "email") {
    const normalized = cleanEmail(raw);
    return { value: normalized || raw, valid: Boolean(normalized), reasonable: raw.includes("@"), reason: normalized ? null : "email_no_validado" };
  }
  if (validation === "date") {
    const normalized = formatDateDdMmYy(raw);
    return { value: normalized || raw, valid: Boolean(normalized), reasonable: /\d{1,2}|ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE/i.test(raw), reason: normalized ? null : "fecha_no_validada" };
  }
  if (validation === "amount") {
    const numericText = raw.replace(/[^\d,.-]/g, "");
    const normalized = numericText.includes(",") ? numericText.replace(/\./g, "").replace(",", ".") : numericText.replace(/\./g, "");
    const valid = /^\d+(?:\.\d+)?$/.test(normalized);
    return { value: valid ? Number(normalized) : raw, valid, reasonable: /\d/.test(raw), reason: valid ? null : "monto_no_validado" };
  }
  if (validation === "year") {
    const match = raw.match(/\b(19|20)\d{2}\b/);
    return { value: match ? match[0] : raw, valid: Boolean(match), reasonable: /\d{2,4}/.test(raw), reason: match ? null : "anio_no_validado" };
  }
  return { value: raw, valid: raw.length >= 2, reasonable: raw.length >= 2, reason: raw.length >= 2 ? null : "texto_insuficiente" };
}

function buildFullExtraction(detectedFields, diagnostic, allowedFieldsMapping) {
  const fields = {};
  const parsed = diagnostic?.visionStructured || null;
  const parseError = diagnostic?.visionParseError || null;
  const basicText = String(diagnostic?.visionBasicRawResponse || "").trim();

  for (const fieldName of AUTOMATIC_FIELD_ORDER) {
    const config = AUTOMATIC_FIELD_CONFIG[fieldName];
    const mapItem = (allowedFieldsMapping.fields || []).find((item) => item.campo === fieldName) || {};
    const vision = diagnostic?.visionStructured ? visionFieldCandidate(diagnostic.visionStructured, config.aliases || [fieldName]) : null;
    const fallback = detectedFieldCandidate(detectedFields, config.aliases || []);
    const data = vision || fallback;
    const rawValue = data?.value ?? null;
    const confidence = data?.confidence || "baja_confianza";
    const normalized = rawValue == null ? { value: null, valid: false, reasonable: false, reason: "valor_vacio" } : normalizeFlexibleValue(rawValue, config.validation);
    const reasons = [];
    let estado = "vacío";

    if (!parsed) reasons.push(parseError ? "parseo_fallido" : "json_vision_ausente");
    if (rawValue == null || rawValue === "") reasons.push("valor_vacio");
    if (rawValue != null && normalized.valid && confidence === "alta") estado = "validado";
    else if (rawValue != null && normalized.valid) estado = "revisar";
    else if (rawValue != null && normalized.reason !== "basura_o_texto_fijo" && normalized.reasonable) estado = "revisar";
    else if (rawValue != null) estado = "rechazado";
    if (normalized.reason) reasons.push(normalized.reason);
    if (confidence !== "alta" && rawValue != null && ["validado", "revisar"].includes(estado)) reasons.push(`confianza_${confidence}`);
    if (mapItem.tipo !== "automatico" && rawValue != null) reasons.push(`no_escritura_tipo_${mapItem.tipo || "sin_mapeo"}`);

    fields[fieldName] = {
      valor_vision_original: rawValue,
      valor_normalizado: ["validado", "revisar"].includes(estado) ? normalized.value : null,
      confianza: confidence,
      observacion: data?.evidence || data?.notes || null,
      estado,
      motivo: reasons.length ? reasons : null,
      celda_destino: mapItem.celda_destino || null,
      encabezado_excel: mapItem.encabezado_excel || null,
      tipo: mapItem.tipo || "sin_mapeo",
      escribible: mapItem.tipo === "automatico" && ["validado", "revisar"].includes(estado),
      fuente: vision ? "vision" : fallback ? "fallback_texto" : null,
    };
  }

  return {
    ok: Object.values(fields).some((item) => ["validado", "revisar"].includes(item.estado)),
    basicVision: {
      empty: !basicText,
      chars: basicText.length,
      preview: basicText.slice(0, 1000),
    },
    parse: {
      ok: Boolean(parsed) && !parseError,
      error: parseError,
    },
    fields,
    summary: {
      detected: Object.values(fields).filter((item) => item.valor_vision_original != null && item.valor_vision_original !== "").length,
      validado: Object.values(fields).filter((item) => item.estado === "validado").length,
      revisar: Object.values(fields).filter((item) => item.estado === "revisar").length,
      vacio: Object.values(fields).filter((item) => item.estado === "vacío").length,
      rechazado: Object.values(fields).filter((item) => item.estado === "rechazado").length,
      escribible: Object.values(fields).filter((item) => item.escribible).length,
    },
  };
}

async function processFile(filePath, allowedFieldsMapping) {
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
  const summary = summarizeFields(detectedFields);
  const fullExtraction = buildFullExtraction(detectedFields, diagnostic, allowedFieldsMapping);
  const validationReport = fullExtraction;
  const diagnosis = stats.useful
    ? "Vision recupero datos. Si el XLSX queda vacio, revisar allowed_fields_mapping/readback."
    : "OCR no recupero texto suficiente del manuscrito. El problema esta en preprocessing/OCR antes del mapeo.";

  log.push({ phase: "fields_found", status: "ok", value: summary.found });
  log.push({ phase: "fields_doubtful", status: summary.doubtful.length ? "revision" : "ok", value: summary.doubtful });
  log.push({ phase: "fields_missing", status: summary.missing.length ? "faltantes" : "ok", value: summary.missing });
  log.push({ phase: "debug_detected", status: debug.detected.length ? "ok" : "sin_datos", value: debug.detected });
  log.push({ phase: "debug_discarded", status: debug.discarded.length ? "revision" : "ok", value: debug.discarded });
  log.push({ phase: "ocr_diagnosis", status: stats.useful ? "mapeo_a_revisar_si_vacio" : "ocr_insuficiente", value: diagnosis });

  return {
    sourceFile: fileName,
    sourcePath: filePath,
    processedAt: new Date().toISOString(),
    documentType: "Formulario 08 manuscrito",
    extractionMode: method,
    reviewRequired: true,
    ocrStats: stats,
    ocrDiagnostic: diagnostic,
    ocrBlocks: blocks,
    extractorDiagnosis: diagnosis,
    detectedFields,
    fullExtraction,
    validationReport,
    auxiliaryFields: {
      localidad: detectedFields.localidad,
      provincia: detectedFields.provincia,
      codigoPostal: detectedFields.codigoPostal,
      telefono: detectedFields.telefono,
      observacionesRelevantes: detectedFields.observacionesRelevantes,
    },
    allowedFieldsMapping,
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
  ensureOpenAiEnvFiles();
  if (!hasConfiguredOpenAiApiKey()) {
    console.error(VISION_API_KEY_MESSAGE);
    return;
  }
  console.log("OPENAI_API_KEY detectada");
  moveExistingAuxiliaryOutputFiles();
  const allLogs = [];
  const templatePath = findTemplate();
  console.log(`Template oficial utilizado: ${path.relative(PROJECT_ROOT, templatePath)}`);
  allLogs.push({ file: null, phase: "template", status: "oficial_utilizado", value: path.relative(PROJECT_ROOT, templatePath), absolutePath: templatePath });
  const allowedFieldsMapping = await writeAllowedFieldsMappingDebug(templatePath);
  allLogs.push({ file: null, phase: "template", status: "allowed_fields_mapping_escrito", value: ALLOWED_FIELDS_MAPPING_DEBUG_PATH, worksheet: allowedFieldsMapping.worksheet });
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
      const result = await processFile(filePath, allowedFieldsMapping);
      const baseName = path.basename(fileName, path.extname(fileName)).replace(/[^A-Z0-9_-]+/gi, "_");
      const stamp = nowStamp();
      const debugRunDir = path.join(DEBUG_DIR, `${baseName}_manuscrito_${stamp}`);
      fs.mkdirSync(debugRunDir, { recursive: true });
      const jsonPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}.json`);
      const odsPath = path.join(OUTPUT_DIR, `${baseName}_manuscrito_${stamp}.ods`);
      const xlsxPath = path.join(OUTPUT_DIR, `${baseName}_manuscrito_${stamp}.xlsx`);
      const rawOcrPath = path.join(debugRunDir, `${baseName}_manuscrito_raw_ocr.txt`);
      const originalDebugPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_original${path.extname(fileName).toLowerCase()}`);
      const preprocessedDebugPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_preprocessed.png`);
      const blocksPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_ocr_blocks.json`);
      const diagnosticPath = path.join(debugRunDir, `${baseName}_manuscrito_${stamp}_diagnostico.json`);
      fs.writeFileSync(rawOcrPath, result.rawOcrText || "", "utf8");
      copyDebugFile(filePath, originalDebugPath, result.log, "imagen_original");
      copyDebugFile(result.ocrDiagnostic?.bestImagePath || filePath, preprocessedDebugPath, result.log, "imagen_preprocesada_final");
      fs.writeFileSync(blocksPath, JSON.stringify({ sourceFile: fileName, blocks: result.ocrBlocks || [] }, null, 2), "utf8");
      fs.writeFileSync(path.join(debugRunDir, "allowed_fields_mapping.json"), JSON.stringify(allowedFieldsMapping, null, 2), "utf8");
      const writeableFields = Object.values(result.fullExtraction?.fields || {}).filter((item) => item.escribible);
      const candidateCount = Object.values(result.candidates || {}).reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
      const ocrFailed = result.ocrStats.chars < OCR_HARD_FAIL_CHARS;
      const hasUsefulDetectedData = result.fullExtraction?.summary?.detected > 0 || candidateCount > 0;
      const shouldWriteOds = !ocrFailed && hasUsefulDetectedData && writeableFields.length > 0;
      const configurationError = result.ocrDiagnostic?.configurationError || null;
      result.fullMapping = {
        template: templatePath,
        worksheet: allowedFieldsMapping.worksheet,
        allowedFieldsMapping: allowedFieldsMapping.fields,
        fields: result.fullExtraction?.fields || {},
      };
      result.outputMapping = Object.fromEntries(
        Object.entries(result.fullExtraction?.fields || {}).map(([fieldName, item]) => [
          fieldName,
          {
            cell: item.celda_destino,
            header: item.encabezado_excel,
            type: item.tipo,
            valueAttempted: item.valor_normalizado,
            confidence: item.confianza,
            status: shouldWriteOds && item.escribible ? "pendiente_escritura_ods" : "no_escritura",
            reason: item.escribible ? null : item.motivo,
          },
        ])
      );
      result.extractionStatus = {
        ok: shouldWriteOds,
        message: shouldWriteOds ? "Datos suficientes detectados para generar ODS editable parcial." : OCR_FAILURE_MESSAGE,
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
        xlsx: EXPERIMENTAL_XLSX_ENABLED && shouldWriteOds ? xlsxPath : null,
        ods: shouldWriteOds ? odsPath : null,
        rawOcr: rawOcrPath,
        originalImage: originalDebugPath,
        preprocessedImage: preprocessedDebugPath,
        ocrBlocks: blocksPath,
        diagnostic: diagnosticPath,
        allowedFieldsMapping: ALLOWED_FIELDS_MAPPING_DEBUG_PATH,
        fullExtraction: path.join(debugRunDir, "full_extraction.json"),
        fullMapping: path.join(debugRunDir, "full_mapping.json"),
        readbackOds: READBACK_ODS_DEBUG_PATH,
        readbackXlsx: EXPERIMENTAL_XLSX_ENABLED ? READBACK_XLSX_DEBUG_PATH : null,
        debugArtifacts: null,
        debugDir: debugRunDir,
      };
      result.outputFiles.debugArtifacts = await writeDebugArtifacts(debugRunDir, result, result.log);
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
            fullExtraction: result.fullExtraction,
            validationReport: result.validationReport,
            fullMapping: result.fullMapping,
            outputMapping: result.outputMapping,
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

      const odsLog = [];
      const odsResult = await writeOdsWorkbook(templatePath, odsPath, debugRunDir, odsLog, result.fullExtraction, allowedFieldsMapping);
      const writtenCells = Object.values(odsResult.fixedMapping || {}).filter((item) => item.status === "escrito").map((item) => item.cell);
      const odsReadback = await readBackOdsCells(odsPath, allowedFieldsMapping.worksheet, writtenCells);
      fs.writeFileSync(READBACK_ODS_DEBUG_PATH, JSON.stringify(odsReadback, null, 2), "utf8");
      fs.writeFileSync(path.join(debugRunDir, "readback_ods.json"), JSON.stringify(odsReadback, null, 2), "utf8");
      result.odsReadback = odsReadback;
      result.odsXmlValidation = odsResult.validationReport;
      result.outputMapping = odsResult.fixedMapping || result.outputMapping;
      result.fullMapping = { ...result.fullMapping, writeResult: result.outputMapping };
      result.outputFiles.debugArtifacts = await writeDebugArtifacts(debugRunDir, result, result.log);
      result.log.push({ phase: "output", status: "ods_escrito", value: odsPath });
      result.log.push({ phase: "output", status: "ods_readback_escrito", value: READBACK_ODS_DEBUG_PATH, worksheet: odsReadback.worksheet });
      result.log.push(...odsLog);
      if (EXPERIMENTAL_XLSX_ENABLED) {
        if (!fs.existsSync(TEMPLATE_XLSX_PATH)) throw new Error(`No existe el template XLSX experimental: ${TEMPLATE_XLSX_PATH}`);
        const xlsxLog = [];
        const xlsxResult = await writeXlsxWorkbook(TEMPLATE_XLSX_PATH, xlsxPath, xlsxLog, result.fullExtraction, allowedFieldsMapping);
        const xlsxWrittenCells = Object.values(xlsxResult.fixedMapping || {}).filter((item) => item.status === "escrito").map((item) => item.cell);
        const xlsxReadback = await readBackXlsxCells(xlsxPath, xlsxWrittenCells);
        fs.writeFileSync(READBACK_XLSX_DEBUG_PATH, JSON.stringify(xlsxReadback, null, 2), "utf8");
        fs.writeFileSync(path.join(debugRunDir, "readback_xlsx.json"), JSON.stringify(xlsxReadback, null, 2), "utf8");
        result.xlsxReadback = xlsxReadback;
        result.log.push({ phase: "output", status: "xlsx_experimental_escrito", value: xlsxPath });
        result.log.push(...xlsxLog);
      }
      fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
      if (result.ocrDiagnostic?.workDir) {
        fs.rmSync(result.ocrDiagnostic.workDir, { recursive: true, force: true });
      }
      allLogs.push(...result.log.map((entry) => ({ file: fileName, ...entry })));
      allLogs.push({ file: fileName, phase: "output", status: "json_escrito", value: jsonPath });
      processed += 1;
      console.log(`${fileName}: ODS generado ${odsPath}`);
      if (EXPERIMENTAL_XLSX_ENABLED) console.log(`${fileName}: XLSX experimental generado ${xlsxPath}`);
      console.log(`${fileName}: Debug generado ${debugRunDir}`);
    } catch (error) {
      allLogs.push({ file: fileName, phase: "processing", status: "error", value: error.message });
      console.warn(`${fileName}: no se pudo procesar (${error.message})`);
      failed += 1;
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
