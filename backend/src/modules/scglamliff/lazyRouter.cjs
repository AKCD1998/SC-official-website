const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "index.js")).href;
let routerPromise;

function loadRouter() {
  if (!routerPromise) {
    routerPromise = import(moduleUrl).then((module) => {
      const createRouter = module.createScGlamLiffRouter || module.default;
      if (typeof createRouter !== "function") {
        throw new Error("scGlamLiff router factory was not found.");
      }
      return createRouter();
    });
  }

  return routerPromise;
}

module.exports = async function scGlamLiffLazyRouter(req, res, next) {
  try {
    const router = await loadRouter();
    return router(req, res, next);
  } catch (error) {
    return next(error);
  }
};
