# Skill: Carga de datos inicial - extractor F08 manuscrito

## Objetivo
Administrar muestras escaneadas/manuscritas, plantillas y datos de prueba sin exponer informacion sensible.

## Cuando usarla
Usala al agregar inputs, templates, ejemplos OCR o casos de debug.

## Pasos obligatorios
- Confirmar sensibilidad de documentos.
- Preferir muestras anonimizadas.
- No borrar `input/`, `templates/`, `logs`, `output` ni `debug`.
- Documentar calidad de imagen/PDF.

## Checklist antes de modificar
- Permiso para usar muestra.
- OCR esperado conocido.
- Template compatible identificado.

## Checklist antes de finalizar
- Extractor encuentra muestras.
- No se agregan datos sensibles sin aviso.
- Casos quedan trazables.

## Errores que debe evitar
- Usar imagenes personales sin anonimizar.
- Mezclar muestras digitales y manuscritas sin etiqueta.
- Borrar debug util para trazabilidad.

## Comandos de verificacion
- `npm run extractor`

## Formato de reporte final
- Muestras afectadas.
- Sensibilidad.
- Calidad/OCR.
- Validacion.

