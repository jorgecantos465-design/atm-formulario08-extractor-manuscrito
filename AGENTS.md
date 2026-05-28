# AGENTS.md - atm-formulario08-extractor-manuscrito

## Objetivo del proyecto

Extractor asistido para imagenes o PDFs escaneados/manuscritos de Formulario 08. Produce JSON compatible con el template final, incluyendo confianza, evidencia y campos para revision humana.

## Stack tecnico detectado

- Node.js
- JavaScript CommonJS
- `pdf-parse` para PDFs con texto embebido
- `jszip` para manejo de archivos comprimidos/plantillas
- Dependencias externas opcionales: `tesseract` con idioma `spa`, `pdftoppm` o `magick`
- Salida JSON y logs JSONL

## Comandos

- Instalacion: `npm install`
- Ejecutar extractor: `npm run extractor`
- Alias: `npm run extract-manuscrito`
- Test: no hay script de test detectado
- Build: no hay script de build detectado
- Dev server: no aplica

## Estructura y archivos criticos

- `src/extract-manuscrito.js`: pipeline de lectura, OCR/texto embebido, deteccion y salida.
- `src/field-mapping.json`: equivalencia entre campos detectados y placeholders.
- `input/`: PDFs o imagenes escaneadas.
- `templates/`: plantilla de referencia.
- `output/`: JSON generado.
- `logs/`: trazabilidad JSONL por ejecucion.
- `debug/`: artefactos de depuracion, no fuente funcional.

## Reglas de trabajo

- No tocar `node_modules`, `output`, `logs` ni `debug` salvo pedido explicito.
- No modificar `package.json` sin avisar antes.
- No borrar ni sobrescribir documentos de `input/` o `templates/`.
- No inventar datos ante baja legibilidad: usar `null`, confianza `baja` y notas.
- Mantener salida compatible con `templateOutput` y `field-mapping.json`.
- Cualquier dependencia externa de OCR debe documentarse y no asumirse instalada.

## No tocar sin autorizacion

- `src/field-mapping.json` si cambia compatibilidad con el extractor/template final.
- Politica de confianza `alta`, `media`, `baja`.
- Archivos reales en `input/`.
- Plantillas en `templates/`.
- Reglas de no automatizacion perfecta y revision humana.

## Estrategia de commits

- Separar OCR/lectura, deteccion de campos, mapeo y formato de salida.
- Para cambios de deteccion, incluir muestras anonimizadas o describir casos.
- No mezclar mejoras heuristicas con cambios de schema JSON.

## Criterios de finalizacion

- `npm run extractor` procesa inputs disponibles sin romper.
- Cada archivo genera JSON con `detectedFields`, `templateOutput`, `templateConfidence`, `summary` y `rawTextPreview`.
- Campos dudosos quedan trazables con evidencia/notas.
- Logs JSONL se generan por ejecucion.

## Subagentes recomendados

Antes de activar un rol, revisar el indice operativo en `skills/README.md`.

- Roadmap y negocio: usar `skills/roadmap-negocio.md`.
- Arquitectura tecnica: usar `skills/arquitectura-tecnica.md`.
- Motor matematico / logica de negocio: usar `skills/motor-matematico-logica.md`.
- Datos iniciales / seed: usar `skills/carga-datos-inicial.md`.
- Testing y bugs: usar `skills/testing-bugs.md`.
- UX y flujo: usar `skills/ux-flujo.md`.
- Integraciones externas: usar `skills/integraciones-externas.md`.
