export interface SecretsProvider {
  getSecret(path: string, workspaceId?: string): Promise<string>;
  setSecret(path: string, value: string, workspaceId?: string): Promise<void>;
  deleteSecret(path: string, workspaceId?: string): Promise<void>;
  listSecrets(prefix: string, workspaceId?: string): Promise<string[]>;
}
