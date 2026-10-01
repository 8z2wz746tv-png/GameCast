import { startControlServer } from "./app.js";
import { appConfig } from "./config.js";

await startControlServer(appConfig);
