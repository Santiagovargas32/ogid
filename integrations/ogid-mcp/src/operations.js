import * as z from "zod/v4";
import { OGID_OPERATIONS, OPERATIONS_VERSION, getOperation, operationPath, validIsoDate } from "../../../backend/contracts/ogidOperations.js";
import { projectOperation } from "../../../backend/utils/researchProjection.js";
import { ReadError } from "./client.js";
import { VERSION } from "./config.js";

export function zodSchema(def) {
  if (def.type === "object") return z.strictObject(Object.fromEntries(Object.entries(def.properties).map(([name, value]) => [name, (def.required || []).includes(name) ? zodSchema(value) : zodSchema(value).optional()])));
  if (def.type === "array") return z.array(zodSchema(def.items)).min(def.minItems || 0).max(def.maxItems).refine(value => !def.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length, "Valores duplicados.");
  if (def.type === "boolean") return z.boolean();
  if (def.type === "integer" || def.type === "number") { let schema = def.type === "integer" ? z.number().int() : z.number(); if (def.minimum !== undefined) schema = schema.min(def.minimum); if (def.maximum !== undefined) schema = schema.max(def.maximum); return def.enum ? schema.refine(value => def.enum.includes(value), "Valor no permitido.") : schema; }
  if (def.enum) return z.enum(def.enum);
  let schema = z.string().min(def.minLength || 0).max(def.maxLength || 10000);
  if (def.pattern) schema = schema.regex(new RegExp(def.pattern));
  return def.format === "date-time" ? schema.refine(validIsoDate, "Fecha ISO con zona inválida.") : schema;
}
const clean = values => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
export async function callOperation(read, operation, params = {}, body, pathParams) {
  return read.operation ? read.operation(operation.id, params, body, pathParams) : read(operationPath(operation, pathParams), { ...params, ...operation.fixed }, body);
}
export async function authorizeInstruments(config, read, references) {
  if (!references?.length) return;
  if (config.instrumentAuth !== "runtime") {
    if (references.some(id => !config.instrumentIds.includes(id))) throw new ReadError("UNVERIFIED_INSTRUMENT", "Referencia fuera de la lista autorizada; resolver identidad y configurar el modo runtime o una lista explícita.");
    return;
  }
  const data = await callOperation(read, getOperation("instruments.resolve"), { references });
  if (!Array.isArray(data.resolutions) || data.resolutions.length !== references.length || data.resolutions.some(row => row.status !== "resolved")) throw new ReadError("UNRESOLVED_INSTRUMENT", "Referencia no verificada o ambigua en el runtime OGID.");
}
function describe(operation) {
  return { operationId: operation.id, method: operation.method, route: operation.path, parameters: operation.parameters, body: operation.body, pathParameters: operation.pathParameters || null,
    permission: operation.scope, effects: operation.effects, cost: operation.cost, projection: operation.projection, retention: operation.retention, tool: operation.tool };
}
export function extendedToolDefinitions(config, read) {
  const research = OGID_OPERATIONS.filter(operation => operation.profile === "research");
  const operator = OGID_OPERATIONS.filter(operation => operation.profile === "operator" && config.operatorCredential?.scopes.includes(operation.scope));
  const operatorBodies = operator.filter(operation => operation.body).map(operation => zodSchema(operation.body).describe(operation.id));
  async function execute(operation, params, body, pathParams) {
    const values = clean(zodSchema(operation.parameters).parse(params));
    if (values.from && values.to && Date.parse(values.from) > Date.parse(values.to)) throw new ReadError("INVALID_WINDOW", "from debe ser anterior o igual a to.");
    if (operation.profile === "research" && operation.id !== "instruments.resolve") await authorizeInstruments(config, read, [...(values.instrumentIds || []), ...(values.symbols || []), ...(values.tickers || []), ...(values.instrumentId ? [values.instrumentId] : []), ...(values.benchmarkInstrumentId ? [values.benchmarkInstrumentId] : [])]);
    if (operation.id === "news.search") values.maxBytes = Math.min(values.maxBytes || config.maxOutputBytes, config.maxOutputBytes);
    const raw = await callOperation(read, operation, values, body, pathParams);
    return { data: projectOperation(operation, raw), warnings: [...(raw.warnings || []), ...(operation.profile === "operator" ? ["Operación del perfil operador autorizada por credencial local; no utilizar en tareas de investigación."] : []), ...(operation.projection === "admin-counts" ? ["Solo métricas administrativas: los cuerpos internos se omiten."] : [])] };
  }
  const tools = [
    { name: "ogid_get_capabilities", description: "Descubre versión, cobertura, permisos y contratos de las operaciones OGID disponibles. No acredita la identidad del proceso por el commit del checkout.", schema: z.strictObject({}), async run() {
      const runtime = await callOperation(read, getOperation("capabilities"));
      return { data: { adapterVersion: VERSION, contractVersion: OPERATIONS_VERSION, profile: config.profile, instrumentAuthorization: config.instrumentAuth, checkoutCommit: config.commit, runningCommitVerified: false,
        operations: [...research, ...(config.profile === "operator" ? operator : [])].map(describe), runtime: { contractVersion: runtime.contractVersion, generatedAt: runtime.generatedAt, newsCoverage: runtime.newsCoverage } }, warnings: ["Datos disponibles y cuota no equivalen a cobertura completa o hechos corroborados."] };
    } },
    { name: "ogid_search_news", description: "Busca todo el archivo autorizado anterior al recorte editorial, por país, empresa verificada, texto, temas y fechas. País omitido incluye noticias corporativas sin país. Recorre nextCursor de la misma revisión; conservar cobertura parcial y fechas desconocidas.", schema: zodSchema(getOperation("news.search").parameters), run: args => execute(getOperation("news.search"), args) },
    { name: "ogid_get_news_item", description: "Lee metadata y extracto permitido de un artículo por ID del archivo. No devuelve texto completo ni reconstruye noticias fuera de retención.", schema: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }), run: ({ id }) => execute(getOperation("news.item"), {}, undefined, { id }) },
    { name: "ogid_resolve_instruments", description: "Resuelve símbolos, nombres o IDs contra identidades verificadas del runtime, incluso sin watchlist. Devuelve alternativas para ASML, Alphabet y clases ETF ambiguas; nunca elige mercado/clase ni consulta proveedores.", schema: zodSchema(getOperation("instruments.resolve").parameters), run: args => execute(getOperation("instruments.resolve"), args) },
    { name: "ogid_get_portfolio_context", description: "Reúne contexto complementario OGID para agenda, resumen diario, candidatos materiales o revisión semanal. Usa datos almacenados, identifica cobertura parcial y no marca alertas entregadas. Confirmar hechos con fuentes externas; no inventar pesos/posiciones ni causalidad.", schema: zodSchema(getOperation("portfolio.context").parameters), run: args => execute(getOperation("portfolio.context"), args) },
    { name: "ogid_query", description: "Consulta operaciones de lectura enumeradas: watchlist, precios, velas, indicadores, condiciones, impactos, analítica, inteligencia, mapas, medios y diagnóstico seguro. Parámetros según operationId; stored impide consumo de proveedores. Descubrir contratos con ogid_get_capabilities.",
      schema: z.strictObject({ operationId: z.enum(research.filter(op => op.tool === "ogid_query").map(op => op.id)), parameters: z.union(research.filter(op => op.tool === "ogid_query").map(op => zodSchema(op.parameters).describe(op.id))).default({}), pathParameters: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).optional() }),
      async run({ operationId, parameters, pathParameters }) {
        const operation = getOperation(operationId);
        if (operation.pathParameters) zodSchema(operation.pathParameters).parse(pathParameters); else if (pathParameters) throw new ReadError("INVALID_ARGUMENTS", "Esta operación no admite parámetros de ruta.");
        return execute(operation, parameters, undefined, pathParameters);
      } }
  ];
  if (config.profile === "operator" && operator.length) tools.push({ name: "ogid_operator", description: "OPERADOR: operaciones administrativas, proveedor y mutaciones enumeradas. Requiere credencial local de alcance, verificada también por el backend. No usar en tareas de cartera; los cuerpos internos se proyectan como métricas.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    schema: z.strictObject({ operationId: z.enum(operator.map(op => op.id)), parameters: z.union(operator.map(op => zodSchema(op.parameters).describe(op.id))).default({}), body: (operatorBodies.length ? z.union(operatorBodies) : z.strictObject({})).optional(), pathParameters: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).optional() }),
    async run({ operationId, parameters, body, pathParameters }) {
      const operation = getOperation(operationId);
      if (!operator.includes(operation)) throw new ReadError("FORBIDDEN_REQUEST", "Operación no autorizada.");
      if (operation.body) body = zodSchema(operation.body).parse(body || {}); else if (body) throw new ReadError("INVALID_ARGUMENTS", "Esta operación no admite cuerpo.");
      if (operation.pathParameters) zodSchema(operation.pathParameters).parse(pathParameters); else if (pathParameters) throw new ReadError("INVALID_ARGUMENTS", "Esta operación no admite parámetros de ruta.");
      return execute(operation, parameters, body, pathParameters);
    } });
  return tools;
}
