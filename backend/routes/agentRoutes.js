import {catalogModel} from "../services/agent/modelCatalog.js";
import { Router } from "express";
import { isAdminAuthorized } from "../middleware/sensitiveRouteAuth.js";
import {
  publicCapabilities,
  readyModel,
  taskMode,
} from "../services/agent/config.js";
import { agentError } from "../services/agent/contracts.js";
import { tokenMatches } from "../services/agent/broker.js";
import {
  OGID_OPERATIONS,
  parseOperationQuery,
} from "../contracts/ogidOperations.js";
const router = Router();
const call = (req, method, args = {}) => req.app.locals.agentCall(method, args);
const body = (req, keys) => {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).some((k) => !keys.includes(k))
  )
    throw agentError("AGENT_INVALID_ARGUMENTS");
  return req.body;
};
function origin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && ["cross-site", "none"].includes(site) && req.headers.origin)
    throw agentError("AGENT_ORIGIN_DENIED", 403);
  if (req.headers.origin) {
    const u = new URL(req.headers.origin);
    const expected =
      req.app.locals.agentConfig.publicOrigin ||
      `${req.protocol}://${req.headers.host}`;
    if (u.origin !== expected) throw agentError("AGENT_ORIGIN_DENIED", 403);
  }
}
async function device(req, res, next) {
  try {
    const match = String(req.headers.cookie || "").match(
      /(?:^|;\s*)ogid_device=([A-Za-z0-9_-]+)/,
    );
    const d = await call(req, "deviceAuth", { token: match?.[1] || "" });
    if (!d) throw agentError("AGENT_DEVICE_REQUIRED", 401);
    req.agentDevice = d;
    if (!["GET", "HEAD"].includes(req.method)) {
      origin(req);
      if (!tokenMatches(d.csrf, req.headers["x-ogid-csrf"]))
        throw agentError("AGENT_CSRF_REQUIRED", 403);
    }
    next();
  } catch (e) {
    next(e);
  }
}
function admin(req, res, next) {
  if (!isAdminAuthorized(req, req.app.locals.config?.security))
    return next(agentError("ADMIN_AUTH_REQUIRED", 401));
  if (!["GET", "HEAD"].includes(req.method)) origin(req);
  next();
}
function available(req, res, next) {
  if (!req.app.locals.agentCall)
    return next(agentError("AGENT_STORAGE_UNAVAILABLE", 503));
  next();
}
const ownedArgs = (req) => ({
  deviceId: req.agentDevice.deviceId,
  sessionId: req.params.id,
});
router.use(
  ["/agent/v1", "/alerts/v1/geopolitical", "/admin/agent"],
  available,
  (_req, res, next) => {
    const send = res.json.bind(res);
    res.json = (value) =>
      send(value?.ok !== undefined ? value : { ok: true, data: value });
    next();
  },
);
router.use(
  ["/agent/v1", "/alerts/v1/geopolitical", "/admin/agent"],
  (req, _res, next) => {
    try {
      const fullPath = new URL(req.originalUrl, "http://local").pathname;
      const operation = OGID_OPERATIONS.find(
        (op) => op.method === req.method && op.path === fullPath,
      );
      if (operation) parseOperationQuery(req.query, operation);
      else if (req.method === "GET") {
        const allowed = fullPath.endsWith("/sessions")
          ? ["cursor", "limit"]
          : fullPath.endsWith("/messages")
            ? ["cursor", "limit", "before", "latest"]
            : fullPath.includes("/geopolitical")
              ? ["cursor", "limit", "state", "severity"]
              : [];
        if (
          Object.keys(req.query).some((k) => !allowed.includes(k)) ||
          Object.values(req.query).some((v) => typeof v !== "string") ||
          (req.query.limit !== undefined &&
            (!/^\d+$/.test(req.query.limit) ||
              Number(req.query.limit) < 1 ||
              Number(req.query.limit) > 100))
        )
          throw Error();
      }
      next();
    } catch {
      next(agentError("AGENT_INVALID_ARGUMENTS"));
    }
  },
);
router.get("/agent/v1/capabilities", async (req, res) =>
  res.json({
    ...publicCapabilities(req.app.locals.agentConfig),
    runtime: req.app.locals.agentRuntime?.status(),
    availability:
      req.app.locals.agentConfig.mode === "off"
        ? { state: "disabled" }
        : await call(req, "workerHealth").catch(() => ({
            state: "unavailable",
          })),
  }),
);
router.get("/agent/v1/models",async(req,res)=>res.json(await req.app.locals.agentModels.list({refresh:true})));
router.get("/agent/v1/brief", async (req, res) =>
  res.json(
    await call(req, "publications", {
      task: "global_intelligence_brief",
      limit: 1,
    }),
  ),
);
router.get("/agent/v1/outlooks", async (req, res) =>
  res.json(
    await call(req, "publications", {
      task: req.query.instrumentId
        ? "instrument_outlook"
        : "market_outlook_global",
      scope: req.query.instrumentId,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  ),
);
router.get("/agent/v1/geopolitical", async (req, res) =>
  res.json(
    await call(req, "publications", {
      task: "geopolitical_alert_assessment",
      limit: 1,
    }),
  ),
);
router.get("/agent/v1/evidence", async (req, res) =>
  res.json(
    await call(req, "evidence", {
      snapshotId: req.query.snapshotId,
      cursor: req.query.cursor,
      limit: req.query.limit,
      domain: req.query.domain,
    }),
  ),
);
router.get("/agent/v1/evidence/chunk", async (req, res) =>
  res.json(
    await call(req, "evidenceChunk", {
      snapshotId: req.query.snapshotId,
      evidenceId: req.query.evidenceId,
      offset: req.query.offset,
      format: req.query.format,
    }),
  ),
);
router.get("/agent/v1/clusters", async (req, res) =>
  res.json(
    await call(req, "clusters", {
      snapshotId: req.query.snapshotId,
      clusterId: req.query.clusterId,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  ),
);
router.post("/agent/v1/access/device", admin, async (req, res) => {
  const { label } = body(req, ["label"]);
  const d = await call(req, "deviceCreate", { label });
  res.cookie("ogid_device", d.token, {
    httpOnly: true,
    sameSite: "strict",
    secure:
      req.secure ||
      req.app.locals.agentConfig.publicOrigin?.startsWith("https:") === true,
    path: "/api",
    maxAge: 365 * 86400000,
  });
  res.json({ deviceId: d.deviceId, csrf: d.csrf });
});
router.get("/agent/v1/access", device, (req, res) => res.json(req.agentDevice));
router.get("/agent/v1/chat/sessions", device, async (req, res) =>
  res.json(
    await call(req, "sessions", {
      deviceId: req.agentDevice.deviceId,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  ),
);
router.post("/agent/v1/chat/sessions", device, async (req, res) => {
  const { model, title } = body(req, ["model", "title"]);
  const config = req.app.locals.agentConfig;
  if (
    taskMode(config, "contextual_chat") === "off" ||
    !catalogModel(
      config.manifest.models.find((m) => `llamacpp/${m.alias}` === model),
    )
  )
    throw agentError("AGENT_MODEL_UNVERIFIED", 409);
  res.status(201).json(
    await call(req, "sessionCreate", {
      deviceId: req.agentDevice.deviceId,
      model,
      title,
    }),
  );
});
router.get("/agent/v1/chat/sessions/:id/messages", device, async (req, res) =>
  res.json(
    await call(req, "messages", {
      ...ownedArgs(req),
      latest: req.query.latest === "1",
      before: req.query.before,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  ),
);
router.post(
  "/agent/v1/chat/sessions/:id/messages",
  device,
  async (req, res) => {
    if (taskMode(req.app.locals.agentConfig, "contextual_chat") === "off")
      throw agentError("AGENT_DISABLED", 503);
    const { text, context, key } = body(req, ["text", "context", "key"]);
    res
      .status(202)
      .json(await call(req, "send", { ...ownedArgs(req), text, context, key }));
  },
);
router.get("/agent/v1/chat/sessions/:id/events", device, async (req, res) => {
  await call(req, "sessionAccess", ownedArgs(req));
  if(req.destroyed || res.destroyed)return;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  let busy = false,
    closed = false,
    previousEvent = "";
  let timer;
  const metrics = req.app.locals.agentSse ||= {active:0,opened:0,closed:0};
  metrics.active++;metrics.opened++;
  const cleanup = () => {
    if(closed)return;
    closed=true; clearInterval(timer);metrics.active--;metrics.closed++;
  };
  const end = () => { cleanup();res.end(); };
  const send = (value) => {
    if (closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 524288 || res.writableLength > 262144) {
      end();
      return;
    }
    if (!res.write(`event: update\ndata: ${JSON.stringify(value)}\n\n`)) {
      end();
    }
  };
  const update = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      // Revocation/ownership stays live, without reading durable message JSON
      // for every tab and heartbeat. Concurrent identical reads coalesce.
      await call(req, "sessionAccess", ownedArgs(req));
      if(closed)return;
      const progress = req.app.locals.agentProgress?.get(req.params.id);
      if (progress && JSON.stringify(progress) !== previousEvent) {
        previousEvent = JSON.stringify(progress);
        send(progress);
      } else if(res.writableLength>262144 || !res.write(": heartbeat\n\n"))end();
    } catch {
      end();
    } finally {
      busy = false;
    }
  };
  timer = setInterval(update, 1000);
  timer.unref();
  req.once('close',cleanup);res.once('close',cleanup);res.once('error',cleanup);
  send({ reconcile: true });
});
router.get("/agent/v1/runs/:id", device, async (req, res) =>
  res.json(
    await call(req, "run", {
      jobId: req.params.id,
      deviceId: req.agentDevice.deviceId,
    }),
  ),
);
router.post("/agent/v1/runs/:id/cancel", device, async (req, res) => {
  body(req, []);
  res.json(
    await call(req, "cancel", {
      jobId: req.params.id,
      deviceId: req.agentDevice.deviceId,
    }),
  );
});
router.get("/alerts/v1/geopolitical", device, async (req, res) =>
  res.json(
    await call(req, "alerts", {
      deviceId: req.agentDevice.deviceId,
      state: req.query.state,
      severity: req.query.severity,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  ),
);
router.get("/alerts/v1/geopolitical/:id/revisions", device, async (req, res) =>
  res.json(
    await call(req, "alertRevisions", {
      alertId: req.params.id,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  ),
);
router.patch("/alerts/v1/geopolitical/:id/state", device, async (req, res) => {
  const {read,archived,revision,requestId}=body(req,["read","archived","revision","requestId"]);
  res.json(
    await call(req, "alertState", {
      deviceId: req.agentDevice.deviceId,
      alertId: req.params.id,
      read,
      archived,
      revision,
      requestId,
    }),
  );
});
router.get("/admin/agent", admin, async (req, res) =>
  res.json({
    ...publicCapabilities(req.app.locals.agentConfig),
    runtime: req.app.locals.agentRuntime?.status(),
    modelCatalog:req.app.locals.agentModels?.peek?.()||null,
    paused: Boolean(req.app.locals.agentPaused),
    ...(await call(req, "status", {since:req.app.locals.agentObservationSince})),
    worker: req.app.locals.agentMaintenance?.status || null,
    modelSelectionWarning:req.app.locals.agentModelWarning || null,
  }),
);
router.post("/admin/agent/model",admin,async(req,res)=>{
  const {model}=body(req,["model"]);
  if(typeof model!=="string")throw agentError("AGENT_INVALID_ARGUMENTS");
  const selected=await req.app.locals.agentModels.select(model);
  delete req.app.locals.agentModelWarning;
  res.status(selected.pending?202:200).json(selected);
});
router.post("/admin/agent/pause", admin, async (req, res) => {
  const { paused } = body(req, ["paused"]);
  if (typeof paused !== "boolean") throw agentError("AGENT_INVALID_ARGUMENTS");
  await call(req, "control", { paused });
  req.app.locals.agentPaused = paused;
  res.json({ paused });
});
router.post("/admin/agent/devices/:id/revoke", admin, async (req, res) => {
  body(req, []);
  res.json(await call(req, "deviceRevoke", { deviceId: req.params.id }));
});
const internalMethods = new Set([
  "status",
  "consume",
  "enqueue",
  "claim",
  "heartbeat",
  "state",
  "snapshot",
  "evidence",
  "evidenceChunk",
  "publish",
  "link",
  "run",
  "memory",
  "alertSync",
  "progress",
  "reconcileCandidates",
  "resume",
  "workerReport",
  "pendingCancellations",
  "cancelAcknowledged",
  "interruptClaim",
]);
router.post("/agent/v1/internal/:method", async (req, res) => {
  const token = String(req.headers.authorization || "").replace(
    /^Bearer /i,
    "",
  );
  if (!tokenMatches(req.app.locals.agentConfig.internalToken, token))
    throw agentError("AGENT_INTERNAL_UNAUTHORIZED", 401);
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress,
    ) ||
    !internalMethods.has(req.params.method)
  )
    throw agentError("AGENT_INTERNAL_FORBIDDEN", 403);
  if (
    req.app.locals.agentPaused &&
    ["claim", "consume", "enqueue"].includes(req.params.method)
  )
    return res.json(null);
  if (
    req.app.locals.agentConfig.mode === "off" &&
    ["claim", "consume", "enqueue", "publish", "snapshot"].includes(req.params.method)
  )
    throw agentError("AGENT_DISABLED", 503);
  const input = { ...(req.body || {}) };
  if (req.params.method === "progress") {
    const job = await call(req, 'progress', input);
    if (!job.sessionId || job.sessionId !== input.sessionId)
      throw agentError("AGENT_SESSION_MISMATCH");
    const text = input.done===true ? '' : typeof input.text === "string" ? input.text : "";
    if (Buffer.byteLength(text) > 524288)
      throw agentError("AGENT_EVENT_TOO_LARGE", 413);
    const progress = req.app.locals.agentProgress;
    progress.set(job.sessionId, {
      jobId: input.jobId,
      text,
      tools: input.done!==true && Array.isArray(input.tools)
        ? input.tools.map((t) => ({ name: t.name, status: t.status }))
        : [],
      done: Boolean(input.done),
    });
    if (progress.size > 128) progress.delete(progress.keys().next().value);
    return res.json({ accepted: true });
  }
  if (req.params.method === "run") input.internal = true;
  if (["consume", "claim"].includes(req.params.method)) {
    const requested=req.params.method === "claim" ? input.enabledTasks : undefined;
    if(requested!==undefined && (!Array.isArray(requested) || requested.some(task=>typeof task!=="string")))throw agentError("AGENT_INVALID_ARGUMENTS");
    input.enabledTasks = Object.keys(
      req.app.locals.agentConfig.taskModes,
    ).filter((task) => taskMode(req.app.locals.agentConfig, task) !== "off" && (requested===undefined || requested.includes(task)));
  }
  if (
    req.params.method === "enqueue" &&
    taskMode(req.app.locals.agentConfig, input.task) === "off"
  )
    throw agentError("AGENT_DISABLED", 503);
  if (req.params.method === "consume") {
    input.model = req.app.locals.agentConfig.backgroundModel;
    input.instrumentIds =
      req.app.locals.marketWatchlistService?.selectedInstrumentIds || [];
  }
  if (req.params.method === "publish") {
    const job = await call(req, "run", { jobId: input.jobId, internal: true });
    input.mode = taskMode(req.app.locals.agentConfig, job.task);
    if (input.mode === "off") throw agentError("AGENT_DISABLED", 503);
  }
  res.json(await call(req, req.params.method, input));
});
export default router;
