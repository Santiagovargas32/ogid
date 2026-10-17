# Evidencia ejecutada

Fixtures locales, sin abrir SQLite de producción ni leer `.env`. Node 24.22.0,
Linux x86_64, Ryzen 5 4500, 12 CPU lógicas y ~15,5 GiB de RAM visible. Las huellas
por fichero en `environment.json` corresponden al código utilizado en el soak.

- `before.json`: `origin/main` en `adf837311aa51e366b436c39103ba2f3d639da16`.
- `after.json`: mismo harness y fixture, código corregido.
- `soak-30m.json`: ejecución final de 30 minutos; no una suma de pruebas breves.
- `catalog.json`: catálogo completo serializado idéntico antes/después, 66 RSS
  habilitados y 435 búsquedas generadas. No se cambiaron sus configuraciones.
- `*-tests.txt`, `*-check.txt`, `build.txt`, `dependency-audit.txt` e inventario:
  resúmenes de comandos de CI. Backend: 747/747; MCP: 24/24; cero vulnerabilidades
  reportadas por `npm audit --omit=dev --audit-level=high`.

El fixture contiene 7.200 noticias distribuidas en 48 h y 7.200 noticias más
antiguas repartidas hasta ~302 días, 24 fuentes y 30 días de señales horarias.
Cada ronda añade una noticia, solicita 20 snapshots equivalentes concurrentes y
consulta estado. Al cambiar las entradas, el resultado anterior sigue disponible
mientras se calcula el siguiente. Las lecturas de `ready/refreshing` y las de
estado tienen como objetivo p95 <1 s; no se aplica ese umbral al cálculo completo.

`firstMs` mide la primera respuesta: en main entrega el cálculo completo; en el
fix entrega `preparing`. `readyMs` mide el tiempo adicional hasta disponer del
primer snapshot; no confundir ambos. El benchmark breve tiene 60 lecturas y es
orientativo; el soak aporta 34.480 lecturas. Los percentiles de ingestión mezclan
los lotes iniciales de 100 artículos y los incrementos de una noticia. La métrica
`writerCommands` cuenta órdenes, incluidas lecturas, **no escrituras SQLite**.
Los recuentos de `analysis_runs` y jobs permiten comprobar publicaciones; la
regresión de caché usa `total_changes()` para demostrar ausencia de escrituras.
`eventLoop.p95Ms` incluye el intervalo de muestreo de 20 ms. RSS es memoria total
del proceso con trabajadores, no sólo heap JS ni tamaño del corpus.

Reproducción desde la raíz, con dependencias instaladas y Node 24:

```sh
node --require ./backend/tests/testSetup.cjs backend/scripts/benchmark-persistence.js
OGID_BENCH_OUTPUT=/tmp/ogid-soak.json OGID_SOAK_MS=1800000 \
  node --require ./backend/tests/testSetup.cjs backend/scripts/benchmark-persistence.js
```

Para main, exportar ese commit a una carpeta aislada, instalar sus dependencias
y pasar `OGID_BENCH_ROOT=/ruta/baseline/backend` al mismo harness de esta rama.
`OGID_BENCH_ARTICLES` y `OGID_BENCH_HISTORY` controlan los volúmenes. El harness
crea y elimina únicamente su directorio temporal y escribe el resultado en
`OGID_BENCH_OUTPUT` cuando se especifica; no utiliza la base configurada.

Los comandos de CI ejecutados son `npm --prefix backend test`,
`npm --prefix backend run check`, `npm --prefix backend run build`,
`npm --prefix backend audit --omit=dev --audit-level=high`, y `check`,
`inventory:check`, `test` en `integrations/ogid-mcp`. No hay cambios de dependencias.
Las pruebas de seguridad/WebSocket/Awareness y el coordinador de frontend forman
parte de la suite backend. La prueba de UI usa DOM controlado; hace falta validar
el navegador y el despliegue reales conforme al runbook.
