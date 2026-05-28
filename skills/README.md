# Skills - atm-formulario08-extractor-manuscrito

## Indice

- `roadmap-negocio.md`: alcance de asistencia para F08 manuscrito.
- `arquitectura-tecnica.md`: pipeline OCR/texto -> deteccion -> JSON.
- `motor-matematico-logica.md`: parsing, mapeo, confianza y heuristicas.
- `carga-datos-inicial.md`: muestras escaneadas, templates y datos de prueba.
- `ux-flujo.md`: revision humana, mensajes y resumen.
- `testing-bugs.md`: casos dificiles, OCR, logs y JSON.
- `integraciones-externas.md`: Tesseract, Poppler/ImageMagick y entorno.

## Cuando activar cada skill

- Parsing, mapeo o confianza: `motor-matematico-logica.md` + `testing-bugs.md`.
- Pipeline o estructura de salida JSON: `arquitectura-tecnica.md`.
- Muestras o templates: `carga-datos-inicial.md`.
- Mensajes para operador o revision humana: `ux-flujo.md`.
- OCR/vision/herramientas externas: `integraciones-externas.md`.
- Alcance funcional: `roadmap-negocio.md`.

## Orden recomendado si hay varias capas

1. `roadmap-negocio.md` si cambia alcance.
2. `arquitectura-tecnica.md` si cambia pipeline o JSON.
3. `integraciones-externas.md` si cambia OCR/render.
4. `motor-matematico-logica.md` si cambia deteccion/confianza.
5. `carga-datos-inicial.md` si hay muestras/templates.
6. `ux-flujo.md` si cambian mensajes/resumen.
7. `testing-bugs.md` para cierre.

## Matriz de riesgo

- Bajo: README, mensajes, summary no estructural.
- Medio: heuristicas acotadas, logs, campos auxiliares.
- Alto: `field-mapping.json`, schema JSON, confianza, templates, OCR externo, documentos reales.

## Comandos seguros

- No hay comandos universales completamente seguros si hay documentos reales en `input/`.

## Comandos condicionales

- `npm run extractor`: solo con muestras autorizadas/controladas.
- `tesseract --version`, `magick --version`: opcionales para diagnosticar entorno.
- `npm install`: solo si faltan dependencias.

## Comandos prohibidos o que requieren confirmacion

- Tocar templates reales: requiere confirmacion.
- Tocar PDFs/imagenes reales o sensibles: requiere confirmacion.
- Borrar `input/`, `templates/`, `output/`, `logs/` o `debug/`: requiere confirmacion.
- `npm audit fix`: requiere confirmacion.
- Cambios en `package.json` o lockfile: requieren confirmacion.

## Ownership por archivos criticos

- `src/extract-manuscrito.js`: Arquitectura para pipeline; Motor logico para deteccion/confianza; Testing para casos.
- `src/field-mapping.json`: Motor logico + Arquitectura; requiere cuidado alto.
- `templates/`: Carga de datos inicial.
- `input/`: Carga de datos inicial.
- `logs/`, `output/`, summary: UX + Testing.
- Herramientas OCR externas: Integraciones externas.

## Regla de seguridad

No inventar campos. Ante duda, usar `null`, confianza `baja` y evidencia/notas para revision humana.

