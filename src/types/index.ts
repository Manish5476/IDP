// Database types for the IDP

export type UserRole = 'owner' | 'admin' | 'developer' | 'viewer';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserVault {
  id: string;
  user_id: string;
  encrypted_vault_key: string; // AES-256-GCM encrypted vault key
  kdf_salt: string; // Base64 encoded salt
  kdf_algorithm: 'argon2id';
  kdf_version: number;
  kdf_params: { memoryCost: number; timeCost: number; parallelism: number };
  recovery_envelope: string | null; // Encrypted recovery bundle
  crypto_version: string;
  created_at: string;
  updated_at: string;
}

export interface UserCryptoKey {
  id: string;
  user_id: string;
  public_key: string; // RSA-OAEP public key (JWK)
  encrypted_private_key: string; // Encrypted with vault key
  key_version: number;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: UserRole;
  joined_at: string;
  profile?: Profile;
}

export interface WorkspaceInvitation {
  id: string;
  workspace_id: string;
  email: string;
  role: UserRole;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  token_hash: string;
  expires_at: string;
  created_at: string;
  invited_by: string;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  repository_url: string | null;
  status: 'active' | 'archived' | 'paused';
  owner_id: string;
  encryption_initialized: boolean;
  key_version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: UserRole;
  joined_at: string;
  profile?: Profile;
}

export interface ProjectKeyEnvelope {
  id: string;
  project_id: string;
  user_id: string;
  encrypted_project_key: string; // RSA-OAEP encrypted project key
  key_version: number;
  created_at: string;
  updated_at: string;
}

export type EnvironmentType = 'development' | 'testing' | 'staging' | 'production';

export interface Environment {
  id: string;
  project_id: string;
  name: string;
  type: EnvironmentType;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EncryptedSecret {
  id: string;
  environment_id: string;
  project_id: string;
  variable_name: string;
  encrypted_value: string; // AES-256-GCM ciphertext
  nonce: string; // Base64 nonce
  crypto_version: string;
  key_version: number;
  is_secret: boolean;
  created_at: string;
  updated_at: string;
}

export interface Branch {
  id: string;
  project_id: string;
  name: string;
  repository_ref: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  commit_date: string | null;
  is_active: boolean;
  is_synced: boolean;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  assignee?: Profile;
}

export interface IntegrationConnection {
  id: string;
  project_id: string;
  provider: 'github' | 'gitlab' | 'jira' | 'slack';
  status: 'connected' | 'disconnected' | 'error' | 'setup_required';
  scopes: string[];
  last_sync_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  outcome: 'success' | 'failure';
  metadata: Record<string, unknown>;
  created_at: string;
  actor?: Profile;
}

// Crypto format types
export interface EncryptedPayload {
  ciphertext: string; // Base64
  nonce: string; // Base64
  version: string;
  key_version: number;
  aad?: string; // Additional authenticated data
}

export interface RecoveryBundle {
  encrypted_vault_key: string;
  recovery_key_hash: string;
  version: string;
  created_at: string;
}

export interface VaultState {
  isLocked: boolean;
  isInitialized: boolean;
  vaultKey: CryptoKey | null; // Only in memory, never persisted
  privateKey: CryptoKeyPair | null;
}

// ─── Email Identities & Subscriptions Vault Types ───────────────────

export type SubscriptionCategory =
  | 'cloud'
  | 'ai'
  | 'devtools'
  | 'domain'
  | 'database'
  | 'design'
  | 'communication'
  | 'other';

export type SubscriptionStatus = 'active' | 'trial' | 'free' | 'paused' | 'cancelled';

export type BillingCycle = 'monthly' | 'yearly' | 'one_time' | 'free';

export interface VaultTodoItem {
  id: string;
  text: string;
  completed: boolean;
  created_at: string;
}

export interface EmailIdentitySecretPayload {
  emailPassword: string;
  recoveryInfo: string;
  purposeNotes: string;
  todos: VaultTodoItem[];
}

export interface SubscriptionSecretPayload {
  usernameOrLogin: string;
  password: string;
  twoFactorOrRecovery: string;
  purposeNotes: string;
  todos: VaultTodoItem[];
}

export interface EmailIdentity {
  id: string;
  workspace_id: string;
  user_id: string;
  email: string;
  alias_label: string;
  provider: string;
  status: 'active' | 'archived';
  encrypted_payload: string; // AES-256-GCM encrypted EmailIdentitySecretPayload JSON
  nonce: string; // Base64 IV/nonce
  crypto_version: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

export interface EmailSubscription {
  id: string;
  email_identity_id: string;
  workspace_id: string;
  user_id: string;
  project_id: string | null;
  service_name: string;
  service_url: string | null;
  category: SubscriptionCategory;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  cost_amount: number;
  currency: string;
  renewal_date: string | null;
  encrypted_payload: string; // AES-256-GCM encrypted SubscriptionSecretPayload JSON
  nonce: string; // Base64 IV/nonce
  crypto_version: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

