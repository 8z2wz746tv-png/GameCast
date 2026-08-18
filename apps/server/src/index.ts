import { appConfig } from "./config.js";
import { startControlServer } from "./app.js";

await startControlServer(appConfig);
