"use client";

import { Component, type ReactNode } from "react";

/**
 * Catches uncaught render errors in the client tree. Next has its own
 * error.tsx per-route convention; this is the catch-all wrapping the
 * whole app in case something throws above the route boundary (e.g.
 * inside a provider).
 *
 * No Sentry yet (per Module 1a scope). When Sentry's frontend SDK
 * lands, capture the error in componentDidCatch.
 */

interface State {
  hasError: boolean;
  message?: string;
}

interface Props {
  children: ReactNode;
}

export class RootErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  override componentDidCatch(error: unknown) {
    console.error("[RootErrorBoundary]", error);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
          <h1 className="mb-2 text-xl font-semibold text-status-error-700">Something went wrong</h1>
          <p className="text-sm text-neutral-700">
            We hit an unexpected error. Refresh the page; if it keeps happening, tell engineering.
          </p>
          {this.state.message && (
            <pre className="mt-4 overflow-auto rounded bg-neutral-100 p-2 font-mono text-xs text-neutral-800">
              {this.state.message}
            </pre>
          )}
        </main>
      );
    }
    return this.props.children;
  }
}
