# Inteligencia prospectiva: incremento de backend

Este incremento añade memoria de evidencias y escenarios opcionales al coordinador
de IA existente. No incluye una interfaz nueva. Los cálculos deterministas de
riesgo, impacto y precios siguen siendo responsabilidad de los servicios actuales.

## Activación y comportamiento habitual

La función requiere simultáneamente `AI_MODE=shadow` o `visible`, un proveedor
habilitado, `intelligence` en `AI_FEATURES` y `INTELLIGENCE_MEMORY_ENABLED=1`.
Con `AI_MODE=off`, sin la feature o sin memoria, no se construye el archivo de
inteligencia ni se captura evidencia ni se programa análisis prospectivo.
El `.env` personal no forma parte del cambio.

Con la función desactivada, llama.cpp conserva el límite `AI_MAX_OUTPUT_TOKENS`
y su temperatura anterior. Los perfiles por tarea se activan con inteligencia
prospectiva o con un `AI_TASK_OUTPUT_TOKENS` explícito. Para probar de forma gradual:

```dotenv
AI_PROVIDER=llamacpp
AI_MODE=shadow
AI_FEATURES=article-summary,country-insight,market-explanation,intelligence
INTELLIGENCE_MEMORY_ENABLED=1
INTELLIGENCE_MEMORY_DIR=data/intelligence
AI_ANALYSIS_INTERVAL_MS=600000
AI_PACKET_MAX_CHARS=96000
AI_CONTEXT_TOKENS=131072
AI_MAX_INPUT_TOKENS=65536
AI_TOKENIZE_INPUTS=0
AI_MAX_CONCURRENCY=1
```

Se conservan las credenciales, URL y modelos del proveedor ya configurado.
`AI_CONTEXT_TOKENS` declara el contexto disponible; no reconfigura el servidor
llama.cpp. `AI_TASK_OUTPUT_TOKENS` acepta un JSON como
`{"market_scenarios":6144,"event_scenarios":4096}`. Los límites admitidos son
256–32768 tokens por tarea. Los valores predeterminados de salida son 1536 para
resúmenes, 4096 para países, 3072 para explicación de mercado, 6144 para escenarios
de mercado y 4096 para eventos.

`AI_TOKENIZE_INPUTS=1` requiere `/apply-template` y `/tokenize` compatibles en el
servidor. Comprueba el tamaño real de entrada antes de generar; sin esa opción se
limita el paquete por caracteres y se valida la configuración de contexto, sin
garantizar un conteo exacto de tokens. Una respuesta con `finish_reason=length`
se rechaza como `AI_OUTPUT_TRUNCATED`, aunque contenga JSON válido.

Los presupuestos diarios `0` significan sin límite únicamente con el proveedor
llamacpp; no eliminan contadores ni reservas. Los diagnósticos exponen `null` en
presupuesto/restante y flags `requestsUnlimited`/`tokensUnlimited`. Esta opción
depende del proveedor seleccionado, no verifica quién opera el endpoint.

## Ciclo, publicación y datos

El arranque del servidor inicia el coordinador cuando el refresco de fondo está
habilitado. `DISABLE_BACKGROUND_REFRESH=1` impide iniciar el temporizador; los
ciclos manuales pueden capturar evidencia si la función está activada. El ciclo
de noticias archiva el corpus admitido para mercado. Awareness se captura durante
el ciclo prospectivo respetando la admisión de las fuentes. Un fallo de archivo
queda registrado y deshabilita sus escrituras, sin cancelar el refresco normal.
La parada cancela los temporizadores, espera al ciclo en curso y vacía el escritor.

`shadow` genera y persiste, sin añadir los escenarios a la proyección pública.
`visible` añade `marketScenarios`, `eventScenarios`, `evaluation` e
`intelligenceStatus` al estado `ai` que transportan REST/WebSocket. Este incremento
no añade componentes de frontend; la visualización queda para otro cambio.

El directorio `backend/data/intelligence/` está excluido de Git. Contiene el
journal JSONL, paquetes por hash y resúmenes diarios. Hay un único escritor por
proceso; el directorio no debe compartirse entre workers. El journal valida
checksums y secuencias al reiniciar. Una última línea JSON incompleta se repara;
la corrupción interior o de checksum deshabilita el archivo. Los 90 días de
retención son de memoria; no eliminan el journal ni los paquetes en disco.

## Pronósticos y límites

El baseline requiere al menos 60 velas diarias observadas completas, sin datos
sintéticos ni información futura. Emite una sola predicción por instrumento y
sesión objetivo, registra el resultado observado y calcula Brier/log loss.
Las probabilidades siguen siendo experimentales y sin calibrar; `llmWeight=0`
mantiene el LLM fuera de la probabilidad numérica usada. Las sesiones de bolsa
conservan las limitaciones del calendario existente. No se promete precisión ni
se promueve automáticamente al modelo.

## Verificación

Desde `backend/`, ejecutar `npm run check`, `npm test` y `npm run build`.
Las pruebas nuevas cubren desactivación, arranque/parada, captura RSS, aislamiento
de fallos, modos shadow/visible con proveedor simulado, reinicio, deduplicación,
corrupción, retención en memoria, escenarios, baseline y resolución prospectiva.
Las pruebas de integración necesitan abrir puertos locales. El proveedor real
y sus parámetros de muestreo requieren un smoke separado en el entorno operado;
los fixtures no acreditan compatibilidad con un modelo desplegado.

Validación local del 4 de octubre de 2026: sintaxis y build aprobados, suite
completa 548/548 con puertos locales permitidos y `git diff --check` limpio.
El smoke real contra el endpoint configurado falló con código `network` sin
respuesta HTTP. No se ha validado el modelo remoto ni se ha publicado o desplegado
este incremento.
