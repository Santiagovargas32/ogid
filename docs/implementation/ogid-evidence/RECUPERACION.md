# Recuperación de la base operativa — 26/10/2026

**Corte histórico fechado.** Los recuentos, instalaciones y procesos de este informe pertenecen a su cierre; el estado posterior (punto 2, D y revisión D3 del 28/10) se consulta en [ESTADO.md](ESTADO.md). No retomar sus pendientes si ya figuran cerrados allí.


Estado: **cerrada, reparación exacta sin pérdida de registros**. Entrada de continuidad: [ESTADO.md](ESTADO.md). El usuario autorizó intentar reparar y, si hacía falta, crear otra base con lo recuperable y usarla como operativa.

## Resultado operativo

`backend/.env` selecciona `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite` desde las **20:40:56 UTC**. Sólo se modificó STORAGE_DB_PATH. Esquema efectivo **025**, mismo tamaño de 10.117.750.784 bytes y mismos datos lógicos recuperados. El original `/home/fedora/.local/share/ogid/db/ogid.sqlite` se conserva intacto con su bloque defectuoso; no es una base sana de reversión.

No se arrancó el servidor ni se consultaron proveedores/inferencia. Se verificó el almacenamiento real de OGID con sus workers. El backend permanece detenido y los procesos existentes de llama.cpp se conservaron. AGENT_MODE sigue configurado en shadow. La recuperación no acredita estabilidad continua de la aplicación ni calidad semántica de IA.

## Daño y reconstrucción

Btrfs rechazaba el bloque de 4096 bytes situado en offset 9685962752, página SQLite 2364738. El checksum esperado era 30a8db53. La lectura del origen fallaba con EIO; una copia normal no podía completarse.

La exploración de punteros identificó un bloque de overflow de **agent_evidence.sequence=338423**, dominio fundamentals, dentro del snapshot b17c4335-28f8-49af-84fd-0a55580d6b0e. El payload SEC tiene 118327 bytes. La fila conserva sus metadatos y el resto de su contenido era legible.

Se localizaron 19 copias íntegras coincidentes de ese payload en otros snapshots y un único eslabón de overflow huérfano, página 2364737. La reconstrucción exige simultáneamente:

- Coincidencia de todos los bytes legibles anteriores y posteriores al hueco.
- Mismo tamaño y estructura de registro, sin modificar sus IDs ni metadatos.
- Checksum CRC32C reconstruido coincidente con el esperado por Btrfs.
- SHA256 del snapshot completo, con sus 334 evidencias en orden, idéntico al manifiesto original: `569d179924954f76f3ef6aba6b5a5e6b75e473b04717a62fbf215cadeb3ab84e`.

Se creó un candidato mediante reflink Btrfs y se escribió únicamente ese bloque reconstruido. No se recurrió a una exportación que omitiera filas ni a un .recover con datos inciertos. El original conserva su inode, tamaño y mtime de preflight. El procedimiento de overflow sigue el [formato de archivo de SQLite](https://sqlite.org/fileformat2.html#cell_payload_overflow_pages).

## Verificación completada

| Control | Resultado real |
|---|---|
| Integridad SQLite completa | integrity_check=ok |
| Claves foráneas | Cero violaciones |
| Esquema | Mismos objetos, migraciones 001–025 y checksums coincidentes con código |
| Tablas | Recuentos iguales en las 88 tablas, incluidas las FTS |
| Lectura física del candidato | Todos los 10.117.750.784 bytes legibles |
| Snapshot reparado | SHA256 y 334 evidencias idénticos al manifiesto congelado |
| Pérdida | Cero registros descartados; ningún valor lógico inventado o cambiado |
| App: escritura/lectores | Transacción con rollback; el lector no ve cambios sin confirmar |
| App: coordinación | StorageManager ready, SQLite 3.53.4, segundo escritor rechazado, lectores readonly/query_only |
| App: datos | Noticia, consulta C y evidencia reparada legibles; chunk de evidencia a través del query worker |
| App: cierre | Limpio y sin owner residual |

Conteos conservados: 146.475 artículos, 295.076 revisiones de noticias, 356.701 evidencias del agente, 678 snapshots, 42.383 velas y 48.526 revisiones de velas. No se confunden esos recuentos con cobertura editorial enriquecida: las tablas derivadas B/C siguen pendientes de backfill.

La validación completa duró 1729 segundos y terminó a las **19:21:52 UTC**. SHA256 de la imagen validada antes de abrir un escritor: `70278475c0611a17125300ff10883fcd87115a1c8889dad7f0829627e8ac7806`. La prueba de aplicación finalizó a las **20:38:14 UTC**. Abrir un escritor puede cambiar metadatos del archivo, por lo que ese hash identifica el corte validado, no una base mutable para siempre.

## Evidencia y continuidad

Cohorte privada: `/srv/bitcoin/ogid/recovery-20261026-183735/`. Pruebas principales: reconstruction-proof.json, candidate.json, validation-result.json, application-probe.json y activation.json. Copias de los informes en `.implementation-evidence/2026-10-26/recovery/`; scripts privados de creación, reconstrucción, validación y prueba de aplicación en ese mismo directorio del workspace. No versionar bases, bloques binarios, payloads, logs ni la copia privada de .env.

El sistema de aprobación impidió una comprobación de procesos por un límite temporal de uso, sin ejecutar la acción; al reanudar, la revisión volvió a funcionar. No queda ningún bloqueo por ese motivo. El primer intento de activación guardó la configuración privada y falló antes de editar .env; se corrigió y comprobó que sólo cambió la ruta de base.

La imagen `source-schema025.partial.sqlite` conserva un placeholder y sigue siendo sólo de análisis; no seleccionarla como operativa ni presentarla como backup íntegro. El reflink reparado tampoco sustituye una copia independiente del SSD: el backup manual sigue a cargo del usuario según lo acordado.

No se ha determinado la causa física del checksum fallido. La reparación cierra el defecto de datos localizado, no certifica el hardware ni explica todas las latencias históricas del backend. No repetir la recuperación sin un nuevo indicio. La siguiente acción vigente está en ESTADO.md: el punto 2 posterior resuelve instalaciones/enriquecimiento antes de D.1, descrita en [ENTREGA-D.md](ENTREGA-D.md); cierre global pendiente según [CIERRE-FINAL.md](CIERRE-FINAL.md).
