import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
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
import { NavBar } from './components/NavBar.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NavBar />
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

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
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * Standalone agent editor page wrapper that extracts route params
 * and provides navigation callbacks to the AgentEditor component.
 */
function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <AgentEditor
        workspaceId={null}
        agent={{ id: id!, name: '', model: '', status: 'active', workspaceId: '' }}
        onSave={() => navigate('/admin')}
        onCancel={() => navigate('/admin')}
      />
    </div>
  );
}
