import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';

// ── Types ───────────────────────────────────────────────────────────────

type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'pending';
type AuthMode = 'oauth2' | 'service_account' | 'api_key' | 'credentials' | 'none';

interface SecretField {
  path: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

interface IntegrationInfo {
  id: string;
  name: string;
  description: string;
  status: ConnectionStatus;
  authMode: AuthMode;
  secretFields: SecretField[] | null;
  lastChecked?: string;
  errorMessage?: string;
  source?: 'default' | 'custom';
  category?: string;
}

// ── Icons ───────────────────────────────────────────────────────────────

const INTEGRATION_ICONS: Record<string, React.ReactNode> = {
  'google-workspace': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  'microsoft-365': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>
      <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
    </svg>
  ),
  slack: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/>
      <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/>
      <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D"/>
      <path d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" fill="#ECB22E"/>
    </svg>
  ),
  'microsoft-teams': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M20.625 8.25h-3.75c.207 0 .375-.168.375-.375V5.25a2.25 2.25 0 0 0-2.25-2.25h-.375a1.875 1.875 0 1 1 3.188-1.313A1.875 1.875 0 0 1 19.125 3H19.5a2.25 2.25 0 0 1 2.25 2.25v1.875a1.125 1.125 0 0 1-1.125 1.125z" fill="#5059C9"/>
      <path d="M15 3.75a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" fill="#5059C9"/>
      <path d="M11.25 5.25a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5z" fill="#7B83EB"/>
      <rect x="3" y="6.75" width="13.5" height="12" rx="1.5" fill="#7B83EB"/>
      <path d="M10.5 10.5h-3v5.25h-1.5V10.5H3V9h7.5v1.5z" fill="white"/>
      <path d="M19.5 8.25h-5.25v8.625a1.875 1.875 0 0 0 1.875 1.875H21a1.5 1.5 0 0 0 1.5-1.5v-6a3 3 0 0 0-3-3z" fill="#5059C9" opacity="0.5"/>
    </svg>
  ),
  jira: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M11.53 2c0 4.97-3.6 9-8.05 9H.53l11 11 11-11h-2.95C15.13 11 11.53 6.97 11.53 2z" fill="#2684FF"/>
      <path d="M7.28 6.56l4.25 4.25 4.25-4.25" fill="url(#jira-grad1)" opacity="0.4"/>
      <defs><linearGradient id="jira-grad1" x1="7.28" y1="6.56" x2="15.78" y2="6.56"><stop stopColor="#0052CC"/><stop offset="1" stopColor="#2684FF"/></linearGradient></defs>
    </svg>
  ),
  github: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  ),
  gitlab: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.386 9.452.044 13.587a.924.924 0 0 0 .331 1.03L12 23.054l11.625-8.436a.92.92 0 0 0 .33-1.03z" fill="#E24329"/>
      <path d="M12 23.054L16.418 9.45H7.582L12 23.054z" fill="#FC6D26"/>
      <path d="M12 23.054l-4.418-13.6H1.386L12 23.054z" fill="#FCA326"/>
      <path d="M1.386 9.452L.044 13.587a.924.924 0 0 0 .331 1.03L12 23.054 1.386 9.452z" fill="#E24329"/>
      <path d="M12 23.054l4.418-13.6h6.196L12 23.054z" fill="#FCA326"/>
      <path d="M22.614 9.452l1.341 4.135a.924.924 0 0 1-.33 1.03L12 23.054l10.614-13.602z" fill="#E24329"/>
    </svg>
  ),
  pagerduty: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M5.06 18.846h3.108V24H5.06v-5.154zM14.217.001C10.922-.062 5.06 1.065 5.06 7.326c0 5.494 4.754 7.26 9.18 7.394h1.228V3.42c0-1.1-.218-2.003-.746-2.63C14.167.169 13.506.001 14.217.001zm3.462 3.417v8.892c2.287-.478 5.26-2.7 5.26-5.989 0-3.456-2.476-4.723-5.26-2.903z" fill="#06AC38"/>
    </svg>
  ),
  salesforce: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M10.006 4.867a4.592 4.592 0 0 1 3.402-1.51 4.614 4.614 0 0 1 4.16 2.628 5.567 5.567 0 0 1 2.31-.502C22.167 5.483 24 7.345 24 9.633a4.178 4.178 0 0 1-2.126 3.64 4.728 4.728 0 0 1-4.553 5.847 4.722 4.722 0 0 1-2.584-.77 4.957 4.957 0 0 1-8.064-.758A5.278 5.278 0 0 1 0 12.924a5.28 5.28 0 0 1 3.058-4.795 5.628 5.628 0 0 1-.149-1.286 5.59 5.59 0 0 1 7.097-5.396v3.42z" fill="#00A1E0"/>
    </svg>
  ),
  confluence: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M1.637 20.367c-.2.337-.44.735-.64 1.039a.81.81 0 0 0 .261 1.113l4.664 2.836a.81.81 0 0 0 1.108-.237c.177-.278.408-.658.666-1.09 1.828-3.063 3.661-2.692 7.059-1.148l4.093 1.863a.81.81 0 0 0 1.074-.395l2.39-5.17a.81.81 0 0 0-.39-1.076c-1.202-.548-3.596-1.638-5.02-2.286-5.932-2.693-10.935-2.48-15.265 4.55z" fill="#2684FF"/>
      <path d="M22.363 3.633c.2-.337.44-.735.64-1.039A.81.81 0 0 0 22.742 1.48L18.078-1.356a.81.81 0 0 0-1.108.237c-.177.278-.408.658-.666 1.09-1.828 3.063-3.661 2.692-7.059 1.148L5.152-.744a.81.81 0 0 0-1.074.395L1.688 4.82a.81.81 0 0 0 .39 1.076c1.202.548 3.596 1.638 5.02 2.286 5.932 2.693 10.935 2.48 15.265-4.55z" fill="url(#conf-grad)" opacity="0.65"/>
      <defs><linearGradient id="conf-grad" x1="22" y1="0" x2="2" y2="10"><stop stopColor="#0052CC"/><stop offset="1" stopColor="#2684FF"/></linearGradient></defs>
    </svg>
  ),
  hubspot: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M17.41 10.125V7.106a2.003 2.003 0 0 0 1.155-1.81v-.06a2.005 2.005 0 0 0-2.005-2.006h-.06a2.005 2.005 0 0 0-2.006 2.005v.06c0 .78.45 1.455 1.1 1.783v3.046a5.56 5.56 0 0 0-2.46 1.198l-6.478-5.04a2.392 2.392 0 0 0 .073-.566 2.4 2.4 0 1 0-2.4 2.4c.396 0 .766-.1 1.094-.274l6.37 4.958a5.584 5.584 0 0 0-.26 1.7 5.602 5.602 0 0 0 5.6 5.6 5.602 5.602 0 0 0 5.6-5.6 5.602 5.602 0 0 0-5.323-5.575zm.09 8.319a2.848 2.848 0 1 1 0-5.696 2.848 2.848 0 0 1 0 5.696z" fill="#FF7A59"/>
    </svg>
  ),
  snowflake: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93L4.93 19.07" stroke="#29B5E8" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="12" cy="2" r="1.5" fill="#29B5E8"/>
      <circle cx="12" cy="22" r="1.5" fill="#29B5E8"/>
      <circle cx="2" cy="12" r="1.5" fill="#29B5E8"/>
      <circle cx="22" cy="12" r="1.5" fill="#29B5E8"/>
      <circle cx="4.93" cy="4.93" r="1.5" fill="#29B5E8"/>
      <circle cx="19.07" cy="19.07" r="1.5" fill="#29B5E8"/>
      <circle cx="19.07" cy="4.93" r="1.5" fill="#29B5E8"/>
      <circle cx="4.93" cy="19.07" r="1.5" fill="#29B5E8"/>
    </svg>
  ),
  bigquery: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M6.354 18.354l-3.565 3.565a1.688 1.688 0 0 0 2.387 2.387l3.565-3.565" fill="#4386FA"/>
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" fill="#4386FA"/>
      <path d="M13 8h-2v4H8v2h3v4h2v-4h3v-2h-3V8z" fill="#4386FA" opacity="0.6"/>
    </svg>
  ),
  notion: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L18.19 2.23c-.42-.326-.98-.7-2.055-.607L3.01 2.882c-.466.047-.56.28-.374.466l1.823 1.86zm.793 3.312v13.894c0 .746.373 1.026 1.213.98l14.523-.84c.84-.046.933-.56.933-1.166V6.54c0-.607-.233-.933-.746-.887l-15.177.887c-.56.047-.746.327-.746.98zm14.337.42c.093.42 0 .84-.42.887l-.7.14v10.264c-.607.327-1.166.513-1.633.513-.746 0-.933-.233-1.493-.933l-4.572-7.178v6.945l1.446.327s0 .84-1.166.84l-3.218.187c-.093-.187 0-.653.327-.727l.84-.233V9.854L7.16 9.714c-.094-.42.14-1.026.793-1.073l3.452-.233 4.759 7.272V9.34l-1.213-.14c-.093-.513.28-.886.746-.933l3.452-.233zM2.69.84L16.26.002c1.68-.14 2.1.093 2.8.607l3.872 2.706c.467.327.607.747.607 1.307v17.075c0 1.026-.373 1.633-1.68 1.726L5.766 24.28c-.98.047-1.447-.093-1.96-.747L.84 19.666C.28 18.92.001 18.36.001 17.687V2.562C.001 1.723.374.934 2.69.84z"/>
    </svg>
  ),
  email: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="20" height="16" rx="2" stroke="#6B7280" strokeWidth="2"/>
      <path d="M2 7l10 7 10-7" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  'web-search': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="8" stroke="#6B7280" strokeWidth="2"/>
      <path d="M21 21l-4.35-4.35" stroke="#6B7280" strokeWidth="2" strokeLinecap="round"/>
      <path d="M11 3a8 8 0 0 1 0 16" stroke="#6B7280" strokeWidth="1" strokeDasharray="2 2" opacity="0.5"/>
      <path d="M3 11h16" stroke="#6B7280" strokeWidth="1" opacity="0.5"/>
    </svg>
  ),
  discord: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" fill="#5865F2"/>
    </svg>
  ),
  whatsapp: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" fill="#25D366"/>
    </svg>
  ),
  fireflies: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" fill="#6C2BD9"/>
      <circle cx="6" cy="16" r="2.5" fill="#6C2BD9" opacity="0.7"/>
      <circle cx="18" cy="16" r="2.5" fill="#6C2BD9" opacity="0.7"/>
      <circle cx="12" cy="20" r="1.5" fill="#6C2BD9" opacity="0.5"/>
      <path d="M12 4V1M8.5 5.5L6.5 3.5M15.5 5.5l2-2" stroke="#6C2BD9" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  gong: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="#7C3AED" strokeWidth="2.5"/>
      <circle cx="12" cy="12" r="3" fill="#7C3AED"/>
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  coda: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10c2.1 0 4.048-.648 5.657-1.757a.5.5 0 0 0 .087-.74l-2.121-2.122a.5.5 0 0 0-.574-.094A5.97 5.97 0 0 1 12 18a6 6 0 1 1 3.049-11.172.5.5 0 0 0 .574-.094l2.121-2.121a.5.5 0 0 0-.087-.74A9.964 9.964 0 0 0 12 2z" fill="#F46A54"/>
    </svg>
  ),
  airtable: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M11.52 1.28L2.08 4.88c-.42.16-.42.76 0 .92l9.44 3.6c.3.12.64.12.94 0l9.44-3.6c.42-.16.42-.76 0-.92l-9.44-3.6a1.22 1.22 0 0 0-.94 0z" fill="#FCB400"/>
      <path d="M12.76 11.36V21.6c0 .38.4.64.76.48l9.2-4.12c.28-.12.46-.4.46-.72V7.04c0-.38-.4-.64-.76-.48l-9.2 4.12c-.28.12-.46.4-.46.68z" fill="#18BFFF"/>
      <path d="M11.24 11.36V21.6c0 .38-.4.64-.76.48L1.28 17.96c-.28-.12-.46-.4-.46-.72V7.04c0-.38.4-.64.76-.48l9.2 4.12c.28.12.46.4.46.68z" fill="#F82B60"/>
    </svg>
  ),
  asana: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="6.5" r="4.5" fill="#F06A6A"/>
      <circle cx="5" cy="17" r="4.5" fill="#F06A6A"/>
      <circle cx="19" cy="17" r="4.5" fill="#F06A6A"/>
    </svg>
  ),
  linear: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M2.513 12.833l8.654 8.654a10.027 10.027 0 0 1-8.654-8.654zm-.49-2.88A10.048 10.048 0 0 0 2 12c0 .338.017.673.05 1.003l8.947 8.947c.33.033.665.05 1.003.05a10.048 10.048 0 0 0 1.847-.173L2.023 9.953zM3.6 6.573l13.827 13.827A10.01 10.01 0 0 0 20.4 17.427L6.573 3.6A10.01 10.01 0 0 0 3.6 6.573zM9.953 2.023l11.824 11.824c.197-.707.3-1.45.3-2.22 0-.123-.003-.245-.01-.366L10.319 2.023A10.164 10.164 0 0 0 9.953 2.023zM12.833 2.023l8.654 8.654A10.027 10.027 0 0 0 12.833 2.023z" fill="#5E6AD2"/>
    </svg>
  ),
  zendesk: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M11 6v12.5L2 6h9z" fill="#03363D"/>
      <path d="M11 6a4.5 4.5 0 1 1-9 0h9z" fill="#03363D"/>
      <path d="M13 18V5.5l9 12.5h-9z" fill="#03363D"/>
      <path d="M13 18a4.5 4.5 0 1 1 9 0h-9z" fill="#03363D"/>
    </svg>
  ),
  servicenow: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 15.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" fill="#81B5A1"/>
      <circle cx="12" cy="12" r="3" fill="#81B5A1"/>
    </svg>
  ),
  stripe: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.918 3.757 7.038c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.846 1.573-2.366 1.573-1.933 0-4.84-.89-6.78-2.086l-.9 5.555C5.283 22.943 8.182 24 11.591 24c2.632 0 4.76-.652 6.29-1.887 1.658-1.341 2.462-3.262 2.462-5.543 0-4.116-2.502-5.834-6.367-7.42z" fill="#6772E5"/>
    </svg>
  ),
  intercom: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#1F8DED"/>
      <path d="M18 14.63c0 .1-.08.18-.18.18h-.01a.18.18 0 0 1-.14-.07 9.88 9.88 0 0 0-11.34 0 .18.18 0 0 1-.25-.03.18.18 0 0 1-.08-.15V14c0-.06.03-.11.07-.15a11.16 11.16 0 0 1 11.86 0c.04.04.07.1.07.15v.63zM8 13a.5.5 0 0 1-1 0V7.5a.5.5 0 0 1 1 0V13zm2.5.5a.5.5 0 0 1-1 0V6.5a.5.5 0 0 1 1 0v7zm2.5 0a.5.5 0 0 1-1 0V6.5a.5.5 0 0 1 1 0v7zm2.5-.5a.5.5 0 0 1-1 0V7.5a.5.5 0 0 1 1 0V13zm2 0a.5.5 0 0 1-1 0V8a.5.5 0 0 1 1 0v5z" fill="white"/>
    </svg>
  ),
  databricks: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M12 1L2 6.5v3l10 5.5 10-5.5v-3L12 1z" fill="#FF3621"/>
      <path d="M2 9.5v3l10 5.5 10-5.5v-3L12 15 2 9.5z" fill="#FF3621" opacity="0.7"/>
      <path d="M2 12.5v3l10 5.5 10-5.5v-3L12 18 2 12.5z" fill="#FF3621" opacity="0.4"/>
    </svg>
  ),
  tableau: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M11.5 2h1v4h-1V2zm-5 5h4v1h-4V7zm8 0h4v1h-4V7zM11.5 10h1v4h-1v-4zm-9 1h4v1h-4v-1zm16 0h4v1h-4v-1zM11.5 18h1v4h-1v-4zm-5-3h4v1h-4v-1zm8 0h4v1h-4v-1z" fill="#E97627"/>
      <path d="M12 5.5l-1.5 1.5H12V5.5zm0 0l1.5 1.5H12V5.5z" fill="#C72037"/>
    </svg>
  ),
  segment: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M14.4 7.2H3.2a.8.8 0 1 1 0-1.6h11.2a.8.8 0 1 1 0 1.6z" fill="#52BD95"/>
      <path d="M20.8 12.8H9.6a.8.8 0 1 1 0-1.6h11.2a.8.8 0 1 1 0 1.6z" fill="#52BD95"/>
      <path d="M14.4 18.4H3.2a.8.8 0 1 1 0-1.6h11.2a.8.8 0 1 1 0 1.6z" fill="#52BD95"/>
      <circle cx="19.2" cy="6.4" r="2" fill="#52BD95"/>
      <circle cx="4.8" cy="17.6" r="2" fill="#52BD95" opacity="0.5"/>
    </svg>
  ),
  aws: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576a.345.345 0 0 1 .056.184c0 .08-.048.16-.152.24l-.504.336a.38.38 0 0 1-.208.072c-.08 0-.16-.04-.24-.112a2.478 2.478 0 0 1-.272-.352 5.744 5.744 0 0 1-.232-.44c-.584.688-1.32 1.032-2.208 1.032-.632 0-1.136-.18-1.504-.544-.368-.36-.552-.84-.552-1.44 0-.64.224-1.16.68-1.552.456-.392 1.064-.588 1.84-.588.256 0 .52.024.8.064.28.04.568.104.872.184v-.552c0-.568-.12-.968-.352-1.2-.24-.232-.64-.344-1.208-.344-.26 0-.528.032-.8.104a5.882 5.882 0 0 0-.8.28l-.12.048-.208.048c-.08 0-.12-.056-.12-.176v-.392c0-.088.008-.152.032-.192a.33.33 0 0 1 .12-.12c.264-.136.584-.248.952-.336.368-.096.76-.14 1.176-.14.896 0 1.552.204 1.976.612.416.408.628 1.028.628 1.86v2.448z" fill="#252F3E"/>
      <path d="M18.882 11.468l-1.28-4.24h-.04l-1.248 4.24h2.568zm.72 2.112h-.84c-.12 0-.216-.02-.28-.064a.392.392 0 0 1-.136-.208l-2.816-9.28c-.04-.08-.056-.144-.056-.192 0-.08.04-.128.12-.128h.984c.12 0 .216.02.272.064a.4.4 0 0 1 .136.208l2.016 7.92h.04l1.872-7.92a.37.37 0 0 1 .128-.2c.064-.048.152-.072.28-.072h.8c.128 0 .216.02.28.072.064.048.104.12.128.2l1.896 8.016h.04l2.072-8.016c.04-.088.08-.16.144-.208.064-.048.16-.064.264-.064h.936c.08 0 .128.04.128.128 0 .024-.008.048-.016.08a.76.76 0 0 1-.048.12l-2.888 9.28a.394.394 0 0 1-.136.208.416.416 0 0 1-.28.064h-.864c-.128 0-.216-.02-.28-.072-.064-.048-.104-.12-.128-.208l-1.864-7.72h-.032l-1.864 7.712a.388.388 0 0 1-.128.208.434.434 0 0 1-.28.072z" fill="#252F3E"/>
      <path d="M21.37 16.532c-2.84 2.096-6.96 3.208-10.504 3.208-4.968 0-9.44-1.84-12.824-4.896-.264-.24-.024-.568.296-.384 3.656 2.128 8.176 3.408 12.848 3.408 3.152 0 6.616-.652 9.808-2.008.48-.208.884.312.376.672z" fill="#FF9900"/>
      <path d="M22.484 15.264c-.36-.464-2.4-.224-3.32-.112-.28.032-.32-.208-.072-.384 1.624-1.144 4.296-.816 4.608-.432.312.392-.088 3.08-1.608 4.36-.232.2-.456.096-.352-.168.344-.848 1.104-2.8.744-3.264z" fill="#FF9900"/>
    </svg>
  ),
  gcp: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M15.65 8.35l1.42-1.42L18.49 8.35l1.42-1.42-2.83-2.83a4 4 0 0 0-5.66 0L8.59 6.93l1.42 1.42 2.83-2.83a2 2 0 0 1 2.83 0l-.02.83z" fill="#EA4335"/>
      <path d="M19.78 12l-1.42-1.42-1.42 1.42-2.83-2.83-1.42 1.42 2.83 2.83-2.83 2.83 1.42 1.42 2.83-2.83 1.42 1.42L19.78 15l-1.42-1.42L19.78 12z" fill="#4285F4"/>
      <path d="M12 17.66l-2.83-2.83-1.42 1.42L12 20.49l4.24-4.24-1.42-1.42L12 17.66z" fill="#34A853"/>
      <path d="M6.93 15.41L8.35 14l-2.83-2.83L8.35 8.35 6.93 6.93 4.1 9.76a4 4 0 0 0 0 5.66l2.83-2.83v2.83z" fill="#FBBC05"/>
    </svg>
  ),
  azure: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M9.09 2H2l7.09 18.97L2 22h20L9.09 2z" fill="#0089D6"/>
      <path d="M15.96 5.65L12.03 14l5.97 7H2l7.09.97L22 22l-6.04-16.35z" fill="#0089D6" opacity="0.7"/>
    </svg>
  ),
  datadog: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M16.51 8.15l-2.27-1.85-.25-.02-1.59 1.9-1.65-.64-.32.17-.09 2.49-1.58 1.88.12.3 2.45.48.72 2.41.29.11 1.82-1.7 2.38.93.24-.19.1-2.68 1.4-1.76-.13-.29-2.4-.35-.51-2.2zm-1.39 4.66l-1.26.9-.47-.14-.47-1.6-.05-.3 1.05-1.25.29-.04 1.56 1.04.06.32-.71 1.07z" fill="#632CA6"/>
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17z" fill="#632CA6"/>
    </svg>
  ),
  okta: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" fill="#007DC1"/>
    </svg>
  ),
  zoom: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <rect x="1" y="4" width="22" height="16" rx="4" fill="#2D8CFF"/>
      <path d="M3.5 8.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-5z" fill="white"/>
      <path d="M14.5 9.5l4-2.5v8l-4-2.5v-3z" fill="white"/>
    </svg>
  ),
};

function getIcon(id: string): React.ReactNode {
  return INTEGRATION_ICONS[id] ?? (
    <div className="h-8 w-8 rounded bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">
      {id.charAt(0).toUpperCase()}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────

export function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  async function loadIntegrations() {
    try {
      const data = await api.get<IntegrationInfo[]>('/integrations');
      setIntegrations(data);
    } catch {
      setIntegrations([]);
    }
  }

  useEffect(() => {
    loadIntegrations().finally(() => setLoading(false));
  }, []);

  async function testConnection(integrationId: string) {
    setTestingId(integrationId);
    try {
      const result = await api.post<{ status: ConnectionStatus; errorMessage?: string }>(
        `/integrations/${integrationId}/test`,
      );
      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === integrationId
            ? {
                ...i,
                status: result.status,
                errorMessage: result.errorMessage,
                lastChecked: new Date().toISOString(),
              }
            : i,
        ),
      );
    } catch (err) {
      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === integrationId
            ? {
                ...i,
                status: 'error',
                errorMessage: err instanceof Error ? err.message : 'Connection test failed',
                lastChecked: new Date().toISOString(),
              }
            : i,
        ),
      );
    } finally {
      setTestingId(null);
    }
  }

  async function handleSaveCredentials(integrationId: string, fields: { path: string; value: string }[]) {
    for (const field of fields) {
      if (field.value) {
        await api.post('/secrets', { path: field.path, value: field.value });
      }
    }
    // Also store a marker at the main credentials path so test-connection works
    const integration = integrations.find((i) => i.id === integrationId);
    if (integration) {
      await api.post('/secrets', {
        path: `integrations/${integrationId}/credentials`,
        value: JSON.stringify({ configured: true, fields: fields.map((f) => f.path) }),
      });
    }
    setConfiguringId(null);
    // Re-test connection after saving
    await testConnection(integrationId);
    await loadIntegrations();
  }

  async function handleDeleteCustom(integrationId: string) {
    if (!confirm('Delete this custom integration? This will also remove its stored credentials.')) return;
    const slug = integrationId.replace('custom/', '');
    try {
      await api.delete(`/integrations/custom/${slug}`);
      await loadIntegrations();
    } catch {
      // Keep existing data
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading integrations...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Integrations</h1>
          <p className="mt-1 text-sm text-gray-500">Manage external service connections</p>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Add Custom Integration
        </button>
      </header>

      {showAddForm && (
        <AddCustomIntegrationForm
          onClose={() => setShowAddForm(false)}
          onCreated={() => { setShowAddForm(false); loadIntegrations(); }}
        />
      )}

      <div className="max-w-5xl mx-auto px-6 py-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {integrations.map((integration) => (
          <IntegrationCard
            key={integration.id}
            integration={integration}
            icon={getIcon(integration.id)}
            testing={testingId === integration.id}
            configuring={configuringId === integration.id}
            onTestConnection={() => testConnection(integration.id)}
            onConfigure={() => setConfiguringId(configuringId === integration.id ? null : integration.id)}
            onSaveCredentials={(fields) => handleSaveCredentials(integration.id, fields)}
            onDelete={integration.source === 'custom' ? () => handleDeleteCustom(integration.id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ── Integration Card ────────────────────────────────────────────────────

interface IntegrationCardProps {
  integration: IntegrationInfo;
  icon: React.ReactNode;
  testing: boolean;
  configuring: boolean;
  onTestConnection: () => void;
  onConfigure: () => void;
  onSaveCredentials: (fields: { path: string; value: string }[]) => Promise<void>;
  onDelete?: () => void;
}

function IntegrationCard({
  integration,
  icon,
  testing,
  configuring,
  onTestConnection,
  onConfigure,
  onSaveCredentials,
  onDelete,
}: IntegrationCardProps) {
  const [saving, setSaving] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [jsonValue, setJsonValue] = useState('');

  const hasSecretFields = integration.secretFields && integration.secretFields.length > 0;

  async function handleSave() {
    setSaving(true);
    try {
      if (hasSecretFields) {
        const fields = integration.secretFields!.map((f) => ({
          path: f.path,
          value: fieldValues[f.path] ?? '',
        }));
        await onSaveCredentials(fields);
      } else if (jsonValue.trim()) {
        await onSaveCredentials([
          { path: `integrations/${integration.id}/credentials`, value: jsonValue.trim() },
        ]);
      }
      setFieldValues({});
      setJsonValue('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">{integration.name}</h3>
            {integration.source === 'custom' && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                Custom
              </span>
            )}
            <StatusIndicator status={integration.status} />
          </div>
          <p className="mt-1 text-xs text-gray-500">{integration.description}</p>

          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Status</span>
              <span className={`font-medium ${statusColor(integration.status)}`}>
                {statusLabel(integration.status)}
              </span>
            </div>

            {integration.lastChecked && (
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Last Checked</span>
                <span className="text-gray-700 text-xs">
                  {new Date(integration.lastChecked).toLocaleString()}
                </span>
              </div>
            )}

            {integration.errorMessage && (
              <div className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-700">
                {integration.errorMessage}
              </div>
            )}
          </div>

          {/* Configure form */}
          {configuring && (
            <div className="mt-4 space-y-3 border-t border-gray-100 pt-3">
              {hasSecretFields ? (
                integration.secretFields!.map((field) => (
                  <div key={field.path}>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      {field.label}
                      {!field.required && <span className="text-gray-400 ml-1">(optional)</span>}
                    </label>
                    <input
                      type="password"
                      placeholder={field.placeholder}
                      value={fieldValues[field.path] ?? ''}
                      onChange={(e) =>
                        setFieldValues((prev) => ({ ...prev, [field.path]: e.target.value }))
                      }
                      className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                ))
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Credentials (JSON)
                  </label>
                  <textarea
                    rows={3}
                    placeholder='{"apiKey": "...", "secret": "..."}'
                    value={jsonValue}
                    onChange={(e) => setJsonValue(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Credentials'}
              </button>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              onClick={onConfigure}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              {configuring ? 'Cancel' : 'Configure'}
            </button>
            <button
              onClick={onTestConnection}
              disabled={testing}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            {onDelete && (
              <button
                onClick={onDelete}
                className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Add Custom Integration Form ─────────────────────────────────────────

interface FieldRow {
  label: string;
  required: boolean;
  placeholder: string;
}

function AddCustomIntegrationForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Custom');
  const [fields, setFields] = useState<FieldRow[]>([{ label: '', required: true, placeholder: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addField() {
    if (fields.length >= 20) return;
    setFields([...fields, { label: '', required: true, placeholder: '' }]);
  }

  function removeField(index: number) {
    if (fields.length <= 1) return;
    setFields(fields.filter((_, i) => i !== index));
  }

  function updateField(index: number, patch: Partial<FieldRow>) {
    setFields(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validFields = fields.filter((f) => f.label.trim());
    if (!name.trim() || validFields.length === 0) {
      setError('Name and at least one secret field label are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post('/integrations/custom', {
        name: name.trim(),
        description: description.trim(),
        category: category.trim() || 'Custom',
        secretFields: validFields,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create integration');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-6">
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Add Custom Integration</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Internal API"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Connect to our internal service"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Custom"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">Secret Fields *</label>
              <button
                type="button"
                onClick={addField}
                disabled={fields.length >= 20}
                className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
              >
                + Add Field
              </button>
            </div>
            <div className="space-y-2">
              {fields.map((field, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={field.label}
                    onChange={(e) => updateField(i, { label: e.target.value })}
                    placeholder="Field label (e.g., API Key)"
                    className="flex-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    value={field.placeholder}
                    onChange={(e) => updateField(i, { placeholder: e.target.value })}
                    placeholder="Placeholder"
                    className="flex-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-600 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => updateField(i, { required: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    Req
                  </label>
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    disabled={fields.length <= 1}
                    className="text-gray-400 hover:text-red-500 disabled:opacity-30 text-lg leading-none"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create Integration'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Status Indicator ────────────────────────────────────────────────────

function StatusIndicator({ status }: { status: ConnectionStatus }) {
  const colors: Record<ConnectionStatus, string> = {
    connected: 'bg-green-500',
    disconnected: 'bg-gray-400',
    error: 'bg-red-500',
    pending: 'bg-yellow-500',
  };

  return <div className={`h-2.5 w-2.5 rounded-full ${colors[status]}`} />;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function statusLabel(status: ConnectionStatus): string {
  const labels: Record<ConnectionStatus, string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
    pending: 'Pending',
  };
  return labels[status];
}

function statusColor(status: ConnectionStatus): string {
  const colors: Record<ConnectionStatus, string> = {
    connected: 'text-green-700',
    disconnected: 'text-gray-500',
    error: 'text-red-700',
    pending: 'text-yellow-700',
  };
  return colors[status];
}
