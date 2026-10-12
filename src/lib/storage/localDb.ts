import type {
  Profile,
  UserVault,
  UserCryptoKey,
  Workspace,
  WorkspaceMember,
  WorkspaceInvitation,
  Project,
  ProjectMember,
  ProjectKeyEnvelope,
  Environment,
  EncryptedSecret,
  Branch,
  Task,
  IntegrationConnection,
  AuditEvent,
  UserRole,
  EnvironmentType,
  TaskStatus,
  TaskPriority,
  EmailIdentity,
  EmailSubscription,
} from '@/types';

export interface LocalAuthUser {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  created_at: string;
}

interface LocalDatabaseSchema {
  users: LocalAuthUser[];
  currentSessionUserId: string | null;
  deleted_ids: string[];
  profiles: Profile[];
  user_vaults: UserVault[];
  user_crypto_keys: UserCryptoKey[];
  workspaces: Workspace[];
  workspace_members: WorkspaceMember[];
  workspace_invitations: WorkspaceInvitation[];
  projects: Project[];
  project_members: ProjectMember[];
  project_key_envelopes: ProjectKeyEnvelope[];
  environments: Environment[];
  encrypted_secrets: EncryptedSecret[];
  branches: Branch[];
  tasks: Task[];
  integration_connections: IntegrationConnection[];
  audit_events: AuditEvent[];
  email_identities: EmailIdentity[];
  email_subscriptions: EmailSubscription[];
}

const DB_STORAGE_KEY = 'devportal_idp_user_db_v1';

function createEmptyDb(): LocalDatabaseSchema {
  return {
    users: [],
    currentSessionUserId: null,
    deleted_ids: [],
    profiles: [],
    user_vaults: [],
    user_crypto_keys: [],
    workspaces: [],
    workspace_members: [],
    workspace_invitations: [],
    projects: [],
    project_members: [],
    project_key_envelopes: [],
    environments: [],
    encrypted_secrets: [],
    branches: [],
    tasks: [],
    integration_connections: [],
    audit_events: [],
    email_identities: [],
    email_subscriptions: [],
  };
}

export function loadLocalDb(): LocalDatabaseSchema {
  if (typeof window === 'undefined') return createEmptyDb();
  try {
    const raw = window.localStorage.getItem(DB_STORAGE_KEY);
    if (!raw) return createEmptyDb();
    const parsed = JSON.parse(raw) as Partial<LocalDatabaseSchema>;
    return {
      ...createEmptyDb(),
      ...parsed,
      deleted_ids: Array.isArray(parsed.deleted_ids) ? parsed.deleted_ids : [],
      email_identities: Array.isArray(parsed.email_identities) ? parsed.email_identities : [],
      email_subscriptions: Array.isArray(parsed.email_subscriptions) ? parsed.email_subscriptions : [],
    };
  } catch {
    return createEmptyDb();
  }
}

export function saveLocalDb(db: LocalDatabaseSchema): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(db));
}

export function markIdDeleted(db: LocalDatabaseSchema, id: string): void {
  if (!id) return;
  if (!db.deleted_ids.includes(id)) {
    db.deleted_ids.push(id);
  }
}

export function isIdDeleted(db: LocalDatabaseSchema, id: string): boolean {
  return Boolean(id && db.deleted_ids.includes(id));
}

export async function hashString(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || `item-${Date.now().toString(36)}`;
}

/**
 * Ensures a user has a profile and, if they have zero workspaces,
 * provisions a personal starter workspace + default project so the portal
 * is immediately functional and never leaves the user stranded.
 */
export function ensureUserProvisioned(userId: string, email: string, fullName?: string | null): Profile {
  const db = loadLocalDb();
  const now = new Date().toISOString();

  let profile = db.profiles.find(p => p.id === userId);
  if (!profile) {
    profile = {
      id: userId,
      email,
      full_name: fullName?.trim() || email.split('@')[0] || 'Developer',
      avatar_url: null,
      created_at: now,
      updated_at: now,
    };
    db.profiles.push(profile);
  } else if (fullName && !profile.full_name) {
    profile.full_name = fullName;
    profile.updated_at = now;
  }

  // Check if user belongs to any workspace
  const userMemberships = db.workspace_members.filter(wm => wm.user_id === userId);

  // Also auto-accept any pending invitations for this user's email
  const pendingInvites = db.workspace_invitations.filter(
    inv => inv.email.toLowerCase() === email.toLowerCase() && inv.status === 'pending'
  );
  for (const inv of pendingInvites) {
    inv.status = 'accepted';
    const alreadyMember = db.workspace_members.some(
      wm => wm.workspace_id === inv.workspace_id && wm.user_id === userId
    );
    if (!alreadyMember) {
      db.workspace_members.push({
        id: crypto.randomUUID(),
        workspace_id: inv.workspace_id,
        user_id: userId,
        role: inv.role,
        joined_at: now,
      });
    }
  }

  if (userMemberships.length === 0 && pendingInvites.length === 0) {
    const displayFirst = (profile.full_name || 'Personal').split(' ')[0];
    const wsId = crypto.randomUUID();
    const wsName = `${displayFirst} Engineering`;
    const workspace: Workspace = {
      id: wsId,
      name: wsName,
      slug: `${slugify(wsName)}-${wsId.slice(0, 5)}`,
      description: 'Default engineering workspace for projects, environments, and secrets',
      owner_id: userId,
      is_archived: false,
      created_at: now,
      updated_at: now,
    };
    db.workspaces.push(workspace);
    db.workspace_members.push({
      id: crypto.randomUUID(),
      workspace_id: wsId,
      user_id: userId,
      role: 'owner',
      joined_at: now,
    });

    // Provision a starter project with 4 environments, branches, and starter tasks
    provisionProjectInDb(
      db,
      wsId,
      'Core Platform API',
      'Primary backend service and microservice gateway',
      'https://github.com/DummyMe-one/IDP',
      userId,
      true
    );

    db.audit_events.unshift({
      id: crypto.randomUUID(),
      actor_id: userId,
      action: 'workspace.provisioned',
      resource_type: 'workspace',
      resource_id: wsId,
      workspace_id: wsId,
      project_id: null,
      outcome: 'success',
      metadata: { workspace_name: wsName, auto_provisioned: true },
      created_at: now,
    });
  }

  saveLocalDb(db);
  return profile;
}

export function provisionProjectInDb(
  db: LocalDatabaseSchema,
  workspaceId: string,
  name: string,
  description: string | null,
  repositoryUrl: string | null,
  ownerId: string,
  includeStarterData = false
): Project {
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();
  const baseSlug = slugify(name);
  const existingSlug = db.projects.some(
    p => p.workspace_id === workspaceId && p.slug === baseSlug
  );

  const project: Project = {
    id: projectId,
    workspace_id: workspaceId,
    name: name.trim(),
    slug: existingSlug ? `${baseSlug}-${projectId.slice(0, 4)}` : baseSlug,
    description: description?.trim() || null,
    repository_url: repositoryUrl?.trim() || null,
    status: 'active',
    owner_id: ownerId,
    encryption_initialized: true,
    key_version: 1,
    created_at: now,
    updated_at: now,
  };

  db.projects.unshift(project);

  db.project_members.push({
    id: crypto.randomUUID(),
    project_id: projectId,
    user_id: ownerId,
    role: 'owner',
    joined_at: now,
  });

  const defaultEnvs: { name: string; type: EnvironmentType; desc: string }[] = [
    { name: 'Development', type: 'development', desc: 'Local & feature branch development environment' },
    { name: 'Testing', type: 'testing', desc: 'Automated CI/CD & QA integration test suite' },
    { name: 'Staging', type: 'staging', desc: 'Pre-production canary & staging environment' },
    { name: 'Production', type: 'production', desc: 'Live customer-facing production environment' },
  ];

  for (const env of defaultEnvs) {
    db.environments.push({
      id: crypto.randomUUID(),
      project_id: projectId,
      name: env.name,
      type: env.type,
      description: env.desc,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  }

  // Create default main branch
  db.branches.push({
    id: crypto.randomUUID(),
    project_id: projectId,
    name: 'main',
    repository_ref: 'refs/heads/main',
    commit_sha: '5b15ecd',
    commit_message: 'Initial project configuration and environment setup',
    commit_date: now,
    is_active: true,
    is_synced: Boolean(repositoryUrl),
    created_at: now,
    updated_at: now,
  });

  if (includeStarterData) {
    db.branches.push({
      id: crypto.randomUUID(),
      project_id: projectId,
      name: 'feat/zero-knowledge-vault',
      repository_ref: 'refs/heads/feat/zero-knowledge-vault',
      commit_sha: 'c16d3f4',
      commit_message: 'Wire up AES-256-GCM secret encryption and workspace isolation',
      commit_date: now,
      is_active: true,
      is_synced: true,
      created_at: now,
      updated_at: now,
    });

    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 6 * 86400000).toISOString().split('T')[0];

    const starterTasks: {
      title: string;
      description: string;
      status: TaskStatus;
      priority: TaskPriority;
      due_date: string;
    }[] = [
      {
        title: 'Configure production environment secrets in Vault',
        description: 'Import .env variables and verify client-side AES-256-GCM encryption',
        status: 'todo',
        priority: 'high',
        due_date: tomorrow,
      },
      {
        title: 'Review workspace RBAC policies and invite team members',
        description: 'Ensure developers and admins have appropriate workspace access roles',
        status: 'in_progress',
        priority: 'medium',
        due_date: nextWeek,
      },
      {
        title: 'Initialize zero-knowledge project architecture',
        description: 'Set up Development, Testing, Staging, and Production environments',
        status: 'done',
        priority: 'critical',
        due_date: now.split('T')[0],
      },
    ];

    for (const t of starterTasks) {
      db.tasks.push({
        id: crypto.randomUUID(),
        project_id: projectId,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        assignee_id: ownerId,
        due_date: t.due_date,
        created_at: now,
        updated_at: now,
      });
    }
  }

  return project;
}

export type { LocalDatabaseSchema };
export { UserRole };
