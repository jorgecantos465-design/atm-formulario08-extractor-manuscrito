# Skill: Arquitectura tecnica - extractor F08 manuscrito

## Objetivo
Mantener pipeline claro de lectura, OCR/texto embebido, deteccion, confianza y salida JSON.

## Cuando usarla
Usala al tocar `extract-manuscrito.js`, `field-mapping.json`, logs o estructura de salida.

## Pasos obligatorios
- Revisar pipeline completo.
- Separar lectura, deteccion, mapeo y salida.
- Mantener compatibilidad JSON.
- No asumir OCR externo instalado.

## Checklist antes de modificar
- No se toca `package.json`.
- Dependencias externas documentadas.
- Schema de salida entendido.

## Checklist antes de finalizar
- `npm run extractor` procesa inputs.
- JSON conserva claves esperadas.
- Logs siguen generandose.

## Errores que debe evitar
- Romper `templateOutput`.
- Acoplar a una herramienta OCR obligatoria.
- Mezclar debug con salida final.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Pipeline afectado.
- Schema impactado.
- Validacion.
- Riesgos.

