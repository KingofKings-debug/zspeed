export { app, server, startSimulatorServer } from "./server.js";
export { engine } from "./engine.js";
export {
  getSimulatorDb,
  closeSimulatorDb,
  setSimulatorScenario,
  getSimulatorScenario,
  getAllSimulatorScenarios,
  recordSimulatorMetric,
  getSimulatorMetrics,
} from "./db.js";

import { startSimulatorServer } from "./server.js";

if (process.argv[1]?.includes("simulator") || process.argv[1]?.includes("index")) {
  startSimulatorServer().catch(console.error);
}
