# Skill: Arquitectura tecnica - extractor F08 manuscrito

## Objetivo
Mantener pipeline claro de lectura, OCR/texto embebido, deteccion, confianza y salida JSON.

## Limite arquitectonico
- Este repositorio acepta solo Formularios 08 manuscritos o escaneados.
- Vision esta permitido.
- Los servicios de IA paga estan permitidos.
- OCR clasico, texto embebido y Vision pueden convivir como estrategias de lectura.
- Los PDFs digitales pertenecen a `atm-formulario08-extractor`.

## Cuando usarla
Usala al tocar `extract-manuscrito.js`, `field-mapping.json`, logs o estructura de salida.

## Pasos obligatorios
- Revisar pipeline completo.
- Separar lectura, deteccion, mapeo y salida.
- Mantener compatibilidad JSON.
- No asumir OCR externo instalado.
- Mantener separada la logica de Formularios 08 digitales.

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
- Convertir este repositorio en el extractor general para PDFs digitales.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Pipeline afectado.
- Schema impactado.
- Validacion.
- Riesgos.
