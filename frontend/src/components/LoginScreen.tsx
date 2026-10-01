import { useState, useEffect, useCallback } from "react";
import { loginWithCredentials, loginAsDemo, fetchAuthConfig } from "../session";

interface Props {
  onAuthenticated: () => void;
}

export default function LoginScreen({ onAuthenticated }: Props) {
  const [demoMode, setDemoMode] = useState<boolean>(true);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);
  const [backendError, setBackendError] = useState<string>("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  const checkConfig = useCallback((silent = false) => {
    if (!silent) {
      setConfigLoading(true);
    } else {
      setRetrying(true);
    }
    setError("");
    fetchAuthConfig()
      .then((cfg) => {
        setDemoMode(cfg.demoMode);
        setBackendAvailable(cfg.backendAvailable);
        if (!cfg.backendAvailable) {
          setBackendError(cfg.error || "Platform backend unavailable on port 3001.");
        } else {
          setBackendError("");
        }
      })
      .catch((err) => {
        setBackendAvailable(false);
        setBackendError(err.message || "Failed to reach platform backend.");
      })
      .finally(() => {
        setConfigLoading(false);
        setRetrying(false);
      });
  }, []);

  useEffect(() => {
    checkConfig(false);
  }, [checkConfig]);

  useEffect(() => {
    if (backendAvailable === false) {
      const interval = setInterval(() => {
        checkConfig(true);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [backendAvailable, checkConfig]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("Username and password are required.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await loginWithCredentials(username.trim(), password.trim());
      onAuthenticated();
    } catch (err: any) {
      setError(err.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDemo() {
    setLoading(true);
    setError("");
    try {
      await loginAsDemo();
      onAuthenticated();
    } catch (err: any) {
      setError(err.message || "Demo login failed.");
    } finally {
      setLoading(false);
    }
  }

  if (configLoading) {
    return (
      <div className="loading-state" style={{ minHeight: "100vh" }}>
        <div className="spinner spinner-lg" />
        Connecting to platform…
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg-secondary)",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 420, padding: 0 }}>
        <div className="card-header" style={{ textAlign: "center", padding: "24px 24px 0" }}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>ZSpeed Fleet Operations</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            {backendAvailable === false
              ? "Platform backend connection required"
              : demoMode
              ? "Sign in or continue in demo mode"
              : "Sign in to access your fleet"}
          </div>
        </div>

        <div className="card-body">
          {backendAvailable === false && (
            <div className="alert alert-error" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Backend Unavailable</div>
              <div style={{ fontSize: 12, marginBottom: 8 }}>{backendError}</div>
              <div
                style={{
                  fontSize: 11,
                  background: "rgba(0, 0, 0, 0.25)",
                  padding: "6px 8px",
                  borderRadius: 4,
                  fontFamily: "monospace",
                  marginBottom: 10,
                  wordBreak: "break-all",
                }}
              >
                cd backend &amp;&amp; npm run dev
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <span className="spinner" style={{ width: 10, height: 10 }} />
                <span>Checking port 3001 automatically...</span>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => checkConfig(false)}
                disabled={retrying}
                style={{ width: "100%" }}
              >
                {retrying ? "Checking..." : "Retry Connection"}
              </button>
            </div>
          )}

          {error && (
            <div className="alert alert-error" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          {backendAvailable !== false && !demoMode && (
            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label className="form-label" htmlFor="login-username">
                  Username
                </label>
                <input
                  id="login-username"
                  className="input-field"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                  placeholder="fleet-manager"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="login-password">
                  Password
                </label>
                <input
                  id="login-password"
                  className="input-field"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  placeholder="••••••••"
                />
              </div>
              <button className="btn btn-primary" style={{ width: "100%" }} type="submit" disabled={loading}>
                {loading ? <span className="spinner" /> : null}
                Sign in
              </button>
            </form>
          )}

          {backendAvailable !== false && demoMode && (
            <div style={{ textAlign: "center" }}>
              <p style={{ marginBottom: 20, fontSize: 13, color: "var(--color-text-secondary)" }}>
                Demo mode is active. No credentials required.
              </p>
              <button
                className="btn btn-primary"
                style={{ width: "100%" }}
                onClick={handleDemo}
                disabled={loading}
                id="demo-login-btn"
              >
                {loading ? <span className="spinner" /> : null}
                Enter Fleet Dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
