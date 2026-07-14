import {
  Activity,
  Blocks,
  Bug,
  CircleHelp,
  Languages,
  Home,
  KeyRound,
  LogOut,
  Menu,
  Settings,
  SlidersHorizontal,
  TerminalSquare,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { connectCoreEvents, type CoreEventStatus } from '../api/core-events.js';
import type { WebUiAuthMode } from '../api/types.js';
import { IconButton } from '../components/button.js';
import { useFocusTrap } from '../components/focus-trap.js';
import { queryClient } from './query-client.js';
import { useI18n, type Language } from './i18n.js';

interface NavigationItem {
  label: string;
  path: string;
  icon: LucideIcon;
  disabled?: boolean;
  degraded?: boolean;
}

const navigation: NavigationItem[] = [
  { label: 'Overview', path: '/overview', icon: Home },
  { label: 'API Runs', path: '/runs', icon: Activity },
  { label: 'Invocation Targets', path: '/targets', icon: SlidersHorizontal },
  { label: 'Clients and Keys', path: '/clients', icon: KeyRound },
  { label: 'Extensions', path: '/extensions', icon: Blocks },
  { label: 'Core Sessions', path: '/core/sessions', icon: Bug },
  { label: 'Pending Core Choices', path: '/core/choices', icon: CircleHelp },
  { label: 'CLI Availability', path: '/cli-availability', icon: TerminalSquare },
  { label: 'Settings', path: '/settings', icon: Settings },
];

interface AppShellProps {
  activePath: string;
  children: ReactNode;
  onLogout(): Promise<void>;
  webUiAuth: WebUiAuthMode;
}

export function AppShell({ activePath, children, onLogout, webUiAuth }: AppShellProps) {
  const { language, setLanguage, t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth < 760);
  const [coreEventStatus, setCoreEventStatus] = useState<CoreEventStatus>('reconnecting');
  const navigationRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    const onResize = () => {
      const nextMobile = window.innerWidth < 760;
      setMobile(nextMobile);
      if (!nextMobile) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => connectCoreEvents(queryClient, setCoreEventStatus), []);

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    const workspace = workspaceRef.current;
    if (!navigation || !workspace) return;
    if (mobile && !drawerOpen) navigation.setAttribute('inert', '');
    else navigation.removeAttribute('inert');
    if (mobile && drawerOpen) workspace.setAttribute('inert', '');
    else workspace.removeAttribute('inert');
  }, [drawerOpen, mobile]);

  useFocusTrap(mobile && drawerOpen, navigationRef, closeDrawer, closeRef);

  return (
    <div className="app-shell">
      {drawerOpen ? (
        <button
          className="drawer-backdrop"
          type="button"
          aria-label={t('Dismiss navigation')}
          onClick={closeDrawer}
        />
      ) : null}
      <nav ref={navigationRef} className={`sidebar ${drawerOpen ? 'sidebar--open' : ''}`} aria-label="Gateway">
        <div className="identity">
          <span className="gateway-mark" aria-hidden="true">G</span>
          <span>Gateway</span>
          <IconButton
            className="drawer-close"
            label={t('Close navigation')}
            onClick={closeDrawer}
            ref={closeRef}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="nav-list">
          {navigation.map((item) => {
            const active = activePath === item.path
              || (item.path === '/clients' && activePath.startsWith('/clients/'))
              || (item.path === '/core/sessions' && activePath.startsWith('/core/sessions/'));
            const Icon = item.icon;
            const className = [
              'nav-item',
              active ? 'nav-item--active' : '',
              item.disabled ? 'nav-item--disabled' : '',
              item.degraded ? 'nav-item--degraded' : '',
            ].filter(Boolean).join(' ');
            return (
              <a
                key={item.path}
                className={className}
                href={`#${item.path}`}
                aria-current={active ? 'page' : undefined}
                aria-disabled={item.disabled ? 'true' : undefined}
                onClick={(event) => {
                  if (item.disabled) event.preventDefault();
                  else setDrawerOpen(false);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{t(item.label)}</span>
                {item.degraded ? <span className="nav-status-dot" aria-hidden="true" /> : null}
              </a>
            );
          })}
        </div>
      </nav>
      <div className="workspace" ref={workspaceRef}>
        <header className="topbar">
          <div className="topbar__content">
            <div className="topbar__leading">
              <IconButton
                className="menu-button"
                label={t('Open navigation')}
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen(true)}
              >
                <Menu size={17} aria-hidden="true" />
              </IconButton>
              <span className="connection-status">
                <span className="status-dot" aria-hidden="true" />
                {webUiAuth === 'token' ? t('Local admin session') : t('Web UI auth disabled')}
              </span>
              <span className={`core-event-status core-event-status--${coreEventStatus}`} aria-live="polite">
                {t('Core {status}', { status: t(coreEventStatus) })}
              </span>
            </div>
            <div className="topbar__actions">
              <label className="language-select">
                <Languages size={15} aria-hidden="true" />
                <span className="visually-hidden">{t('Language')}</span>
                <select
                  aria-label={t('Language')}
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as Language)}
                >
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
              {webUiAuth === 'token' ? (
                <IconButton label={t('End local session')} onClick={() => void onLogout()}>
                  <LogOut size={16} aria-hidden="true" />
                </IconButton>
              ) : null}
            </div>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
