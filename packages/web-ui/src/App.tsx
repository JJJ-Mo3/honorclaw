import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './auth/useAuth.js';
import { LoginPage } from './auth/LoginPage.js';
import { ChatPage } from './features/chat/ChatPage.js';
import { AdminPage, AgentEditor } from './features/admin/AdminPage.js';
import { ManifestEditor } from './features/admin/ManifestEditor.js';
import { AuditViewer } from './features/audit/AuditViewer.js';
import { IntegrationsPage } from './pages/integrations/IntegrationsPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />

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
              <ProtectedRoute allowedRoles={['admin']}>
                <AdminPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/admin/agents/:id"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <AgentEditorPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/admin/agents/:id/manifest"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <ManifestEditor />
              </ProtectedRoute>
            }
          />

          {/* Protected: auditor + admin */}
          <Route
            path="/audit"
            element={
              <ProtectedRoute allowedRoles={['auditor', 'admin']}>
                <AuditViewer />
              </ProtectedRoute>
            }
          />

          {/* Protected: admin only */}
          <Route
            path="/integrations"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
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
