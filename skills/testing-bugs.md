# Skill: Testing y bugs - extractor F08 manuscrito

## Objetivo
Detectar fallas en OCR/texto embebido, deteccion de campos, confianza, logs y salida JSON.

## Cuando usarla
Usala ante documentos dificiles, campos dudosos, cambios de heuristica o errores de salida.

## Pasos obligatorios
- Reproducir con archivo de `input/`.
- Comparar `detectedFields`, `templateOutput` y `summary`.
- Verificar confianza y evidencia.
- Revisar log JSONL.

## Checklist antes de modificar
- Caso sensible protegido.
- Campo esperado definido.
- Herramientas OCR disponibles o ausencia documentada.

## Checklist antes de finalizar
- Extractor corre sin romper.
- Campos dudosos quedan como baja/media confianza.
- JSON mantiene estructura.

## Errores que debe evitar
- Convertir baja confianza en dato seguro.
- Ajustar heuristica solo para una muestra.
- Romper procesamiento batch.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Documento/caso.
- Campo afectado.
- Causa.
- Confianza resultante.

