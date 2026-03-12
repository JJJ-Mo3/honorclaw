import { useState } from 'react';
import { useAuth } from '../../auth/useAuth.js';
import { api } from '../../api/client.js';

type SettingsTab = 'profile' | 'security';

export function SettingsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-gray-500 mb-4">Manage your profile and security preferences</p>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setActiveTab('profile')} className={`px-4 py-2 text-sm rounded ${activeTab === 'profile' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border'}`}>
          Profile
        </button>
        <button onClick={() => setActiveTab('security')} className={`px-4 py-2 text-sm rounded ${activeTab === 'security' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border'}`}>
          Security
        </button>
      </div>

      {activeTab === 'profile' && <ProfileTab email={user?.email ?? ''} />}
      {activeTab === 'security' && <SecurityTab />}
    </div>
  );
}

function ProfileTab({ email }: { email: string }) {
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      await api.patch('/auth/me', { displayName: displayName || undefined });
      setMessage('Profile updated.');
    } catch {
      setMessage('Failed to update profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-lg">
      <h2 className="text-lg font-semibold mb-4">Profile</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Email</label>
          <input type="email" value={email} disabled className="w-full border rounded px-3 py-2 text-sm bg-gray-50 text-gray-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Display Name</label>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Enter display name" className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        {message && <p className={`text-sm ${message.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}>{message}</p>}
        <button onClick={() => { void handleSave(); }} disabled={saving} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function SecurityTab() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpSaving, setTotpSaving] = useState(false);
  const [totpMessage, setTotpMessage] = useState('');

  const handlePasswordChange = async () => {
    if (newPassword !== confirmPassword) {
      setMessage('Passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setMessage('Password must be at least 8 characters.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setMessage('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      setMessage('Failed to change password. Check your current password.');
    } finally {
      setSaving(false);
    }
  };

  const handleTotpSetup = async () => {
    try {
      const data = await api.post<{ secret: string; otpauthUri: string }>('/auth/totp/setup');
      setTotpSetup(data);
      setTotpMessage('');
    } catch {
      setTotpMessage('Failed to set up TOTP.');
    }
  };

  const handleTotpVerify = async () => {
    setTotpSaving(true);
    try {
      await api.post('/auth/totp/verify', { code: totpCode });
      setTotpMessage('Two-factor authentication enabled.');
      setTotpSetup(null);
      setTotpCode('');
    } catch {
      setTotpMessage('Invalid code. Please try again.');
    } finally {
      setTotpSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Change Password</h2>
        <div className="space-y-3">
          <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
          <input type="password" placeholder="New password (min 8 chars)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
          <input type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
          {message && <p className={`text-sm ${message.includes('Failed') || message.includes('match') || message.includes('must') ? 'text-red-600' : 'text-green-600'}`}>{message}</p>}
          <button onClick={() => { void handlePasswordChange(); }} disabled={saving || !currentPassword || !newPassword} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? 'Changing...' : 'Change Password'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Two-Factor Authentication (TOTP)</h2>
        {!totpSetup ? (
          <div>
            <p className="text-sm text-gray-600 mb-3">Add an extra layer of security to your account with a time-based one-time password (TOTP) authenticator app.</p>
            <button onClick={() => { void handleTotpSetup(); }} className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors">
              Set Up TOTP
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Scan this URI in your authenticator app, or manually enter the secret:</p>
            <div className="bg-gray-50 p-3 rounded text-xs font-mono break-all">{totpSetup.otpauthUri}</div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Secret Key</label>
              <div className="bg-gray-50 p-2 rounded text-sm font-mono">{totpSetup.secret}</div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Verification Code</label>
              <input type="text" placeholder="Enter 6-digit code" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} maxLength={6} className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <button onClick={() => { void handleTotpVerify(); }} disabled={totpSaving || totpCode.length !== 6} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {totpSaving ? 'Verifying...' : 'Verify & Enable'}
            </button>
            <button onClick={() => { setTotpSetup(null); setTotpCode(''); }} className="ml-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          </div>
        )}
        {totpMessage && <p className={`mt-2 text-sm ${totpMessage.includes('Failed') || totpMessage.includes('Invalid') ? 'text-red-600' : 'text-green-600'}`}>{totpMessage}</p>}
      </div>
    </div>
  );
}

