import { QueryClientProvider } from '@tanstack/react-query';
import { Activity, LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  clearCsrf,
  exchangeBootstrapCode,
  GatewayHttpError,
  loadWebUiAuthMode,
  logoutAdminSession,
  rotateCsrf,
  storeCsrf,
} from '../api/client.js';
import type { WebUiAuthMode } from '../api/types.js';
import { ErrorBoundary } from '../components/error-boundary.js';
import { OverviewPage } from '../pages/overview.js';
import { RunsPage } from '../pages/runs.js';
import { TargetsPage } from '../pages/targets.js';
import { CliAvailabilityPage } from '../pages/cli-availability.js';
import { ExtensionsPage } from '../pages/extensions.js';
import { ClientsPage } from '../pages/clients.js';
import { CoreSessionDetailPage } from '../pages/core-session-detail.js';
import { CoreSessionsPage } from '../pages/core-sessions.js';
import { CoreChoicesPage } from '../pages/core-choices.js';
import { SettingsPage } from '../pages/settings.js';
import { SetupPage } from '../pages/setup.js';
import { queryClient } from './query-client.js';
import { AppShell } from './shell.js';
import { LanguageProvider, useI18n } from './i18n.js';

type SessionState = 'loading' | 'authenticated' | 'locked' | 'unavailable';

function clearBrowserSession(): void {
  queryClient.clear();
  window.sessionStorage.clear();
}

function bootstrapCode(): string | undefined {
  const match = /^#\/bootstrap\/([^/]+)$/.exec(window.location.hash);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function replaceHash(hash: string): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}

function SessionStateScreen({ state }: { state: Exclude<SessionState, 'authenticated'> }) {
  const { t } = useI18n();
  const locked = state === 'locked';
  const loading = state === 'loading';
  const status = loading ? t('Recovering local session') : locked ? t('Locked') : t('Unavailable');
  const control = loading
    ? t('Checking local session')
    : locked
      ? t('Local session required')
      : t('Session recovery failed');

  return (
    <main className="session-state">
      <section className="session-state__panel" aria-labelledby="gateway-session-title">
        <div className="gateway-mark" aria-hidden="true">
          {locked ? <LockKeyhole size={18} /> : <Activity size={18} />}
        </div>
        <h1 id="gateway-session-title">Gateway</h1>
        <p role="status">{status}</p>
        <button type="button" disabled>{control}</button>
      </section>
    </main>
  );
}

type Route = '/overview' | '/runs' | '/targets' | '/extensions' | '/cli-availability' | '/clients' | `/clients/${string}` | '/core/choices' | '/core/sessions' | `/core/sessions/${string}` | '/settings' | '/setup';

function routeFromHash(): Route {
  if (window.location.hash === '#/setup') return '/setup';
  if (window.location.hash === '#/settings') return '/settings';
  const coreSessionMatch = /^#\/core\/sessions\/([^/]+)$/.exec(window.location.hash);
  if (coreSessionMatch?.[1]) return `/core/sessions/${decodeURIComponent(coreSessionMatch[1])}`;
  if (window.location.hash === '#/core/choices') return '/core/choices';
  if (window.location.hash === '#/core/sessions') return '/core/sessions';
  const clientMatch = /^#\/clients\/([^/]+)$/.exec(window.location.hash);
  if (clientMatch?.[1]) return `/clients/${decodeURIComponent(clientMatch[1])}`;
  if (window.location.hash === '#/clients') return '/clients';
  if (window.location.hash === '#/runs') return '/runs';
  if (window.location.hash === '#/targets') return '/targets';
  if (window.location.hash === '#/extensions') return '/extensions';
  if (window.location.hash === '#/cli-availability') return '/cli-availability';
  return '/overview';
}

function AuthenticatedApp({
  onLogout,
  webUiAuth,
}: {
  onLogout: () => Promise<void>;
  webUiAuth: WebUiAuthMode;
}) {
  const [route, setRoute] = useState(routeFromHash);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <AppShell activePath={route} onLogout={onLogout} webUiAuth={webUiAuth}>
      {route === '/runs' ? <RunsPage />
        : route === '/targets' ? <TargetsPage />
          : route === '/setup' ? <SetupPage />
            : route === '/settings' ? <SettingsPage onLogout={onLogout} webUiAuth={webUiAuth} />
              : route.startsWith('/core/sessions/') ? <CoreSessionDetailPage sessionId={route.slice('/core/sessions/'.length)} />
            : route === '/core/sessions' ? <CoreSessionsPage />
              : route === '/core/choices' ? <CoreChoicesPage />
                : route.startsWith('/clients') ? <ClientsPage clientId={route === '/clients' ? undefined : route.slice('/clients/'.length)} />
                  : route === '/extensions' ? <ExtensionsPage />
                    : route === '/cli-availability' ? <CliAvailabilityPage />
                      : <OverviewPage />}
    </AppShell>
  );
}

function GatewayRouter() {
  const [sessionState, setSessionState] = useState<SessionState>('loading');
  const [webUiAuth, setWebUiAuth] = useState<WebUiAuthMode>('token');

  useEffect(() => {
    let active = true;
    const recoverSession = async () => {
      try {
        const mode = await loadWebUiAuthMode();
        if (!active) return;
        setWebUiAuth(mode);
        const code = bootstrapCode();
        if (code) replaceHash('#/overview');
        if (mode === 'disabled') {
          clearCsrf();
          setSessionState('authenticated');
          return;
        }
        const session = code ? await exchangeBootstrapCode(code) : await rotateCsrf();
        if (!active) return;
        storeCsrf(session.csrf_token);
        setSessionState('authenticated');
      } catch (error) {
        if (!active) return;
        clearCsrf();
        clearBrowserSession();
        if (error instanceof GatewayHttpError && error.status === 401) {
          setSessionState('locked');
          return;
        }
        setSessionState('unavailable');
      }
    };
    void recoverSession();
    return () => { active = false; };
  }, []);

  const logout = async () => {
    let nextState: Exclude<SessionState, 'loading' | 'authenticated'> = 'locked';
    try {
      await logoutAdminSession();
    } catch (error) {
      nextState = error instanceof GatewayHttpError && error.status === 401
        ? 'locked'
        : 'unavailable';
    }
    clearBrowserSession();
    setSessionState(nextState);
  };

  return sessionState === 'authenticated'
    ? <AuthenticatedApp onLogout={logout} webUiAuth={webUiAuth} />
    : <SessionStateScreen state={sessionState} />;
}

export function GatewayRoot() {
  return (
    <LanguageProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GatewayRouter />
        </QueryClientProvider>
      </ErrorBoundary>
    </LanguageProvider>
  );
}
