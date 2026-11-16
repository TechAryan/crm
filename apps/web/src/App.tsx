import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { HostAuthProvider, useHostAuth } from './HostAuthContext';
import TenantShell from './layout/TenantShell';
import HostShell from './layout/HostShell';
import TenantLogin from './pages/TenantLogin';
import HostLogin from './pages/HostLogin';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ForcePasswordChange from './components/ForcePasswordChange';
import LeadsList from './pages/leads/LeadsList';
import LeadDetail from './pages/leads/LeadDetail';
import OpportunitiesList from './pages/opportunities/OpportunitiesList';
import OpportunityDetail from './pages/opportunities/OpportunityDetail';
import FormsSettings from './pages/settings/FormsSettings';
import TasksList from './pages/tasks/TasksList';
import Dashboard from './pages/Dashboard';
import SettingsLayout from './pages/settings/SettingsLayout';
import ProfileSettings from './pages/settings/ProfileSettings';
import UsersSettings from './pages/settings/UsersSettings';
import RolesSettings from './pages/settings/RolesSettings';
import PermissionSetsSettings from './pages/settings/PermissionSetsSettings';
import { LeadFieldsSettings, UserFieldsSettings } from './pages/settings/EntityFieldsSettings';
import StagesSourcesSettings from './pages/settings/StagesSourcesSettings';
import ActivityTypesSettings from './pages/settings/ActivityTypesSettings';
import OpportunityTypesSettings from './pages/settings/OpportunityTypesSettings';
import BrandingSettings from './pages/settings/BrandingSettings';
import AuditLogSettings from './pages/settings/AuditLogSettings';
import DistributionSettings from './pages/settings/DistributionSettings';
import OrganizationSettings from './pages/settings/OrganizationSettings';
import AutomationSettings from './pages/settings/AutomationSettings';
import CustomActionsSettings from './pages/settings/CustomActionsSettings';
import LeadPropertiesSettings from './pages/settings/LeadPropertiesSettings';
import ConnectorsSettings from './pages/settings/ConnectorsSettings';
import WebhooksApiSettings from './pages/settings/WebhooksApiSettings';
import TenantsList from './pages/host/TenantsList';
import PlansList from './pages/host/PlansList';
import PartnersList from './pages/host/PartnersList';

function TenantProtected({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <ForcePasswordChange>{children}</ForcePasswordChange>;
}

function HostProtected({ children }: { children: React.ReactNode }) {
  const { hostUser } = useHostAuth();
  if (!hostUser) return <Navigate to="/host/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <HostAuthProvider>
          <Routes>
            <Route path="/login" element={<TenantLogin />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/host/login" element={<HostLogin />} />
            {/* Target of the host forgot-password email. Without this the catch-all below sent
                admins to the tenant login and dropped their reset token. */}
            <Route path="/host/reset-password" element={<ResetPasswordPage variant="host" />} />

            <Route path="/" element={<TenantProtected><TenantShell /></TenantProtected>}>
              <Route index element={<Navigate to="/leads" replace />} />
              <Route path="leads" element={<LeadsList />} />
              <Route path="leads/:id" element={<LeadDetail />} />
              <Route path="opportunities" element={<OpportunitiesList />} />
              <Route path="opportunities/:id" element={<OpportunityDetail />} />
              <Route path="tasks" element={<TasksList />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="/settings/profile" replace />} />
                <Route path="profile" element={<ProfileSettings />} />
                <Route path="users" element={<UsersSettings />} />
                <Route path="roles" element={<RolesSettings />} />
                <Route path="permission-sets" element={<PermissionSetsSettings />} />
                <Route path="user-fields" element={<UserFieldsSettings />} />
                <Route path="lead-fields" element={<LeadFieldsSettings />} />
                <Route path="stages" element={<StagesSourcesSettings />} />
                <Route path="activity-types" element={<ActivityTypesSettings />} />
                <Route path="opportunity-types" element={<OpportunityTypesSettings />} />
                <Route path="forms" element={<FormsSettings />} />
                <Route path="branding" element={<BrandingSettings />} />
                <Route path="distribution" element={<DistributionSettings />} />
                <Route path="organization" element={<OrganizationSettings />} />
                <Route path="automation" element={<AutomationSettings />} />
                <Route path="custom-actions" element={<CustomActionsSettings />} />
                <Route path="lead-properties" element={<LeadPropertiesSettings />} />
                <Route path="connectors" element={<ConnectorsSettings />} />
                <Route path="webhooks" element={<WebhooksApiSettings />} />
                <Route path="audit" element={<AuditLogSettings />} />
              </Route>
            </Route>

            <Route path="/host" element={<HostProtected><HostShell /></HostProtected>}>
              <Route index element={<Navigate to="/host/tenants" replace />} />
              <Route path="tenants" element={<TenantsList />} />
              <Route path="plans" element={<PlansList />} />
              <Route path="partners" element={<PartnersList />} />
            </Route>

            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </HostAuthProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
