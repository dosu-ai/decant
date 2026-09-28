import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * Without a boundary, one render error unmounts the whole app and leaves a
 * blank page. Local-only data means a reload is the right recovery.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Decant UI crashed", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div style={{ margin: "64px auto", maxWidth: 560, padding: "0 16px" }}>
        <div className="error-state" role="alert">
          <span aria-hidden="true">!</span>
          <div>
            <h3>Something went wrong</h3>
            <p>
              Decant hit an unexpected error while drawing this page. Your archive is untouched;
              reloading usually clears it.
            </p>
            <div className="state-actions">
              <button
                className="primary-button"
                onClick={() => window.location.reload()}
                type="button"
              >
                Reload Decant
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
