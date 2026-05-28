# Skill: Motor matematico / logica - extractor F08 manuscrito

## Objetivo
Proteger heuristicas de deteccion, normalizacion, confianza y mapeo de campos manuscritos.

## Cuando usarla
Usala al cambiar patrones, scoring de confianza, `field-mapping.json` o normalizadores.

## Pasos obligatorios
- Definir evidencia requerida por campo.
- Mantener `null` ante duda fuerte.
- Separar valor detectado de valor normalizado.
- Actualizar confianza de forma conservadora.

## Checklist antes de modificar
- Campo y placeholder identificados.
- Ejemplo de OCR disponible.
- Riesgo de falso positivo evaluado.

## Checklist antes de finalizar
- No hay datos inventados.
- Confianza refleja evidencia.
- `templateOutput` sigue compatible.

## Errores que debe evitar
- Sobreconfiar en OCR ruidoso.
- Mapear campos auxiliares a placeholders no confirmados.
- Perder notas de evidencia.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Heuristica tocada.
- Evidencia.
- Confianza antes/despues.
- Riesgos.

