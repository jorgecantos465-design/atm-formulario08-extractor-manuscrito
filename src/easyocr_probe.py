import json
import re
import sys
import traceback
from pathlib import Path


FIELD_KEYS = ["dominio", "fecha", "monto", "cuit", "nombre"]


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def candidate(value, confidence, evidence):
    value = normalize_text(value)
    if not value:
        return None
    return {
        "value": value,
        "confidence": round(float(confidence or 0), 4),
        "evidence": normalize_text(evidence),
    }


def json_number(value):
    try:
        value = float(value)
    except Exception:
        return value
    if value.is_integer():
        return int(value)
    return value


def normalize_bbox(bbox):
    return [[json_number(point[0]), json_number(point[1])] for point in bbox]


def best_match(patterns, lines):
    matches = []
    for item in lines:
        text = item["text"]
        for pattern in patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                found = candidate(match.group(0), item["confidence"], text)
                if found:
                    matches.append(found)
    matches.sort(key=lambda item: item["confidence"], reverse=True)
    return matches[0] if matches else None


def extract_name(lines):
    stop = re.compile(
        r"\b(FORMULARIO|SOLICITUD|DOMINIO|MARCA|MODELO|MOTOR|CHASIS|DOMICILIO|CALLE|"
        r"LOCALIDAD|PROVINCIA|CUIT|CUIL|DNI|FECHA|MONTO|REGISTRO|COMPRADOR|ADQUIRENTE|"
        r"VENDEDOR|TRANSFERENCIA|VEHICULO|PATENTE|ORIGINAL|INSTRUCCIONES|DENOMINACION|"
        r"ENTE|JURIDICO|JURIDICOS|MASCULIN|FEMENIN|TELEFONO|DOCUMENTO|AUTORIDAD|"
        r"DEUDAS|GRAVAMENES|JURAMENTO|IMPORTE|ACREEDOR|CONYUGE|NACIMIENTO|CONPLETOS|"
        r"NORSRES|NOMBFE|GUARDA|HABITUAL|OPTA|RESERVADO|SELLOS|INFRACCIONES)\b",
        re.IGNORECASE,
    )
    candidates = []
    for item in lines:
        text = normalize_text(item["text"])
        bbox = item.get("bbox") or []
        y_values = [point[1] for point in bbox if isinstance(point, list) and len(point) > 1]
        y_center = sum(y_values) / len(y_values) if y_values else 0
        if y_center and not 600 <= y_center <= 1050:
            continue
        if item["confidence"] < 0.2:
            continue
        if len(text) < 6 or stop.search(text):
            continue
        if text == text.upper():
            continue
        letters = re.findall(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+", text)
        if len(letters) < 2:
            continue
        if sum(len(part) for part in letters) < 6:
            continue
        if re.search(r"\d", text):
            continue
        candidates.append(candidate(text, item["confidence"], text))
    candidates = [item for item in candidates if item]
    candidates.sort(key=lambda item: (item["confidence"], len(item["value"])), reverse=True)
    return candidates[0] if candidates else None


def extract_fields(lines):
    full_text = "\n".join(item["text"] for item in lines)
    full_item = {"text": full_text, "confidence": max([item["confidence"] for item in lines], default=0)}
    search_lines = lines + [full_item]
    return {
        "dominio": best_match(
            [
                r"\b[A-Z]{3}\s?\d{3}\b",
                r"\b[A-Z]{2}\s?\d{3}\s?[A-Z]{2}\b",
            ],
            search_lines,
        ),
        "fecha": best_match(
            [
                r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b",
                r"\b\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+de\s+\d{2,4}\b",
            ],
            search_lines,
        ),
        "monto": best_match(
            [
                r"\$\s?\d[\d\.\,]*",
                r"\b\d{1,3}(?:\.\d{3})*(?:,\d{2})\b",
            ],
            search_lines,
        ),
        "cuit": best_match(
            [
                r"\b\d{2}[-\s]?\d{8}[-\s]?\d\b",
                r"\b(?:20|23|24|27|30|33|34)\d{9}\b",
            ],
            search_lines,
        ),
        "nombre": extract_name(lines),
    }


def write_outputs(raw_path, parsed_path, payload, raw_lines):
    raw_text = "\n".join(raw_lines)
    Path(raw_path).write_text(raw_text, encoding="utf-8")
    Path(parsed_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Uso: easyocr_probe.py <input_image> <raw_txt> <parsed_json>")

    image_path, raw_path, parsed_path = sys.argv[1:4]
    try:
        import easyocr

        reader = easyocr.Reader(["es", "en"], gpu=False, verbose=False)
        result = reader.readtext(image_path, detail=1, paragraph=False)
        lines = []
        raw_lines = []
        for bbox, text, confidence in result:
            text = normalize_text(text)
            clean_bbox = normalize_bbox(bbox)
            item = {
                "text": text,
                "confidence": float(confidence or 0),
                "bbox": clean_bbox,
            }
            lines.append(item)
            raw_lines.append(f"{item['confidence']:.4f}\t{text}\t{json.dumps(clean_bbox, ensure_ascii=False)}")

        fields = extract_fields(lines)
        payload = {
            "ok": True,
            "engine": "easyocr",
            "imagePath": image_path,
            "lineCount": len(lines),
            "rawText": "\n".join(item["text"] for item in lines),
            "fields": fields,
            "items": lines,
        }
        write_outputs(raw_path, parsed_path, payload, raw_lines)
    except Exception as error:
        payload = {
            "ok": False,
            "engine": "easyocr",
            "imagePath": image_path,
            "error": str(error),
            "traceback": traceback.format_exc(),
            "fields": {key: None for key in FIELD_KEYS},
        }
        write_outputs(raw_path, parsed_path, payload, [str(error)])
        raise


if __name__ == "__main__":
    main()
