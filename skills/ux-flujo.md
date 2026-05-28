# Skill: UX y flujo - extractor F08 manuscrito

## Objetivo
Mejorar revision humana asistida: resumen claro, evidencia util y errores accionables.

## Cuando usarla
Usala para mensajes, resumen, notas de confianza, README o formato de salida para revision.

## Pasos obligatorios
- Identificar quien revisa el JSON.
- Mostrar dudosos y no encontrados claramente.
- Mantener evidencia cercana al campo.
- No esconder limitaciones de OCR.

## Checklist antes de modificar
- Flujo de revision entendido.
- No cambia deteccion sin skill de motor.
- Salida sigue legible.

## Checklist antes de finalizar
- Summary ayuda a revisar.
- Errores indican accion posible.
- Campos auxiliares siguen disponibles.

## Errores que debe evitar
- Saturar JSON con ruido.
- Ocultar fuente/evidencia.
- Usar confianza ambigua.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Flujo revisado.
- Campos de revision.
- Mensajes cambiados.
- Riesgos.

