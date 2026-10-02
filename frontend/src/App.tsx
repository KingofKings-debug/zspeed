import { useState, useCallback, useEffect } from "react";
import Overview from "./components/Overview";
import VehicleList from "./components/VehicleList";
import ImportFlow from "./components/ImportFlow";
import OemConnections from "./components/OemConnections";
import ConnectionWizard from "./components/ConnectionWizard";
import RequestIntegration from "./components/RequestIntegration";
import Pipeline from "./components/Pipeline";
import DataIssues from "./components/DataIssues";
import VehicleDetail from "./components/VehicleDetail";
import BackendJobs from './components/BackendJobs';
import LoginScreen from "./components/LoginScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import { useConnectionStatus, vehicleStore } from "./store/vehicleStore";
import { getSession, subscribeSession, logout, type SessionState } from "./session";
import { setAuthenticatedFleet, disconnectFleetSocket } from "./socket";

type View = "overview" | "vehicles" | "connections" | "pipeline" | "issues" | "vehicle-detail" | "jobs";

export default function App() {
  const [session, setSession] = useState<SessionState | null>(() => getSession());
  const [sessionExpired, setSessionExpired] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [showImport, setShowImport] = useState(false);
  const [wizardOemId, setWizardOemId] = useState<string | null>(null);
  const [wizardOemName, setWizardOemName] = useState<string>("");
  const [showRequest, setShowRequest] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const connectionStatus = useConnectionStatus();

  useEffect(() => {
    return subscribeSession((state) => {
      if (!state) {
        if (session) {
          setSessionExpired(true);
        }
        setSession(null);
        vehicleStore.reset();
        disconnectFleetSocket();
      } else {
        setSession(state);
        setSessionExpired(false);
        setAuthenticatedFleet(state.fleetId);
      }
    });
  }, [session]);

  useEffect(() => {
    if (session) {
      setAuthenticatedFleet(session.fleetId);
    }
  }, []);

  function handleAuthenticated() {
    const s = getSession();
    setSession(s);
    setSessionExpired(false);
    if (s) {
      setAuthenticatedFleet(s.fleetId);
    }
  }

  function handleLogout() {
    logout();
    vehicleStore.reset();
    disconnectFleetSocket();
    setSession(null);
    setSessionExpired(false);
    setView("overview");
    setRefreshKey(0);
  }

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

  if (!session || sessionExpired) {
    return (
      <ErrorBoundary>
        <div>
          {sessionExpired && (
            <div
              className="alert alert-error"
              style={{ borderRadius: 0, margin: 0, textAlign: "center", fontSize: 13 }}
            >
              Your session has expired. Please sign in again.
            </div>
          )}
          <LoginScreen onAuthenticated={handleAuthenticated} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="app-layout">
        <header className="app-header">
          <div className="app-header-brand">
            ZSpeed <span>Fleet Operations</span>
          </div>
          <div className="header-status-indicator" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginLeft: 16 }}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor:
                  connectionStatus === "connected"
                    ? "var(--color-success, #2a9d8f)"
                    : connectionStatus === "reconnecting"
                    ? "var(--color-warning, #e76f51)"
                    : "var(--color-error, #e63946)",
              }}
            />
            <span style={{ color: "var(--color-text-secondary, #6c757d)", textTransform: "capitalize" }}>
              {connectionStatus === "connected" ? "Live Stream" : connectionStatus}
            </span>
            {session.demo && (
              <span style={{ color: "var(--color-text-secondary)", fontSize: 11, marginLeft: 8 }}>[demo]</span>
            )}
          </div>
          <nav className="app-nav">
            <button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
              Overview
            </button>
            <button
              className={view === "vehicles" || view === "vehicle-detail" ? "active" : ""}
              onClick={() => setView("vehicles")}
            >
              Vehicles
            </button>
            <button className={view === "connections" ? "active" : ""} onClick={() => setView("connections")}>
              Connections
            </button>
            <button className={view === "issues" ? "active" : ""} onClick={() => setView("issues")}>
              Data Issues
            </button>
            <button className={view === "pipeline" ? "active" : ""} onClick={() => setView("pipeline")}>
              Data Pipeline
            </button>
            <button className={view==='jobs'?'active':''} onClick={()=>setView('jobs')}>Background Jobs</button>
            <button className="btn btn-ghost btn-sm" onClick={handleLogout} style={{ marginLeft: "auto" }}>
              Sign out
            </button>
          </nav>
        </header>

        <main className="app-main">
          {view === "overview" && (
            <Overview key={refreshKey} onNavigate={(v) => setView(v as View)} onImport={() => setShowImport(true)} />
          )}

          {view === "vehicles" && (
            <VehicleList
              key={refreshKey}
              onImport={() => setShowImport(true)}
              onSelectVehicle={openVehicle}
            />
          )}

          {view === "vehicle-detail" && selectedVehicleId && (
            <VehicleDetail vehicleId={selectedVehicleId} onBack={() => setView("vehicles")} />
          )}

          {view === "connections" && (
            <OemConnections
              key={refreshKey}
              onConnect={openWizard}
              onRequestIntegration={() => setShowRequest(true)}
              onRefresh={refresh}
            />
          )}

          {view === "issues" && <DataIssues key={refreshKey} onViewVehicle={openVehicle} onConnections={() => setView("connections")} />}

          {view === "pipeline" && <Pipeline key={refreshKey} onConnections={() => setView("connections")} />}
          {view === 'jobs' && <BackendJobs />}

          {showImport && (
            <ImportFlow
              onClose={() => {
                setShowImport(false);
                refresh();
              }}
            />
          )}

          {wizardOemId && (
            <ConnectionWizard oemId={wizardOemId} oemName={wizardOemName} onClose={closeWizard} />
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
    </ErrorBoundary>
  );
}
