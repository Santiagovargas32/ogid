import { AppError } from "../utils/error.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function toBool(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export async function getMediaStreams(req, res, next) {
  try {
    const mediaStreamService = res.app.locals.mediaStreamService;
    if (!mediaStreamService) {
      res.status(503).json({
        ok: false,
        error: {
          code: "MEDIA_STREAMS_UNAVAILABLE",
          message: "Media stream service is unavailable."
        }
      });
      return;
    }

    const data = await mediaStreamService.getSnapshot({
      force: toBool(req.query.force),
      resolve: req.query.resolve || "critical",
      ids: req.query.ids || []
    });
    res.json(mapResponse(data));
  } catch (error) {
    next(error);
  }
}

export async function getMediaStreamById(req, res, next) {
  try {
    const mediaStreamService = res.app.locals.mediaStreamService;
    if (!mediaStreamService) {
      throw new AppError("Media stream service is unavailable.", 503, "MEDIA_STREAMS_UNAVAILABLE");
    }

    const stream = await mediaStreamService.getStreamById(req.params.id, {
      force: toBool(req.query.force),
      resolve: req.query.resolve || "visible"
    });
    if (!stream) {
      throw new AppError("Media stream not found.", 404, "MEDIA_STREAM_NOT_FOUND", {
        id: req.params.id
      });
    }
    res.json(mapResponse(stream));
  } catch (error) {
    next(error);
  }
}

export async function refreshMediaStreams(req, res, next) {
  try {
    const mediaStreamService = res.app.locals.mediaStreamService;
    if (!mediaStreamService) {
      throw new AppError("Media stream service is unavailable.", 503, "MEDIA_STREAMS_UNAVAILABLE");
    }

    const data = await mediaStreamService.refreshStreams({
      ids: Array.isArray(req.body?.ids) ? req.body.ids : [],
      force: toBool(req.body?.force)
    });
    res.json(mapResponse(data));
  } catch (error) {
    next(error);
  }
}

export async function getMediaStreamsHealth(req, res, next) {
  try {
    const mediaStreamService = res.app.locals.mediaStreamService;
    if (!mediaStreamService) {
      throw new AppError("Media stream service is unavailable.", 503, "MEDIA_STREAMS_UNAVAILABLE");
    }

    res.json(mapResponse(mediaStreamService.getHealth()));
  } catch (error) {
    next(error);
  }
}
