import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { hasSetting, useAuth } from '../../AuthContext';

/** LSQ-style Settings area: its own left nav grouped by domain, rendered inside the main shell. */
export default function SettingsLayout() {
  const { me } = useAuth();
  const canFields = hasSetting(me, 'manageFields');
  const canRoles = hasSetting(me, 'manageRoles');
  const canDist = hasSetting(me, 'manageDistribution');
  const canConn = hasSetting(me, 'manageConnectors');
  const canWh = hasSetting(me, 'manageWebhooks');
  const canAuto = hasSetting(me, 'manageAutomation');

  const link = (to: string, label: string) => (
    <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>{label}</NavLink>
  );

  return (
    <div className="settings-layout" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <div className="card settings-nav" style={{ width: 230, flexShrink: 0, padding: '10px 8px' }}>
        <div className="nav-group">
          <div className="nav-group-label">Personal</div>
          {link('/settings/profile', 'My Profile')}
        </div>
        {canRoles && (
          <div className="nav-group">
            <div className="nav-group-label">Users & Permissions</div>
            {link('/settings/users', 'Users')}
            {link('/settings/roles', 'Roles')}
            {link('/settings/permission-sets', 'Permission Sets')}
            {link('/settings/user-fields', 'User Fields')}
          </div>
        )}
        {canFields && (
          <div className="nav-group">
            <div className="nav-group-label">Leads</div>
            {link('/settings/lead-fields', 'Lead Fields')}
            {link('/settings/lead-properties', 'Lead Properties')}
            {link('/settings/stages', 'Stages & Sources')}
            {link('/settings/activity-types', 'Custom Activities')}
            {link('/settings/forms', 'Custom Forms')}
          </div>
        )}
        {canFields && (
          <div className="nav-group">
            <div className="nav-group-label">Opportunities</div>
            {link('/settings/opportunity-types', 'Opportunity Types')}
          </div>
        )}
        {(canDist || canConn || canWh || canRoles || canAuto) && (
          <div className="nav-group">
            <div className="nav-group-label">Platform</div>
            {canDist && link('/settings/distribution', 'Lead Distribution')}
            {canRoles && link('/settings/organization', 'Organization')}
            {(canAuto || canRoles) && link('/settings/automation', 'Automation')}
            {canRoles && link('/settings/custom-actions', 'Custom Actions')}
            {canConn && link('/settings/connectors', 'Connectors')}
            {canWh && link('/settings/webhooks', 'Webhooks & API')}
            {canRoles && link('/settings/branding', 'Branding')}
            {canRoles && link('/settings/audit', 'Audit Log')}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}><Outlet /></div>
    </div>
  );
}
