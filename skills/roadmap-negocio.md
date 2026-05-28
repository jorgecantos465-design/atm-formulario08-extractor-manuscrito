# Skill: Roadmap y negocio - extractor F08 manuscrito

## Objetivo
Priorizar mejoras de asistencia para documentos manuscritos con foco en confianza, revision humana y salida estructurada.

## Cuando usarla
Usala para decidir nuevos campos, mejoras OCR, flujo de revision o limites de automatizacion.

## Pasos obligatorios
- Identificar tipo de documento y calidad esperada.
- Priorizar trazabilidad sobre automatizacion total.
- Definir que debe quedar para revision humana.
- Mantener compatibilidad con `templateOutput`.

## Checklist antes de modificar
- Caso de uso claro.
- No se promete precision perfecta.
- Campo nuevo tiene salida y confianza.

## Checklist antes de finalizar
- Limites documentados.
- Revision humana preservada.
- Riesgos de baja legibilidad claros.

## Errores que debe evitar
- Inventar datos ilegibles.
- Ocultar incertidumbre.
- Romper compatibilidad con extractor final.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Decision.
- Campos/flujo afectado.
- Riesgos de OCR.
- Proximo paso.

