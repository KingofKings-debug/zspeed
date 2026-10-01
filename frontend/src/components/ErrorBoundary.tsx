import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render error caught by ErrorBoundary:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
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
          <div className="card" style={{ maxWidth: 480, width: "100%" }}>
            <div className="card-header">
              <span className="card-header-title" style={{ color: "var(--color-error)" }}>
                Something went wrong
              </span>
            </div>
            <div className="card-body">
              <p style={{ marginBottom: 16, fontSize: 13, color: "var(--color-text-secondary)" }}>
                The application encountered an unexpected error. Refresh the page to try again.
              </p>
              {this.state.error && (
                <pre
                  style={{
                    background: "var(--color-bg-tertiary)",
                    borderRadius: 6,
                    padding: "10px 14px",
                    fontSize: 11,
                    overflowX: "auto",
                    marginBottom: 16,
                    color: "var(--color-error)",
                  }}
                >
                  {this.state.error.message}
                </pre>
              )}
              <button className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
