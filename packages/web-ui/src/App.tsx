import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate, Navigate, Link } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './auth/useAuth.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';
import { ChatPage } from './features/chat/ChatPage.js';
import { AdminPage, AgentEditor } from './features/admin/AdminPage.js';
import { ManifestEditor } from './features/admin/ManifestEditor.js';
import { VisualManifestEditor } from './features/admin/VisualManifestEditor.js';
import { AuditViewer } from './features/audit/AuditViewer.js';
import { IntegrationsPage } from './pages/integrations/IntegrationsPage.js';
import { SkillsPage } from './features/skills/SkillsPage.js';
import { ApprovalsPage } from './features/approvals/ApprovalsPage.js';
import { UsersPage } from './features/users/UsersPage.js';
import { DashboardPage } from './features/dashboard/DashboardPage.js';
import { SessionsPage } from './features/sessions/SessionsPage.js';
import { DelegationPage } from './features/agents/DelegationPage.js';
import { NotificationsPage } from './features/notifications/NotificationsPage.js';
import { WebhooksPage } from './features/webhooks/WebhooksPage.js';
import { MemoryPage } from './features/memory/MemoryPage.js';
import { SecretsPage } from './features/secrets/SecretsPage.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { NavBar } from './components/NavBar.js';
import { useAuth } from './auth/useAuth.js';
import { api } from './api/client.js';

function AppLayout() {
  const { user } = useAuth();
  // Only offset content when sidebar is visible (authenticated user)
  const mainStyle = user ? { marginLeft: '14rem' } : undefined;

  return (
    <>
      <NavBar />
      <main style={mainStyle} className="min-h-screen bg-gray-50">
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<GatedRegisterPage />} />

            {/* Protected: any authenticated user */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <ChatPage />
                </ProtectedRoute>
              }
            />

            {/* Protected: admin only */}
            <Route
              path="/admin"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <AdminPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/admin/agents/:id"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <AgentEditorPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/admin/agents/:id/manifest"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <ManifestEditor />
                </ProtectedRoute>
              }
            />

            <Route
              path="/admin/agents/:id/manifest/visual"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <VisualManifestEditor />
                </ProtectedRoute>
              }
            />

            {/* Protected: auditor + admin */}
            <Route
              path="/audit"
              element={
                <ProtectedRoute allowedRoles={['auditor', 'workspace_admin']}>
                  <AuditViewer />
                </ProtectedRoute>
              }
            />

            {/* Protected: admin only */}
            <Route
              path="/skills"
              element={
                <ProtectedRoute>
                  <SkillsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/integrations"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <IntegrationsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/dashboard"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/approvals"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <ApprovalsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/users"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <UsersPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/sessions"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <SessionsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/delegation"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <DelegationPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/notifications"
              element={
                <ProtectedRoute>
                  <NotificationsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/webhooks"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <WebhooksPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/memory"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <MemoryPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/secrets"
              element={
                <ProtectedRoute allowedRoles={['workspace_admin']}>
                  <SecretsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />

            {/* 404 catch-all */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppLayout />
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * Gates the registration page — redirects to /login when self-registration
 * is disabled on the server, preventing direct URL access.
 */
function GatedRegisterPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    api.get<{ selfRegistrationEnabled: boolean }>('/auth/config')
      .then((cfg) => setAllowed(cfg.selfRegistrationEnabled))
      .catch(() => setAllowed(false));
  }, []);

  if (allowed === null) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><p className="text-sm text-gray-500">Loading...</p></div>;
  if (!allowed) return <Navigate to="/login" replace />;
  return <RegisterPage />;
}

/**
 * Standalone agent editor page wrapper that extracts route params,
 * fetches the agent data from the API, and provides it to AgentEditor.
 */
function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <AgentEditorPageInner agentId={id!} onDone={() => navigate('/admin')} />
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">404</h1>
        <p className="text-gray-600 mb-4">Page not found</p>
        <Link to="/" className="text-blue-600 hover:text-blue-800 underline">Go home</Link>
      </div>
    </div>
  );
}

function AgentEditorPageInner({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [agent, setAgent] = useState<{ id: string; name: string; model: string; status: 'active' | 'inactive' | 'archived'; workspaceId: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<{ agent: { id: string; name: string; model: string; status: string; workspaceId: string } }>(`/agents/${agentId}`);
        setAgent({
          id: data.agent.id,
          name: data.agent.name,
          model: data.agent.model,
          status: (data.agent.status as 'active' | 'inactive' | 'archived') ?? 'active',
          workspaceId: data.agent.workspaceId ?? '',
        });
      } catch {
        // Agent not found
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [agentId]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading agent...</div>;
  if (!agent) return <div className="text-sm text-red-500 py-8 text-center">Agent not found</div>;

  return (
    <AgentEditor
      workspaceId={null}
      agent={agent}
      onSave={onDone}
      onCancel={onDone}
    />
  );
}
