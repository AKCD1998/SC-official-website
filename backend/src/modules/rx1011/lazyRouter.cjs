const path = require("path");
const { pathToFileURL } = require("url");

const moduleUrl = pathToFileURL(path.join(__dirname, "index.js")).href;
let routerPromise;

function loadRouter() {
  if (!routerPromise) {
    routerPromise = import(moduleUrl).then((module) => {
      const createRouter = module.createRx1011Router || module.default;
      return createRouter();
    });
  }
  return routerPromise;
}

module.exports = async function rx1011LazyRouter(req, res, next) {
  try {
    const router = await loadRouter();
    return router(req, res, next);
  } catch (error) {
    return next(error);
  }
};
