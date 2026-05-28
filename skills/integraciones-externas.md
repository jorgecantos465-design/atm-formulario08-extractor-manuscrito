# Skill: Integraciones externas - extractor F08 manuscrito

## Objetivo
Gestionar Tesseract, Poppler/ImageMagick u OCR/vision externos sin hacerlos obligatorios para todos los casos.

## Cuando usarla
Usala al cambiar deteccion de herramientas, comandos OCR, renderizado PDF o documentacion de entorno.

## Pasos obligatorios
- Detectar herramienta disponible.
- Documentar instalacion y PATH.
- Mantener fallback a texto embebido.
- Capturar errores externos en logs.

## Checklist antes de modificar
- Herramienta autorizada.
- No se agregan dependencias npm sin permiso.
- Fallback definido.

## Checklist antes de finalizar
- Extractor corre aunque falte OCR.
- Error externo queda claro.
- README o notas actualizadas si aplica.

## Errores que debe evitar
- Fallar todo el pipeline si falta Tesseract.
- Hardcodear paths locales.
- Ocultar errores de conversion.

## Comandos de verificacion
- `npm run extractor`
- `tesseract --version`
- `magick --version`

## Formato de reporte final
- Herramienta externa.
- Fallback.
- Prueba realizada.
- Riesgos de entorno.

