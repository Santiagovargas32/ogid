# Comparación de logs originales

Fechas UTC. Lectura completa por programa; extractos contextuales mediante lista de campos permitidos. Los originales no se modifican.

| Ejecución | Ventana observada | Segundos | HTTP completados / 5xx | Warn / error | Cierre |
|---|---|---:|---:|---:|---|
| shadow-backend-20261019-092503.log | 2026-10-19T07:25:04.004Z → 2026-10-19T07:26:19.759Z | 75.755 | 3 / 3 (100.00%) | 5 / 2 | registrado |
| shadow-backend-20261019-093603.log | 2026-10-19T07:36:04.644Z → 2026-10-19T07:57:44.167Z | 1299.523 | 1668 / 14 (0.84%) | 104 / 20 | registrado |
| shadow-backend-20261019-102723.log | 2026-10-19T08:27:23.871Z → 2026-10-19T09:42:17.031Z | 4493.16 | 8596 / 184 (2.14%) | 129 / 264 | no demostrado |
| shadow-backend-20261019-115112.log | 2026-10-19T09:51:13.783Z → 2026-10-19T10:06:02.700Z | 888.917 | 2286 / 156 (6.82%) | 23 / 179 | registrado |
| shadow-backend-recovery-20261019.log | 2026-10-19T10:22:41.267Z → 2026-10-19T10:27:41.307Z | 300.04 | 4 / 2 (50.00%) | 0 / 2 | no demostrado |
| shadow-backend-recovery-20261019-run2.log | 2026-10-19T10:32:14.614Z → 2026-10-19T10:45:46.713Z | 812.099 | 967 / 3 (0.31%) | 14 / 8 | registrado |
| shadow-backend-recovery-20261019-run3.log | 2026-10-19T10:45:47.916Z → 2026-10-19T11:00:13.874Z | 865.958 | 853 / 21 (2.46%) | 64 / 3 | registrado |
| shadow-backend-final-20261019.log | 2026-10-19T11:41:44.676Z → 2026-10-19T11:58:35.738Z | 1011.062 | 1381 / 47 (3.40%) | 31 / 12 | registrado |
| shadow-backend-verified-20261019.log | 2026-10-19T11:58:36.538Z → 2026-10-19T12:54:05.194Z | 3328.656 | 5557 / 51 (0.92%) | 268 / 48 | registrado |
| shadow-backend-read-isolation-20261019.log | 2026-10-19T12:55:49.452Z → 2026-10-19T13:02:29.658Z | 400.206 | 357 / 8 (2.24%) | 26 / 3 | no demostrado |

Los 5xx usan como denominador las peticiones HTTP completadas en cada archivo; no son tasas de disponibilidad por tiempo. Cada firma conserva primera aparición, contexto ±2 registros, frecuencia, última línea y fase en [logs.json](logs.json). Las latencias son por endpoint y ejecución.

Otros artefactos leídos: 554.

No constan SHA ni configuración completa por ejecución: no se atribuyen automáticamente estos logs a HEAD. Los IDs correlacionables son principalmente requestId y snapshotId; faltan eventos durables para reconstruir todos los turnos. Los informes llamados final/verified no prueban estabilidad.

## shadow-backend-20261019-092503.log

SHA-256 `c1af57cd5af00c0694a21e84b7f525b41ab9143d30eda7f906cb53948432a7ff`; 26 líneas, 22 objetos JSON. Fases: `{'startup': 22}`.

- Línea 23: 2026-10-19T07:25:58.492Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 24: 2026-10-19T07:25:58.492Z — shutdown_signal_received 
- Línea 25: 2026-10-19T07:25:58.492Z — startup_failed STORAGE_OUTCOME_UNKNOWN
- Línea 26: 2026-10-19T07:26:19.759Z — server_stopped 

Huecos >30 s: 0; mayor: 0 s. Inicios de proveedor sin pareja al final: `{}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 1 registros; primera línea 9, última 9.
- `storage_slow_sql` / `None`: 1 registros; primera línea 17, última 17.
- `storage_slow_sql` / `None`: 1 registros; primera línea 18, última 18.
- `storage_slow_sql` / `None`: 1 registros; primera línea 20, última 20.
- `storage_slow_sql` / `None`: 1 registros; primera línea 22, última 22.
- `storage_worker_failed` / `STORAGE_OUTCOME_UNKNOWN`: 1 registros; primera línea 23, última 23.
- `startup_failed` / `STORAGE_OUTCOME_UNKNOWN`: 1 registros; primera línea 25, última 25.

## shadow-backend-20261019-093603.log

SHA-256 `4105a84df415f18775c5c19dbce241c07077a84693e0c06370928259d41722b7`; 1866 líneas, 1862 objetos JSON. Fases: `{'startup': 17, 'running': 1807, 'shutdown': 38}`.

- Línea 22: 2026-10-19T07:37:39.182Z — server_started 
- Línea 23: 2026-10-19T07:37:39.775Z — agent_component_started broker
- Línea 26: 2026-10-19T07:37:42.917Z — agent_component_started opencode
- Línea 27: 2026-10-19T07:37:42.929Z — agent_component_started worker
- Línea 1829: 2026-10-19T07:57:33.199Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 1830: 2026-10-19T07:57:33.199Z — shutdown_signal_received 
- Línea 1865: 2026-10-19T07:57:44.167Z — server_stopped 
- Línea 1866: 2026-10-19T07:57:44.167Z — shutdown_failed 

Huecos >30 s: 2; mayor: 42.179 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 63 registros; primera línea 30, última 1670.
- `request_failed` / `STORAGE_NOT_READY`: 10 registros; primera línea 1841, última 1863.
- `storage_slow_sql` / `None`: 5 registros; primera línea 252, última 1601.
- `storage_slow_sql` / `None`: 4 registros; primera línea 95, última 1717.
- `storage_slow_sql` / `None`: 4 registros; primera línea 460, última 1470.
- `storage_slow_sql` / `None`: 3 registros; primera línea 16, última 1215.
- `storage_slow_sql` / `None`: 3 registros; primera línea 17, última 1314.
- `storage_slow_sql` / `None`: 3 registros; primera línea 18, última 1315.

## shadow-backend-20261019-102723.log

SHA-256 `d9736a1dc9b53e44bcc3ad2e4f220ffad00c1d74cb8620ba400357c471b74026`; 9271 líneas, 9267 objetos JSON. Fases: `{'startup': 18, 'running': 9249}`.

- Línea 23: 2026-10-19T08:28:46.826Z — server_started 
- Línea 25: 2026-10-19T08:28:47.438Z — agent_component_started broker
- Línea 27: 2026-10-19T08:28:50.387Z — agent_component_started opencode
- Línea 28: 2026-10-19T08:28:50.399Z — agent_component_started worker
- Línea 508: 2026-10-19T08:35:00.266Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 1404: 2026-10-19T08:40:15.055Z — analysis_worker_recovered 
- Línea 1747: 2026-10-19T08:43:32.170Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 1975: 2026-10-19T08:44:31.603Z — analysis_worker_recovered 

Huecos >30 s: 1; mayor: 36.22 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `request_failed` / `STORAGE_NOT_READY`: 93 registros; primera línea 570, última 1396.
- `request_failed` / `STORAGE_NOT_READY`: 78 registros; primera línea 518, última 1919.
- `storage_slow_sql` / `None`: 70 registros; primera línea 49, última 9124.
- `storage_command_failed` / `AGENT_EVIDENCE_NOT_FOUND`: 17 registros; primera línea 2567, última 8402.
- `request_failed` / `AGENT_EVIDENCE_NOT_FOUND`: 17 registros; primera línea 2568, última 8403.
- `storage_slow_sql` / `None`: 12 registros; primera línea 151, última 7425.
- `storage_command_failed` / `AGENT_CLUSTER_NOT_FOUND`: 11 registros; primera línea 2614, última 7560.
- `request_failed` / `AGENT_CLUSTER_NOT_FOUND`: 11 registros; primera línea 2615, última 7561.

## shadow-backend-20261019-115112.log

SHA-256 `dfae4079b15ecc9cf002ce8bf57f2e547dadb8b59adbab8757009de355e3ceb7`; 2541 líneas, 2537 objetos JSON. Fases: `{'startup': 18, 'running': 2483, 'shutdown': 36}`.

- Línea 23: 2026-10-19T09:52:21.056Z — server_started 
- Línea 25: 2026-10-19T09:52:21.670Z — agent_component_started broker
- Línea 27: 2026-10-19T09:52:25.014Z — agent_component_started opencode
- Línea 28: 2026-10-19T09:52:25.028Z — agent_component_started worker
- Línea 1308: 2026-10-19T09:58:00.790Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 2505: 2026-10-19T10:05:47.000Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 2506: 2026-10-19T10:05:47.000Z — shutdown_signal_received 
- Línea 2540: 2026-10-19T10:06:02.700Z — server_stopped 
- Línea 2541: 2026-10-19T10:06:02.700Z — shutdown_failed 

Huecos >30 s: 4; mayor: 76.428 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `request_failed` / `STORAGE_NOT_READY`: 100 registros; primera línea 1740, última 2537.
- `request_failed` / `STORAGE_NOT_READY`: 46 registros; primera línea 1313, última 2535.
- `pipeline_persistence_failed` / `STORAGE_NOT_READY`: 12 registros; primera línea 2511, última 2527.
- `news_cycle_failed` / `None`: 8 registros; primera línea 1735, última 2516.
- `pipeline_persistence_failed` / `STORAGE_OUTCOME_UNKNOWN`: 4 registros; primera línea 2507, última 2510.
- `storage_slow_sql` / `None`: 3 registros; primera línea 157, última 418.
- `storage_slow_sql` / `None`: 3 registros; primera línea 1286, última 2465.
- `storage_slow_sql` / `None`: 3 registros; primera línea 1744, última 2036.

## shadow-backend-recovery-20261019.log

SHA-256 `dbf2dcd91b57c5ee6ba126c787607360c129ffba751141d5b33353564e050ab7`; 12 líneas, 8 objetos JSON. Fases: `{'startup': 8}`.

- Línea 10: 2026-10-19T10:27:41.285Z — storage_worker_failed STORAGE_START_TIMEOUT
- Línea 11: 2026-10-19T10:27:41.286Z — shutdown_signal_received 
- Línea 12: 2026-10-19T10:27:41.307Z — startup_failed STORAGE_START_TIMEOUT

Huecos >30 s: 3; mayor: 153.21 s. Inicios de proveedor sin pareja al final: `{}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_worker_failed` / `STORAGE_START_TIMEOUT`: 1 registros; primera línea 10, última 10.
- `startup_failed` / `STORAGE_START_TIMEOUT`: 1 registros; primera línea 12, última 12.

## shadow-backend-recovery-20261019-run2.log

SHA-256 `db460fda213cbfd5a1b973f3aff461d8394c5b19091ecd93c3d5baeddb9e40ef`; 1064 líneas, 1060 objetos JSON. Fases: `{'startup': 15, 'running': 1034, 'shutdown': 11}`.

- Línea 20: 2026-10-19T10:33:07.232Z — server_started 
- Línea 22: 2026-10-19T10:33:07.908Z — agent_component_started broker
- Línea 24: 2026-10-19T10:33:11.078Z — agent_component_started opencode
- Línea 25: 2026-10-19T10:33:11.092Z — agent_component_started worker
- Línea 1054: 2026-10-19T10:44:13.117Z — shutdown_signal_received 
- Línea 1064: 2026-10-19T10:45:46.713Z — server_stopped 

Huecos >30 s: 1; mayor: 36.032 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 6 registros; primera línea 34, última 71.
- `news_provider_failed` / `None`: 2 registros; primera línea 63, última 998.
- `storage_slow_sql` / `None`: 2 registros; primera línea 92, última 203.
- `storage_command_failed` / `AGENT_EVIDENCE_NOT_FOUND`: 2 registros; primera línea 260, última 271.
- `request_failed` / `AGENT_EVIDENCE_NOT_FOUND`: 2 registros; primera línea 261, última 272.
- `storage_command_failed` / `AGENT_UNKNOWN_EVIDENCE`: 2 registros; primera línea 332, última 381.
- `request_failed` / `AGENT_UNKNOWN_EVIDENCE`: 2 registros; primera línea 334, última 383.
- `storage_slow_sql` / `None`: 1 registros; primera línea 9, última 9.

## shadow-backend-recovery-20261019-run3.log

SHA-256 `8a9b5ffcd0f9470e197f968185bf89e3aa7184bbf29cec46488eff8ace07f0c4`; 981 líneas, 977 objetos JSON. Fases: `{'startup': 33, 'running': 937, 'shutdown': 7}`.

- Línea 38: 2026-10-19T10:46:22.379Z — server_started 
- Línea 41: 2026-10-19T10:46:22.972Z — agent_component_started broker
- Línea 43: 2026-10-19T10:46:25.180Z — agent_component_started opencode
- Línea 44: 2026-10-19T10:46:25.191Z — agent_component_started worker
- Línea 242: 2026-10-19T10:49:02.383Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 272: 2026-10-19T10:49:20.134Z — analysis_worker_recovered 
- Línea 975: 2026-10-19T10:58:15.089Z — shutdown_signal_received 
- Línea 981: 2026-10-19T11:00:13.874Z — server_stopped 

Huecos >30 s: 2; mayor: 70.923 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 37 registros; primera línea 127, última 826.
- `storage_slow_sql` / `None`: 3 registros; primera línea 190, última 715.
- `storage_slow_sql` / `None`: 3 registros; primera línea 198, última 528.
- `storage_slow_sql` / `None`: 3 registros; primera línea 201, última 532.
- `storage_slow_sql` / `None`: 3 registros; primera línea 862, última 979.
- `news_provider_failed` / `None`: 2 registros; primera línea 74, última 928.
- `storage_slow_sql` / `None`: 2 registros; primera línea 179, última 631.
- `storage_slow_sql` / `None`: 2 registros; primera línea 182, última 184.

## shadow-backend-final-20261019.log

SHA-256 `6d6fdc9ba8afe594edd1c5bc4b02f2f25737e8ed9d0665d57ad49db92312b6c6`; 1504 líneas, 1500 objetos JSON. Fases: `{'startup': 63, 'running': 1427, 'shutdown': 10}`.

- Línea 68: 2026-10-19T11:43:18.382Z — server_started 
- Línea 69: 2026-10-19T11:43:19.003Z — agent_component_started broker
- Línea 73: 2026-10-19T11:43:22.262Z — agent_component_started opencode
- Línea 74: 2026-10-19T11:43:22.275Z — agent_component_started worker
- Línea 1495: 2026-10-19T11:57:04.916Z — shutdown_signal_received 
- Línea 1504: 2026-10-19T11:58:35.738Z — server_stopped 

Huecos >30 s: 1; mayor: 62.832 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 17 registros; primera línea 100, última 1067.
- `storage_command_failed` / `AGENT_CLUSTER_NOT_FOUND`: 3 registros; primera línea 370, última 1085.
- `request_failed` / `AGENT_CLUSTER_NOT_FOUND`: 3 registros; primera línea 371, última 1086.
- `news_provider_failed` / `None`: 2 registros; primera línea 131, última 1266.
- `storage_slow_sql` / `None`: 2 registros; primera línea 233, última 554.
- `storage_command_failed` / `AGENT_UNKNOWN_EVIDENCE`: 2 registros; primera línea 407, última 453.
- `request_failed` / `AGENT_UNKNOWN_EVIDENCE`: 2 registros; primera línea 408, última 454.
- `storage_slow_sql` / `None`: 1 registros; primera línea 11, última 11.

## shadow-backend-verified-20261019.log

SHA-256 `7a8e6981717a437385728c20b88bcbb56129a5be89b5221dcc5a1a47bd628487`; 6071 líneas, 6067 objetos JSON. Fases: `{'startup': 53, 'running': 6006, 'shutdown': 8}`.

- Línea 58: 2026-10-19T12:00:05.785Z — server_started 
- Línea 60: 2026-10-19T12:00:06.453Z — agent_component_started broker
- Línea 62: 2026-10-19T12:00:09.169Z — agent_component_started opencode
- Línea 63: 2026-10-19T12:00:09.179Z — agent_component_started worker
- Línea 1007: 2026-10-19T12:07:08.651Z — agent_component_exited opencode
- Línea 1008: 2026-10-19T12:07:08.652Z — agent_component_unavailable AGENT_COMPONENT_EXITED
- Línea 1020: 2026-10-19T12:07:11.843Z — agent_component_started opencode
- Línea 1955: 2026-10-19T12:15:07.629Z — agent_component_exited worker
- Línea 1956: 2026-10-19T12:15:07.629Z — agent_component_unavailable AGENT_COMPONENT_EXITED
- Línea 1960: 2026-10-19T12:15:08.649Z — agent_component_started worker
- Línea 3360: 2026-10-19T12:27:52.446Z — agent_component_exited worker
- Línea 3361: 2026-10-19T12:27:52.447Z — agent_component_unavailable AGENT_COMPONENT_EXITED
- Línea 3363: 2026-10-19T12:27:53.469Z — agent_component_started worker
- Línea 3424: 2026-10-19T12:28:28.323Z — agent_component_exited opencode
- Línea 3425: 2026-10-19T12:28:28.323Z — agent_component_unavailable AGENT_COMPONENT_EXITED
- Línea 3438: 2026-10-19T12:28:31.266Z — agent_component_started opencode
- Línea 3442: 2026-10-19T12:28:32.265Z — agent_component_exited worker
- Línea 3443: 2026-10-19T12:28:32.265Z — agent_component_unavailable AGENT_COMPONENT_EXITED
- Línea 3445: 2026-10-19T12:28:33.285Z — agent_component_started worker
- Línea 4053: 2026-10-19T12:37:03.924Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 4079: 2026-10-19T12:37:20.292Z — analysis_worker_recovered 
- Línea 5034: 2026-10-19T12:41:03.046Z — storage_worker_failed STORAGE_OUTCOME_UNKNOWN
- Línea 5072: 2026-10-19T12:41:15.962Z — analysis_worker_recovered 
- Línea 6064: 2026-10-19T12:53:21.388Z — shutdown_signal_received 
- Línea 6071: 2026-10-19T12:54:05.194Z — server_stopped 

Huecos >30 s: 1; mayor: 37.362 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': []}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 170 registros; primera línea 86, última 6048.
- `storage_slow_sql` / `None`: 14 registros; primera línea 1328, última 5978.
- `storage_slow_sql` / `None`: 9 registros; primera línea 199, última 6069.
- `storage_slow_sql` / `None`: 9 registros; primera línea 1323, última 5971.
- `request_failed` / `STORAGE_QUEUE_TIMEOUT`: 9 registros; primera línea 4629, última 5013.
- `storage_slow_sql` / `None`: 8 registros; primera línea 226, última 5862.
- `request_failed` / `STORAGE_WORKER_FAILED`: 6 registros; primera línea 5037, última 5042.
- `news_provider_failed` / `None`: 5 registros; primera línea 126, última 5479.

## shadow-backend-read-isolation-20261019.log

SHA-256 `972dcfb4851c48220ada95aac03c5c360bf4e9993cf25bd1cc62a33591fc8ebd`; 422 líneas, 418 objetos JSON. Fases: `{'startup': 23, 'running': 395}`.

- Línea 28: 2026-10-19T12:57:29.778Z — server_started 
- Línea 30: 2026-10-19T12:57:30.416Z — agent_component_started broker
- Línea 33: 2026-10-19T12:57:33.560Z — agent_component_started opencode
- Línea 34: 2026-10-19T12:57:33.583Z — agent_component_started worker

Huecos >30 s: 1; mayor: 40.074 s. Inicios de proveedor sin pareja al final: `{'newsapi': [], 'gnews': [], 'gdelt': [], 'rss': [272]}` (heurística por proveedor; concurrencia no identificada).

Firmas principales:

- `storage_slow_sql` / `None`: 4 registros; primera línea 108, última 262.
- `storage_slow_sql` / `None`: 4 registros; primera línea 110, última 189.
- `storage_slow_sql` / `None`: 3 registros; primera línea 106, última 188.
- `storage_slow_sql` / `None`: 3 registros; primera línea 149, última 417.
- `storage_slow_sql` / `None`: 2 registros; primera línea 31, última 331.
- `storage_slow_sql` / `None`: 1 registros; primera línea 9, última 9.
- `storage_slow_sql` / `None`: 1 registros; primera línea 16, última 16.
- `storage_slow_sql` / `None`: 1 registros; primera línea 17, última 17.
