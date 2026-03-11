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
      force: toBool(req.query.force)
    });
    res.json(mapResponse(data));
  } catch (error) {
    next(error);
  }
}

