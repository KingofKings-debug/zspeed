import { useState, useCallback } from "react";
import Overview from "./components/Overview";
import VehicleList from "./components/VehicleList";
import ImportFlow from "./components/ImportFlow";
import OemConnections from "./components/OemConnections";
import ConnectionWizard from "./components/ConnectionWizard";
import RequestIntegration from "./components/RequestIntegration";
import Pipeline from "./components/Pipeline";
import DataIssues from "./components/DataIssues";
import VehicleDetail from "./components/VehicleDetail";

type View = "overview" | "vehicles" | "connections" | "pipeline" | "issues" | "vehicle-detail";

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [showImport, setShowImport] = useState(false);
  const [wizardOemId, setWizardOemId] = useState<string | null>(null);
  const [wizardOemName, setWizardOemName] = useState<string>("");
  const [showRequest, setShowRequest] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const openWizard = useCallback((oemId: string, oemName: string) => {
    setWizardOemId(oemId);
    setWizardOemName(oemName);
  }, []);

  const closeWizard = useCallback(() => {
    setWizardOemId(null);
    setWizardOemName("");
    refresh();
  }, [refresh]);

  const openVehicle = useCallback((vehicleId: string) => {
    setSelectedVehicleId(vehicleId);
    setView("vehicle-detail");
  }, []);

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header-brand">
          ZSpeed <span>Fleet Operations</span>
        </div>
        <nav className="app-nav">
          <button
            className={view === "overview" ? "active" : ""}
            onClick={() => setView("overview")}
          >
            Overview
          </button>
          <button
            className={view === "vehicles" || view === "vehicle-detail" ? "active" : ""}
            onClick={() => setView("vehicles")}
          >
            Vehicles
          </button>
          <button
            className={view === "connections" ? "active" : ""}
            onClick={() => setView("connections")}
          >
            Connections
          </button>
          <button
            className={view === "issues" ? "active" : ""}
            onClick={() => setView("issues")}
          >
            Data Issues
          </button>
          <button
            className={view === "pipeline" ? "active" : ""}
            onClick={() => setView("pipeline")}
          >
            Data Pipeline
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === "overview" && (
          <Overview
            key={refreshKey}
            onNavigate={(v) => setView(v as View)}
            onImport={() => setShowImport(true)}
          />
        )}

        {view === "vehicles" && (
          <VehicleList
            key={refreshKey}
            onImport={() => setShowImport(true)}
            onSelectVehicle={openVehicle}
          />
        )}

        {view === "vehicle-detail" && selectedVehicleId && (
          <VehicleDetail
            vehicleId={selectedVehicleId}
            onBack={() => setView("vehicles")}
          />
        )}

        {view === "connections" && (
          <OemConnections
            key={refreshKey}
            onConnect={openWizard}
            onRequestIntegration={() => setShowRequest(true)}
            onRefresh={refresh}
          />
        )}

        {view === "issues" && (
          <DataIssues
            key={refreshKey}
            onViewVehicle={openVehicle}
          />
        )}

        {view === "pipeline" && (
          <Pipeline key={refreshKey} />
        )}

        {showImport && (
          <ImportFlow
            onClose={() => {
              setShowImport(false);
              refresh();
            }}
          />
        )}

        {wizardOemId && (
          <ConnectionWizard
            oemId={wizardOemId}
            oemName={wizardOemName}
            onClose={closeWizard}
          />
        )}

        {showRequest && (
          <RequestIntegration
            onClose={() => {
              setShowRequest(false);
              refresh();
            }}
          />
        )}
      </main>
    </div>
  );
}
