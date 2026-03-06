/** Subset of the Web Crypto JsonWebKey interface used for JWKS endpoints. */
export interface JWK {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
  // RSA
  n?: string;
  e?: string;
  // EC
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

export interface TokenClaims {
  sub: string;
  workspaceId?: string;
  roles: string[];
  isDeploymentAdmin: boolean;
  iat: number;
  exp: number;
}

export interface JWKS {
  keys: JWK[];
}

export interface CreateUserRequest {
  email: string;
  password?: string;
  isDeploymentAdmin?: boolean;
}

export interface User {
  id: string;
  email: string;
  isDeploymentAdmin: boolean;
  totpEnabled: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface AuthResult {
  user: User;
  requiresMfa: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface OIDCProviderConfig {
  name: string;
  issuer: string;
  clientId: string;
  clientSecretRef: string;
  discoveryUrl?: string;
}

export interface IdentityProvider {
  validateToken(token: string): Promise<TokenClaims>;
  getJWKS(): Promise<JWKS>;
  createUser(req: CreateUserRequest): Promise<User>;
  updateUserRoles(userId: string, workspaceId: string, roles: string[]): Promise<void>;
  listUsers(workspaceId?: string): Promise<User[]>;
  authenticateLocal(email: string, password: string): Promise<AuthResult>;
  issueTokens(userId: string, workspaceId: string): Promise<TokenPair>;
  configureOIDCProvider(config: OIDCProviderConfig): Promise<void>;
}
