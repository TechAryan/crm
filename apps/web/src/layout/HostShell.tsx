import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useHostAuth } from '../HostAuthContext';

export default function HostShell() {
  const { hostUser, logout } = useHostAuth();
  const nav = useNavigate();
  function doLogout() { logout(); nav('/host/login'); }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="dot" />NexCRM Admin</div>
        <div className="nav-group">
          <div className="nav-group-label">Control Plane</div>
          <NavLink to="/host/tenants" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Tenants</NavLink>
          <NavLink to="/host/plans" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Plans</NavLink>
          <NavLink to="/host/partners" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>Partners</NavLink>
        </div>
        <div style={{ marginTop: 'auto' }}>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={doLogout}>Log out</button>
        </div>
      </aside>
      <div className="main-col">
        <div className="topbar">
          <div className="topbar-title">Host Admin</div>
          <div className="topbar-right">{hostUser?.name} · {hostUser?.role}</div>
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}
