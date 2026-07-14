import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n } from '../app/i18n.js';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

function ErrorFallback() {
  const { t } = useI18n();
  return (
    <main className="session-state">
      <section className="session-state__panel" aria-labelledby="gateway-error-title">
        <div className="gateway-mark" aria-hidden="true">G</div>
        <h1 id="gateway-error-title">Gateway</h1>
        <p role="status">{t('Unavailable')}</p>
        <button type="button" disabled>{t('Session recovery failed')}</button>
      </section>
    </main>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The shell stays non-sensitive; server diagnostics remain in the Gateway process.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <ErrorFallback />;
    }
    return this.props.children;
  }
}
