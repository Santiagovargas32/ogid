import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OGID_OPERATIONS, OPERATIONS_VERSION } from "../../../backend/contracts/ogidOperations.js";
import {NEWS_CLASSIFICATION_VERSION,NEWS_LANGUAGES} from '../../../backend/services/news/newsClassification.js';
import {PUBLISHER_METHOD,SOURCE_PRIORITY_METHOD} from '../../../backend/services/news/publisherIdentity.js';

const target = fileURLToPath(new URL("../API-MCP.md", import.meta.url));
const unique = new Set(OGID_OPERATIONS.map(op => `${op.method} ${op.path}`));
const research = OGID_OPERATIONS.filter(op => op.profile === "research");
const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = ["# Inventario API → MCP", "", `Contrato ${OPERATIONS_VERSION}. Generado desde backend/contracts/ogidOperations.js; no editar a mano.`, "",
  `${unique.size} rutas JSON con método; ${research.length} operaciones de investigación y ${OGID_OPERATIONS.length - research.length} de operador. Las variantes almacenadas/proveedor comparten algunas rutas.`, "",
  "Las cuatro herramientas compatibles se conservan. ogid_get_awareness_sources compone el catálogo local versionado y la salud pública Awareness, sin una ruta adicional. El inventario cubre las rutas de backend/routes montadas bajo /api; WebSocket, archivos estáticos y transporte del túnel tienen contratos independientes.", "",
  "El research general conserva diez herramientas. El servicio OpenCode dedicado usa OGID_RESEARCH_SCOPE=agent-evidence: ogid_agent_evidence, ogid_agent_evidence_chunk, ogid_agent_clusters, ogid_get_capabilities y ogid_health; ogid_query se conserva para compatibilidad y se excluye de los permisos del analista v1.9; sus consultas quedan limitadas a evidencia congelada, clusters y metadata operativa. El alcance se verifica también al ejecutar la lectura, no sólo en el schema.", "",
  "Las rutas privadas de chat, dispositivos y control agentivo son de primera parte y no se exportan como herramientas MCP. Las rutas de medios retiradas responden MEDIA_RETIRED / HTTP 410 sin adquisición ni llamadas upstream; los consumidores deben dejar de consultarlas.", "",
  "| Operación | Método y ruta | Herramienta | Perfil / permiso | Proyección | Efectos / coste |", "| --- | --- | --- | --- | --- | --- |"];
for (const op of OGID_OPERATIONS) lines.push(`| ${op.id} | ${op.method} ${op.path} | ${op.tool} | ${op.profile} / ${op.scope} | ${op.projection} | ${cell(op.effects)}; ${cell(op.cost)} |`);
lines.push("", "## Contratos, cobertura y pruebas", "", "Los query arrays viajan como CSV tipado; no se permiten claves extra, cabeceras, URLs o rutas libres. fixed se añade exclusivamente en el cliente y se verifica en backend para operador. La API existente mantiene su autenticación sensible; el permiso MCP añade credenciales de alcance, sin retirarla.", "",
  "researchRoutes.integration.test.js compara todas las rutas montadas con este registro y ejecuta todas las lecturas contra backend real con proveedores bloqueados. operations.test.js verifica todas las operaciones operador mediante fixtures HTTP, métodos, permisos y cuerpos; no demuestra ejecución de proveedores reales. Las pruebas de archivo, protocolo y e2e comprueban los contratos especializados.", "");
for (const op of OGID_OPERATIONS) {
  lines.push(`### ${op.id}`, "", `Retención: ${op.retention}. Procedencia: ${op.provenance}. Calidad: ${op.quality}.`, "", "```json", JSON.stringify({ parameters: op.parameters, body: op.body, pathParameters: op.pathParameters || null, fixed: op.fixed }, null, 2), "```", "");
}
lines.push('', '## Metadatos editoriales opcionales', '',
  `capabilities.runtime.newsEditorial anuncia ${PUBLISHER_METHOD}, ${NEWS_CLASSIFICATION_VERSION}, idiomas ${NEWS_LANGUAGES.join('/')} y ${SOURCE_PRIORITY_METHOD}. Los artículos pueden incorporar transportProvider, discoverySourceId, publisherId, originChainId, publisherResolution y classification (método, idioma, estado, alcance textual y modalidad). La ausencia histórica sigue siendo desconocida. Sólo publisherId con resolución resolved identifica al editor; publisher/sourceName heredados pueden ser nombres atribuidos o candidatos. Google News sigue siendo descubrimiento.`, '',
  'La clasificación describe relevancia informativa; reported no acredita ocurrencia ni corroboración. Negación, posibilidad futura, opinión e idioma sin soporte son explícitos. El idioma esperado del catálogo no demuestra el idioma del artículo. La prioridad heredada es una política editorial, no una probabilidad de verdad ni una evaluación política.', '',
  'Los campos usan las proyecciones existentes, manteniendo envelopes, permisos, paginación estable y límites de bytes. Una revisión de metadatos conserva ID, publicación y contentRevision. El manifiesto de build añade hashes de lock e instalación, Node, contrato y esquema esperado; no es atestación criptográfica ni prueba de versión desplegada. effectiveSchemaVersion informa por separado del esquema aplicado en health.', '');
const output = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("API-MCP.md difiere del registro: ejecutar npm run inventory.");
  console.log(`Inventario válido: ${unique.size} rutas, ${OGID_OPERATIONS.length} operaciones.`);
} else { writeFileSync(target, output); console.log(`Inventario generado: ${unique.size} rutas, ${OGID_OPERATIONS.length} operaciones.`); }
