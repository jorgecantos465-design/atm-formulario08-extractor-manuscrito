# ATM Formulario 08 Extractor Manuscrito

Extractor asistido para imagenes o PDFs escaneados del Formulario 08 manuscrito.

Este proyecto esta separado del extractor `atm-formulario08-extractor` porque los documentos manuscritos requieren otra estrategia: OCR, tolerancia a baja legibilidad, trazabilidad y revision humana posterior.

## Estructura

```text
atm-formulario08-extractor-manuscrito/
  input/
  output/
  logs/
  src/
  templates/
```

## Instalacion

```bash
npm install
```

Para OCR real de imagenes o PDFs escaneados, instalar herramientas externas y dejarlas disponibles en el `PATH`:

- `tesseract` con idioma `spa`
- Para PDFs escaneados: `pdftoppm` o `magick`

Si esas herramientas no estan instaladas, el extractor igualmente acepta el archivo, pero solo podra leer texto embebido en PDFs. Los campos no legibles salen como `null` con confianza `baja`.

## Como ejecutar

1. Copiar imagenes o PDFs escaneados en `input/`.
2. Ejecutar:

```bash
npm run extractor
```

Tambien se puede usar:

```bash
npm run extract-manuscrito
```

## Resultado

Por cada archivo de `input/`, se genera un JSON en `output/`.

El JSON incluye:

- `detectedFields`: campos humanos detectados con `value`, `confidence`, `evidence` y `notes`.
- `templateOutput`: salida normalizada con placeholders compatibles con el template actual.
- `templateConfidence`: confianza por placeholder.
- `auxiliaryFields`: localidad, provincia, codigo postal, telefono y observaciones para revision humana.
- `summary`: campos encontrados, dudosos y no encontrados.
- `rawTextPreview`: vista parcial del texto OCR usado.

Los niveles de confianza son:

- `alta`
- `media`
- `baja`

Cuando un campo no es legible o no se encuentra, el valor queda en `null` y la confianza queda en `baja`.

## Mapeo de campos

El archivo `src/field-mapping.json` define la equivalencia entre campos detectados en el Formulario 08 manuscrito y los campos/placeholders del template final usado por el extractor actual.

Ejemplos:

- `dominio` -> `@atributo15@`
- `numeroFormulario` -> `@atributo14@`
- `fecha` -> `@atributo17@`
- `cuitCuilCompradorAdquirente` -> `@usuario@` y `@atributo8@`
- `nombreCompletoCompradorAdquirente` -> `@atributo9@`
- `domicilio` -> `@atributo16@`
- `correoElectronico` -> `@email@`
- `iniciadorNombre` -> `@atributo10@`
- `iniciadorCuitCuil` -> `@atributo11@`

## Logs

Cada ejecucion genera un log JSONL en `logs/`.

El log registra:

- archivo procesado
- metodo de lectura usado
- campos encontrados
- campos dudosos
- campos no encontrados
- errores de procesamiento
- archivo JSON generado

## Limitaciones

Esta primera version no busca automatizacion perfecta. Esta pensada como asistencia de extraccion con revision humana posterior.

Limitaciones esperadas:

- La escritura manuscrita puede producir OCR incompleto o incorrecto.
- La deteccion de nombre, domicilio, localidad y provincia depende de que el OCR conserve etiquetas cercanas.
- Si el documento no tiene texto embebido y no estan instalados `tesseract` y un renderizador de PDF, los PDFs escaneados no podran leerse.
- El extractor no inventa datos. Ante duda o baja legibilidad devuelve `null` o confianza `baja`.
- Los campos auxiliares como telefono, localidad, provincia, codigo postal y observaciones no tienen placeholder confirmado en el template actual, por eso quedan disponibles para revision humana ademas del `templateOutput`.
