import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth, isTabHidden } from '../AuthContext';
import { ScreenPop } from '../components/ScreenPop';

export default function TenantShell() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const [branding, setBranding] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem('nx_branding') || '{}'); } catch { return {}; }
  });
  // Mobile-only: sidebar slides in/out via a hamburger toggle. On desktop widths the toggle
  // button and backdrop are hidden by CSS, so this state has no effect there.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    api.get('/v1/branding').then(d => {
      const b = d.branding || {};
      setBranding(b);
      localStorage.setItem('nx_branding', JSON.stringify(b));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (branding.primaryColor) {
      document.documentElement.style.setProperty('--primary', branding.primaryColor);
      document.documentElement.style.setProperty('--primary-hover', branding.primaryColor);
    }
  }, [branding.primaryColor]);

  function doLogout() { logout(); nav('/login'); }

  const showSettings = !isTabHidden(me, 'Settings');
  const showReports = !isTabHidden(me, 'Reports');
  const showOpps = !isTabHidden(me, 'Opportunities');
  const showTasks = !isTabHidden(me, 'Tasks');
  const appName = branding.appName || 'NexCRM';

  return (
    <div className="app-shell">
      {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`} onClick={() => setNavOpen(false)}>
        <div className="sidebar-brand">
          {branding.logoUrl ? <img src={branding.logoUrl} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover' }} /> : <span className="dot" />}
          {appName}
        </div>
        <div className="nav-group">
          <div className="nav-group-label">Sales</div>
          <NavLink to="/leads" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Leads</NavLink>
          {showOpps && <NavLink to="/opportunities" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Opportunities</NavLink>}
          {showTasks && <NavLink to="/tasks" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Tasks</NavLink>}
        </div>
        {showReports && (
          <div className="nav-group">
            <div className="nav-group-label">Insights</div>
            <NavLink to="/dashboard" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Dashboard</NavLink>
          </div>
        )}
        {showSettings && (
          <div className="nav-group">
            <div className="nav-group-label">Admin</div>
            <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Settings</NavLink>
          </div>
        )}
        <div style={{ marginTop: 'auto' }}>
          <NavLink to="/settings/profile" className="nav-link">My Profile</NavLink>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={doLogout}>Log out</button>
        </div>
      </aside>
      <div className="main-col">
        <div className="topbar">
          <button className="mobile-menu-btn" aria-label="Open menu" onClick={() => setNavOpen(o => !o)}>☰</button>
          <div className="topbar-title">Tenant: {me?.tenantCode}</div>
          <div className="topbar-right">Scope: {me?.recordScope}</div>
        </div>
        <div className="content"><Outlet /></div>
      </div>
      {/* Telephony screen-pop listener: one SSE connection for the logged-in user. */}
      <ScreenPop />
    </div>
  );
}
