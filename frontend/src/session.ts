export interface SessionState {
  token: string;
  fleetId: string;
  role: string;
  demo: boolean;
}

export interface AuthConfig {
  demoMode: boolean;
  backendAvailable: boolean;
  error?: string;
}

const SESSION_KEY = "zspeed_session";

type SessionListener = (state: SessionState | null) => void;
const listeners = new Set<SessionListener>();

let current: SessionState | null = (() => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionState) : null;
  } catch {
    return null;
  }
})();

export function getApiBase(): string {
  const envUrl = (import.meta as any).env?.VITE_API_URL || (import.meta as any).env?.VITE_API_BASE_URL;
  if (envUrl && typeof envUrl === "string") {
    const base = envUrl.replace(/\/+$/, "");
    return base.endsWith("/api") ? base : `${base}/api`;
  }
  return "/api";
}

export function getSession(): SessionState | null {
  return current;
}

export function getToken(): string | undefined {
  return current?.token;
}

export function setSession(state: SessionState): void {
  current = state;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch {}
  listeners.forEach((l) => l(state));
}

export function clearSession(): void {
  current = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  listeners.forEach((l) => l(null));
}

export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const base = getApiBase();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${base}/auth/config`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        demoMode: true,
        backendAvailable: false,
        error: `Platform backend returned status ${res.status}`,
      };
    }
    const data = await res.json();
    return {
      demoMode: Boolean(data.demoMode),
      backendAvailable: true,
    };
  } catch (err: any) {
    const isTimeout = err?.name === "AbortError";
    return {
      demoMode: true,
      backendAvailable: false,
      error: isTimeout
        ? "Platform backend connection timed out (port 3001 unavailable)"
        : "Platform backend unavailable. Ensure the backend is running on port 3001.",
    };
  }
}

export async function loginWithCredentials(username: string, password: string): Promise<SessionState> {
  const base = getApiBase();
  let res: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    res = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch {
    throw new Error("Unable to reach platform backend on port 3001.");
  }
  const data = await res.json().catch(() => ({ message: res.statusText }));
  if (!res.ok) {
    throw new Error(data.message || `Login failed: ${res.status}`);
  }
  const state: SessionState = {
    token: data.token,
    fleetId: data.fleetId,
    role: data.role,
    demo: false,
  };
  setSession(state);
  return state;
}

export async function loginAsDemo(fleetId?: string): Promise<SessionState> {
  const base = getApiBase();
  const body: Record<string, string> = {};
  if (fleetId) body.fleetId = fleetId;
  let res: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    res = await fetch(`${base}/auth/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch {
    throw new Error("Unable to reach platform backend on port 3001.");
  }
  const data = await res.json().catch(() => ({ message: res.statusText }));
  if (!res.ok) {
    throw new Error(data.message || `Demo login failed: ${res.status}`);
  }
  const state: SessionState = {
    token: data.token,
    fleetId: data.fleetId,
    role: data.role,
    demo: true,
  };
  setSession(state);
  return state;
}

export function logout(): void {
  clearSession();
}
