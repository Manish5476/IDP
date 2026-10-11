import { supabase, isSupabaseConfigured } from '@/lib/supabase/client';
import {
  loadLocalDb,
  saveLocalDb,
  slugify,
  provisionProjectInDb,
  ensureUserProvisioned,
  markIdDeleted,
  isIdDeleted,
} from '@/lib/storage/localDb';
import type {
  Workspace,
  WorkspaceMember,
  Project,
  Profile,
  Environment,
  EncryptedSecret,
  Branch,
  Task,
  AuditEvent,
  IntegrationConnection,
  ProjectKeyEnvelope,
  WorkspaceInvitation,
  UserRole,
  EnvironmentType,
  TaskStatus,
  TaskPriority,
} from '@/types';

// ─── Workspaces ─────────────────────────────────────────────────────

export async function createWorkspace(
  name: string,
  description: string | null,
  ownerId: string
): Promise<Workspace> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const wsId = crypto.randomUUID();
  const baseSlug = slugify(name);
  const slug = db.workspaces.some(w => w.slug === baseSlug)
    ? `${baseSlug}-${wsId.slice(0, 5)}`
    : baseSlug;

  let createdWorkspace: Workspace = {
    id: wsId,
    name: name.trim(),
    slug,
    description: description?.trim() || null,
    owner_id: ownerId,
    is_archived: false,
    created_at: now,
    updated_at: now,
  };

  if (isSupabaseConfigured) {
    try {
      const { data: workspace, error } = await supabase
        .from('workspaces')
        .insert({ name: name.trim(), slug, description, owner_id: ownerId })
        .select()
        .single();

      if (!error && workspace) {
        createdWorkspace = workspace as Workspace;
        await supabase.from('workspace_members').upsert(
          {
            workspace_id: createdWorkspace.id,
            user_id: ownerId,
            role: 'owner',
          },
          { onConflict: 'workspace_id,user_id' }
        );
      }
    } catch {
      // Fallback to localDb below
    }
  }

  db.workspaces.unshift(createdWorkspace);
  if (!db.workspace_members.some(wm => wm.workspace_id === createdWorkspace.id && wm.user_id === ownerId)) {
    db.workspace_members.push({
      id: crypto.randomUUID(),
      workspace_id: createdWorkspace.id,
      user_id: ownerId,
      role: 'owner',
      joined_at: now,
    });
  }
  saveLocalDb(db);

  await logAuditEvent({
    actor_id: ownerId,
    action: 'workspace.created',
    resource_type: 'workspace',
    resource_id: createdWorkspace.id,
    workspace_id: createdWorkspace.id,
    outcome: 'success',
    metadata: { name: createdWorkspace.name },
  });

  return createdWorkspace;
}

export async function getWorkspaces(
  userId: string,
  userEmail?: string
): Promise<(Workspace & { member_role: UserRole })[]> {
  if (userEmail) {
    ensureUserProvisioned(userId, userEmail);
  }

  const db = loadLocalDb();
  const localMemberships = db.workspace_members.filter(wm => wm.user_id === userId);
  const localResult: (Workspace & { member_role: UserRole })[] = [];

  for (const m of localMemberships) {
    const ws = db.workspaces.find(
      w => w.id === m.workspace_id && !w.is_archived && !isIdDeleted(db, w.id)
    );
    if (ws) {
      localResult.push({ ...ws, member_role: m.role });
    }
  }

  if (isSupabaseConfigured) {
    try {
      const [{ data: memberData }, { data: ownedData }] = await Promise.all([
        supabase
          .from('workspace_members')
          .select(`
            workspace:workspaces(*),
            role
          `)
          .eq('user_id', userId),
        supabase
          .from('workspaces')
          .select('*')
          .eq('owner_id', userId)
          .eq('is_archived', false),
      ]);

      const remoteMap = new Map<string, Workspace & { member_role: UserRole }>();

      if (memberData) {
        for (const d of memberData) {
          if (d.workspace) {
            const ws = d.workspace as unknown as Workspace;
            if (!ws.is_archived && !isIdDeleted(db, ws.id)) {
              remoteMap.set(ws.id, { ...ws, member_role: d.role as UserRole });
            }
          }
        }
      }

      if (ownedData) {
        for (const ow of ownedData as Workspace[]) {
          if (!ow.is_archived && !isIdDeleted(db, ow.id) && !remoteMap.has(ow.id)) {
            remoteMap.set(ow.id, { ...ow, member_role: 'owner' });
            await supabase
              .from('workspace_members')
              .upsert(
                { workspace_id: ow.id, user_id: userId, role: 'owner' },
                { onConflict: 'workspace_id,user_id' }
              );
          }
        }
      }

      const remoteWorkspaces = Array.from(remoteMap.values());

      if (remoteWorkspaces.length > 0) {
        const mergedResult: (Workspace & { member_role: UserRole })[] = [];
        for (const rw of remoteWorkspaces) {
          const { member_role, ...wsOnly } = rw;
          const existingIdx = db.workspaces.findIndex(w => w.id === rw.id);
          let effectiveWs: Workspace = wsOnly;
          if (existingIdx >= 0) {
            const localWs = db.workspaces[existingIdx];
            if (localWs.is_archived) {
              continue;
            }
            effectiveWs =
              localWs.updated_at > wsOnly.updated_at
                ? localWs
                : wsOnly;
            db.workspaces[existingIdx] = effectiveWs;
          } else {
            db.workspaces.push(wsOnly);
          }
          if (!db.workspace_members.some(wm => wm.workspace_id === rw.id && wm.user_id === userId)) {
            db.workspace_members.push({
              id: crypto.randomUUID(),
              workspace_id: rw.id,
              user_id: userId,
              role: member_role,
              joined_at: rw.created_at,
            });
          }
          mergedResult.push({ ...effectiveWs, member_role });
        }
        saveLocalDb(db);
        if (mergedResult.length > 0) {
          return mergedResult;
        }
      } else if (localResult.length > 0) {
        const primary = localResult[0];
        const { data: syncedWs, error: syncErr } = await supabase
          .from('workspaces')
          .upsert(
            {
              id: primary.id,
              name: primary.name,
              slug: primary.slug,
              description: primary.description,
              owner_id: userId,
              is_archived: false,
            },
            { onConflict: 'id' }
          )
          .select()
          .single();

        if (!syncErr && syncedWs) {
          await supabase
            .from('workspace_members')
            .upsert(
              { workspace_id: syncedWs.id, user_id: userId, role: 'owner' },
              { onConflict: 'workspace_id,user_id' }
            );
          return [{ ...(syncedWs as Workspace), member_role: 'owner' }];
        }
      }
    } catch {
      // Return local user-scoped workspaces
    }
  }

  return localResult;
}

export async function updateWorkspace(id: string, updates: Partial<Workspace>): Promise<Workspace> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const idx = db.workspaces.findIndex(w => w.id === id);
  if (idx >= 0) {
    db.workspaces[idx] = { ...db.workspaces[idx], ...updates, updated_at: now };
    saveLocalDb(db);
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('workspaces')
        .update({ ...updates, updated_at: now })
        .eq('id', id)
        .select()
        .single();
      if (!error && data) {
        const updatedWs = data as Workspace;
        if (idx >= 0) {
          db.workspaces[idx] = updatedWs;
          saveLocalDb(db);
        }
        return updatedWs;
      }
    } catch {
      // Use local result
    }
  }

  if (idx < 0) throw new Error('Workspace not found');
  return db.workspaces[idx];
}

export async function archiveWorkspace(id: string, actorId?: string): Promise<Workspace> {
  const db = loadLocalDb();
  markIdDeleted(db, id);
  saveLocalDb(db);
  const updated = await updateWorkspace(id, { is_archived: true });
  if (actorId) {
    await logAuditEvent({
      actor_id: actorId,
      action: 'workspace.archived',
      resource_type: 'workspace',
      resource_id: id,
      workspace_id: id,
      outcome: 'success',
    });
  }
  return updated;
}

// ─── Workspace Members ──────────────────────────────────────────────

// ─── Profile Lookup Helper (Prevents PGRST200 on auth.users FK columns) ───

async function resolveProfilesByIds(
  rawIds: (string | null | undefined)[]
): Promise<Map<string, Profile>> {
  const db = loadLocalDb();
  const profileMap = new Map<string, Profile>();

  for (const p of db.profiles) {
    profileMap.set(p.id, p);
  }

  const uniqueIds = Array.from(
    new Set(rawIds.filter((id): id is string => Boolean(id && id.trim())))
  );

  if (isSupabaseConfigured && uniqueIds.length > 0) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .in('id', uniqueIds);
      if (!error && data) {
        let updatedLocal = false;
        for (const prof of data as Profile[]) {
          profileMap.set(prof.id, prof);
          const idx = db.profiles.findIndex(lp => lp.id === prof.id);
          if (idx >= 0) {
            db.profiles[idx] = prof;
          } else {
            db.profiles.push(prof);
          }
          updatedLocal = true;
        }
        if (updatedLocal) {
          saveLocalDb(db);
        }
      }
    } catch {
      // Fallback to local profileMap
    }
  }

  return profileMap;
}

// ─── Workspace Members ──────────────────────────────────────────────

export async function getWorkspaceMembers(
  workspaceId: string
): Promise<(WorkspaceMember & { profile: Profile | null })[]> {
  const db = loadLocalDb();
  const localMembers = db.workspace_members
    .filter(
      wm =>
        wm.workspace_id === workspaceId &&
        !isIdDeleted(db, wm.id) &&
        !isIdDeleted(db, `ws-member:${workspaceId}:${wm.user_id}`)
    )
    .map(wm => ({
      ...wm,
      profile: db.profiles.find(p => p.id === wm.user_id) || {
        id: wm.user_id,
        email: 'member@devportal.io',
        full_name: 'Workspace Member',
        avatar_url: null,
        created_at: wm.joined_at,
        updated_at: wm.joined_at,
      },
    }));

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('workspace_members')
        .select('*')
        .eq('workspace_id', workspaceId);
      if (!error && data && data.length > 0) {
        const rawMembers = (data as WorkspaceMember[]).filter(
          rm =>
            !isIdDeleted(db, rm.id) &&
            !isIdDeleted(db, `ws-member:${workspaceId}:${rm.user_id}`)
        );
        const profileMap = await resolveProfilesByIds(rawMembers.map(rm => rm.user_id));

        const remote: (WorkspaceMember & { profile: Profile | null })[] = rawMembers.map(rm => ({
          ...rm,
          profile: profileMap.get(rm.user_id) || {
            id: rm.user_id,
            email: 'member@devportal.io',
            full_name: 'Workspace Member',
            avatar_url: null,
            created_at: rm.joined_at,
            updated_at: rm.joined_at,
          },
        }));

        for (const rm of remote) {
          const localMatch = db.workspace_members.find(
            wm => wm.workspace_id === workspaceId && wm.user_id === rm.user_id
          );
          if (localMatch) {
            rm.role = localMatch.role;
          } else {
            db.workspace_members.push({
              id: rm.id,
              workspace_id: rm.workspace_id,
              user_id: rm.user_id,
              role: rm.role,
              joined_at: rm.joined_at,
            });
          }
        }
        saveLocalDb(db);
        const remoteUserIds = new Set(remote.map(r => r.user_id));
        return [...remote, ...localMembers.filter(lm => !remoteUserIds.has(lm.user_id))];
      }
    } catch {
      // Fallback to localMembers
    }
  }

  return localMembers;
}

export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: UserRole
): Promise<WorkspaceMember> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  db.deleted_ids = db.deleted_ids.filter(id => id !== `ws-member:${workspaceId}:${userId}`);

  const existing = db.workspace_members.find(
    wm => wm.workspace_id === workspaceId && wm.user_id === userId
  );
  if (existing) {
    existing.role = role;
    saveLocalDb(db);
    return existing;
  }

  const member: WorkspaceMember = {
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    user_id: userId,
    role,
    joined_at: now,
  };
  db.workspace_members.push(member);
  saveLocalDb(db);

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('workspace_members')
        .upsert(
          { workspace_id: workspaceId, user_id: userId, role },
          { onConflict: 'workspace_id,user_id' }
        )
        .select()
        .single();
      if (!error && data) {
        const remoteMember = data as WorkspaceMember;
        const idx = db.workspace_members.findIndex(wm => wm.id === member.id);
        if (idx >= 0) {
          db.workspace_members[idx] = remoteMember;
          saveLocalDb(db);
        }
        return remoteMember;
      }
    } catch {
      // Use local member
    }
  }
  return member;
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  const db = loadLocalDb();
  const targets = db.workspace_members.filter(
    wm => wm.workspace_id === workspaceId && wm.user_id === userId
  );
  for (const t of targets) {
    markIdDeleted(db, t.id);
  }
  markIdDeleted(db, `ws-member:${workspaceId}:${userId}`);
  db.workspace_members = db.workspace_members.filter(
    wm => !(wm.workspace_id === workspaceId && wm.user_id === userId)
  );
  saveLocalDb(db);

  if (isSupabaseConfigured) {
    try {
      await supabase
        .from('workspace_members')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId);
    } catch {
      // Handled locally
    }
  }
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: UserRole
): Promise<void> {
  const db = loadLocalDb();
  const member = db.workspace_members.find(
    wm => wm.workspace_id === workspaceId && wm.user_id === userId
  );
  if (member) {
    member.role = role;
    saveLocalDb(db);
  }

  if (isSupabaseConfigured) {
    try {
      await supabase
        .from('workspace_members')
        .update({ role })
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId);
    } catch {
      // Handled locally
    }
  }
}

// ─── Invitations ────────────────────────────────────────────────────

export async function createInvitation(
  workspaceId: string,
  email: string,
  role: UserRole,
  invitedBy: string
): Promise<WorkspaceInvitation> {
  const token = crypto.randomUUID();
  const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHashStr = Array.from(new Uint8Array(tokenHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const invitation: WorkspaceInvitation = {
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    email: email.trim().toLowerCase(),
    role,
    status: 'pending',
    token_hash: tokenHashStr,
    expires_at: expiresAt,
    created_at: now,
    invited_by: invitedBy,
  };

  const db = loadLocalDb();
  const matchingUser = db.users.find(u => u.email.toLowerCase() === invitation.email);
  if (matchingUser) {
    const alreadyInWs = db.workspace_members.some(
      wm => wm.workspace_id === workspaceId && wm.user_id === matchingUser.id
    );
    if (!alreadyInWs) {
      db.workspace_members.push({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        user_id: matchingUser.id,
        role,
        joined_at: now,
      });
      invitation.status = 'accepted';
    }
  }

  db.workspace_invitations.unshift(invitation);
  saveLocalDb(db);

  await logAuditEvent({
    actor_id: invitedBy,
    action: 'invitation.sent',
    resource_type: 'workspace_invitation',
    resource_id: invitation.id,
    workspace_id: workspaceId,
    outcome: 'success',
    metadata: { email: invitation.email, role },
  });

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('workspace_invitations')
        .insert({
          workspace_id: workspaceId,
          email: invitation.email,
          role,
          token_hash: tokenHashStr,
          expires_at: expiresAt,
          invited_by: invitedBy,
        })
        .select()
        .single();
      if (!error && data) {
        const remoteInv = data as WorkspaceInvitation;
        const idx = db.workspace_invitations.findIndex(i => i.id === invitation.id);
        if (idx >= 0) {
          db.workspace_invitations[idx] = remoteInv;
          saveLocalDb(db);
        }
        return remoteInv;
      }
    } catch {
      // Use local invitation
    }
  }

  return invitation;
}

export async function getPendingInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const db = loadLocalDb();
  const nowIso = new Date().toISOString();
  const localInvites = db.workspace_invitations.filter(
    inv =>
      inv.workspace_id === workspaceId &&
      inv.status === 'pending' &&
      inv.expires_at >= nowIso &&
      !isIdDeleted(db, inv.id)
  );

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('workspace_invitations')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .gte('expires_at', nowIso);
      if (!error && data && data.length > 0) {
        const remote = (data as WorkspaceInvitation[]).filter(inv => !isIdDeleted(db, inv.id));
        const remoteIds = new Set(remote.map(i => i.id));
        return [...remote, ...localInvites.filter(li => !remoteIds.has(li.id))];
      }
    } catch {
      // Return localInvites
    }
  }

  return localInvites;
}

export async function revokeInvitation(invitationId: string, actorId?: string): Promise<void> {
  const db = loadLocalDb();
  markIdDeleted(db, invitationId);
  const inv = db.workspace_invitations.find(i => i.id === invitationId);
  if (inv) {
    inv.status = 'revoked';
  }
  saveLocalDb(db);

  if (actorId && inv) {
    await logAuditEvent({
      actor_id: actorId,
      action: 'invitation.revoked',
      resource_type: 'workspace_invitation',
      resource_id: invitationId,
      workspace_id: inv.workspace_id,
      outcome: 'success',
    });
  }

  if (isSupabaseConfigured) {
    try {
      await supabase
        .from('workspace_invitations')
        .update({ status: 'revoked' })
        .eq('id', invitationId);
    } catch {
      // Handled locally
    }
  }
}

// ─── Projects ───────────────────────────────────────────────────────

function replaceLocalProjectId(
  localId: string,
  remoteProject: Project
): void {
  const db = loadLocalDb();
  const idx = db.projects.findIndex(p => p.id === localId);
  if (idx >= 0) {
    db.projects[idx] = remoteProject;
  } else if (!db.projects.some(p => p.id === remoteProject.id)) {
    db.projects.unshift(remoteProject);
  }
  if (localId !== remoteProject.id) {
    for (const pm of db.project_members) {
      if (pm.project_id === localId) pm.project_id = remoteProject.id;
    }
    for (const env of db.environments) {
      if (env.project_id === localId) env.project_id = remoteProject.id;
    }
    for (const br of db.branches) {
      if (br.project_id === localId) br.project_id = remoteProject.id;
    }
    for (const t of db.tasks) {
      if (t.project_id === localId) t.project_id = remoteProject.id;
    }
    db.projects = db.projects.filter(
      (p, i) => p.id !== localId && db.projects.findIndex(x => x.id === p.id) === i
    );
  }
  saveLocalDb(db);
}

export async function createProject(
  workspaceId: string,
  name: string,
  description: string | null,
  repositoryUrl: string | null,
  ownerId: string
): Promise<Project> {
  const db = loadLocalDb();
  let createdProject = provisionProjectInDb(
    db,
    workspaceId,
    name,
    description,
    repositoryUrl,
    ownerId,
    false
  );
  const provisionalLocalId = createdProject.id;
  saveLocalDb(db);

  if (isSupabaseConfigured) {
    try {
      // Ensure the workspace and owner membership row exist in Supabase first (prevents 42501 RLS violation on projects)
      const localWs = db.workspaces.find(w => w.id === workspaceId);
      if (localWs) {
        await supabase.from('workspaces').upsert(
          {
            id: localWs.id,
            name: localWs.name,
            slug: localWs.slug,
            description: localWs.description,
            owner_id: ownerId,
            is_archived: false,
          },
          { onConflict: 'id' }
        );
      }
      await supabase.from('workspace_members').upsert(
        {
          workspace_id: workspaceId,
          user_id: ownerId,
          role: 'owner',
        },
        { onConflict: 'workspace_id,user_id' }
      );

      const { data: rpcProject, error: rpcError } = await supabase.rpc('create_project_with_defaults', {
        p_workspace_id: workspaceId,
        p_name: name.trim(),
        p_description: description?.trim() || null,
        p_repository_url: repositoryUrl?.trim() || null,
      });

      if (!rpcError && rpcProject) {
        createdProject = rpcProject as Project;
        replaceLocalProjectId(provisionalLocalId, createdProject);
      } else {
        // Fallback to direct table insert if RPC migration was not applied
        const { data: directProject, error: directError } = await supabase
          .from('projects')
          .insert({
            workspace_id: workspaceId,
            name: name.trim(),
            slug: createdProject.slug,
            description: description?.trim() || null,
            repository_url: repositoryUrl?.trim() || null,
            owner_id: ownerId,
          })
          .select()
          .single();

        if (!directError && directProject) {
          createdProject = directProject as Project;
          replaceLocalProjectId(provisionalLocalId, createdProject);
          await supabase.from('project_members').upsert(
            {
              project_id: createdProject.id,
              user_id: ownerId,
              role: 'owner',
            },
            { onConflict: 'project_id,user_id' }
          );
          await supabase.from('environments').upsert(
            [
              { project_id: createdProject.id, name: 'Development', type: 'development' },
              { project_id: createdProject.id, name: 'Testing', type: 'testing' },
              { project_id: createdProject.id, name: 'Staging', type: 'staging' },
              { project_id: createdProject.id, name: 'Production', type: 'production' },
            ],
            { onConflict: 'project_id,name' }
          );
        }
      }
    } catch {
      // Local project already provisioned with all 4 default environments & main branch
    }
  }

  await logAuditEvent({
    actor_id: ownerId,
    action: 'project.created',
    resource_type: 'project',
    resource_id: createdProject.id,
    workspace_id: workspaceId,
    project_id: createdProject.id,
    outcome: 'success',
    metadata: { name: createdProject.name, slug: createdProject.slug },
  });

  return createdProject;
}

export async function getProjects(workspaceId?: string): Promise<Project[]> {
  const db = loadLocalDb();
  const filterProjects = (list: Project[]) =>
    list.filter(
      p =>
        !isIdDeleted(db, p.id) &&
        (!workspaceId || p.workspace_id === workspaceId)
    );

  if (isSupabaseConfigured) {
    try {
      let query = supabase.from('projects').select('*').order('created_at', { ascending: false });
      if (workspaceId) query = query.eq('workspace_id', workspaceId);
      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        const remote = (data as Project[]).filter(p => !isIdDeleted(db, p.id));
        const mergedRemote: Project[] = [];

        for (const rp of remote) {
          const localIdx = db.projects.findIndex(lp => lp.id === rp.id);
          if (localIdx >= 0) {
            const localProj = db.projects[localIdx];
            // Prefer local project state if it was updated more recently (e.g., edited/paused/archived while RLS was pending)
            const chosen =
              localProj.updated_at > rp.updated_at ? localProj : rp;
            db.projects[localIdx] = chosen;
            mergedRemote.push(chosen);
          } else {
            db.projects.push(rp);
            mergedRemote.push(rp);
          }
        }
        saveLocalDb(db);

        const remoteIds = new Set(mergedRemote.map(p => p.id));
        const remoteSlugs = new Set(mergedRemote.map(p => `${p.workspace_id}:${p.slug}`));
        const localExtras = filterProjects(db.projects).filter(
          lp => !remoteIds.has(lp.id) && !remoteSlugs.has(`${lp.workspace_id}:${lp.slug}`)
        );
        return [...mergedRemote, ...localExtras];
      }
    } catch {
      // Return localProjects below
    }
  }

  return filterProjects(db.projects);
}

export async function updateProject(
  id: string,
  updates: Partial<Project>,
  actorId?: string
): Promise<Project> {
  const now = new Date().toISOString();
  const normalizedUpdates: Partial<Project> = { ...updates };

  if (typeof normalizedUpdates.name === 'string' && !normalizedUpdates.slug) {
    const baseSlug = normalizedUpdates.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (baseSlug) {
      normalizedUpdates.slug = baseSlug;
    }
  }

  const db = loadLocalDb();
  let idx = db.projects.findIndex(p => p.id === id);
  let updatedLocal: Project | null = null;
  if (idx >= 0) {
    db.projects[idx] = { ...db.projects[idx], ...normalizedUpdates, updated_at: now };
    updatedLocal = db.projects[idx];
    saveLocalDb(db);
  }

  let finalProject: Project | null = updatedLocal;

  if (isSupabaseConfigured) {
    try {
      // Ensure workspace_members row exists before updating so legacy RLS policies succeed
      const wsId = updatedLocal?.workspace_id || updates.workspace_id;
      const uid = actorId || updatedLocal?.owner_id;
      if (wsId && uid) {
        await supabase.from('workspace_members').upsert(
          { workspace_id: wsId, user_id: uid, role: 'owner' },
          { onConflict: 'workspace_id,user_id' }
        );
      }

      // First try SECURITY DEFINER RPC if migration 005 is installed
      const { data: rpcData, error: rpcErr } = await supabase.rpc('update_project_safe', {
        p_project_id: id,
        p_name: normalizedUpdates.name ?? null,
        p_slug: normalizedUpdates.slug ?? null,
        p_description:
          normalizedUpdates.description !== undefined ? normalizedUpdates.description : null,
        p_repository_url:
          normalizedUpdates.repository_url !== undefined ? normalizedUpdates.repository_url : null,
        p_status: normalizedUpdates.status ?? null,
      });

      if (!rpcErr && rpcData) {
        finalProject = rpcData as Project;
      } else {
        const { data, error } = await supabase
          .from('projects')
          .update({ ...normalizedUpdates, updated_at: now })
          .eq('id', id)
          .select()
          .single();
        if (!error && data) {
          finalProject = data as Project;
        }
      }

      if (finalProject) {
        idx = db.projects.findIndex(p => p.id === id);
        if (idx >= 0) {
          db.projects[idx] = finalProject;
        } else {
          db.projects.unshift(finalProject);
        }
        saveLocalDb(db);
      }
    } catch {
      // Use local project
    }
  }

  if (!finalProject) {
    // Even if the project wasn't cached in localDb before and Supabase failed, synthesize and persist the updated record
    const fallbackProject: Project = {
      id,
      workspace_id: updates.workspace_id || db.workspaces[0]?.id || '',
      name: normalizedUpdates.name || 'Updated Project',
      slug: normalizedUpdates.slug || slugify(normalizedUpdates.name || 'updated-project'),
      description: normalizedUpdates.description ?? null,
      repository_url: normalizedUpdates.repository_url ?? null,
      status: normalizedUpdates.status || 'active',
      owner_id: actorId || db.currentSessionUserId || '',
      encryption_initialized: true,
      key_version: 1,
      created_at: now,
      updated_at: now,
    };
    db.projects.unshift(fallbackProject);
    saveLocalDb(db);
    finalProject = fallbackProject;
  }

  if (actorId) {
    await logAuditEvent({
      actor_id: actorId,
      action: 'project.updated',
      resource_type: 'project',
      resource_id: id,
      workspace_id: finalProject.workspace_id,
      project_id: id,
      outcome: 'success',
      metadata: {
        name: finalProject.name,
        repository_url: finalProject.repository_url,
        status: finalProject.status,
      },
    });
  }

  return finalProject;
}

export async function archiveProject(id: string, actorId?: string): Promise<Project> {
  const updated = await updateProject(id, { status: 'archived' }, actorId);
  if (actorId) {
    await logAuditEvent({
      actor_id: actorId,
      action: 'project.archived',
      resource_type: 'project',
      resource_id: id,
      workspace_id: updated.workspace_id,
      project_id: id,
      outcome: 'success',
    });
  }
  return updated;
}

export async function deleteProject(id: string, actorId?: string): Promise<void> {
  const db = loadLocalDb();
  const target = db.projects.find(p => p.id === id);

  // Record tombstone for project and all child resources so it never resurfaces from stale remote fetches
  markIdDeleted(db, id);
  for (const e of db.environments.filter(x => x.project_id === id)) markIdDeleted(db, e.id);
  for (const s of db.encrypted_secrets.filter(x => x.project_id === id)) markIdDeleted(db, s.id);
  for (const b of db.branches.filter(x => x.project_id === id)) markIdDeleted(db, b.id);
  for (const t of db.tasks.filter(x => x.project_id === id)) markIdDeleted(db, t.id);

  db.projects = db.projects.filter(p => p.id !== id);
  db.project_members = db.project_members.filter(pm => pm.project_id !== id);
  db.environments = db.environments.filter(e => e.project_id !== id);
  db.encrypted_secrets = db.encrypted_secrets.filter(s => s.project_id !== id);
  db.branches = db.branches.filter(b => b.project_id !== id);
  db.tasks = db.tasks.filter(t => t.project_id !== id);
  db.integration_connections = db.integration_connections.filter(i => i.project_id !== id);
  saveLocalDb(db);

  if (actorId) {
    await logAuditEvent({
      actor_id: actorId,
      action: 'project.deleted',
      resource_type: 'project',
      resource_id: id,
      workspace_id: target?.workspace_id,
      outcome: 'success',
      metadata: { name: target?.name || id },
    });
  }

  if (isSupabaseConfigured) {
    try {
      if (target?.workspace_id && (actorId || target.owner_id)) {
        await supabase.from('workspace_members').upsert(
          {
            workspace_id: target.workspace_id,
            user_id: actorId || target.owner_id,
            role: 'owner',
          },
          { onConflict: 'workspace_id,user_id' }
        );
      }
      // Try SECURITY DEFINER RPC first, then standard table DELETE
      await supabase.rpc('delete_project_safe', { p_project_id: id });
      await supabase.from('projects').delete().eq('id', id);
    } catch {
      // Handled locally via tombstone + localDb removal
    }
  }
}

// ─── Environments ───────────────────────────────────────────────────

export async function getEnvironments(projectId: string): Promise<Environment[]> {
  const db = loadLocalDb();
  let localEnvs = db.environments.filter(
    e => e.project_id === projectId && !isIdDeleted(db, e.id)
  );

  // If a project exists without environments, auto-provision the 4 standard environments
  if (localEnvs.length === 0 && projectId) {
    const now = new Date().toISOString();
    const defaults: { name: string; type: EnvironmentType; desc: string }[] = [
      { name: 'Development', type: 'development', desc: 'Local & feature branch development environment' },
      { name: 'Testing', type: 'testing', desc: 'Automated CI/CD & QA integration test suite' },
      { name: 'Staging', type: 'staging', desc: 'Pre-production canary & staging environment' },
      { name: 'Production', type: 'production', desc: 'Live customer-facing production environment' },
    ];
    localEnvs = defaults.map(d => ({
      id: crypto.randomUUID(),
      project_id: projectId,
      name: d.name,
      type: d.type,
      description: d.desc,
      is_active: true,
      created_at: now,
      updated_at: now,
    }));
    db.environments.push(...localEnvs);
    saveLocalDb(db);
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('environments')
        .select('*')
        .eq('project_id', projectId)
        .order('type');
      if (!error && data && data.length > 0) {
        const remote = (data as Environment[]).filter(e => !isIdDeleted(db, e.id));
        // Sync remote environment IDs into localDb (remapping any local secrets attached to provisional env IDs)
        for (const renv of remote) {
          const localMatchIdx = db.environments.findIndex(
            le => le.project_id === projectId && le.name.toLowerCase() === renv.name.toLowerCase()
          );
          if (localMatchIdx >= 0) {
            const oldId = db.environments[localMatchIdx].id;
            if (oldId !== renv.id) {
              for (const sec of db.encrypted_secrets) {
                if (sec.environment_id === oldId) {
                  sec.environment_id = renv.id;
                }
              }
            }
            db.environments[localMatchIdx] = renv;
          } else {
            db.environments.push(renv);
          }
        }
        saveLocalDb(db);
        const remoteNames = new Set(remote.map(r => r.name.toLowerCase()));
        const extras = db.environments.filter(
          le =>
            le.project_id === projectId &&
            !isIdDeleted(db, le.id) &&
            !remoteNames.has(le.name.toLowerCase())
        );
        return [...remote, ...extras];
      }
    } catch {
      // Return localEnvs
    }
  }

  return localEnvs;
}

export async function createEnvironment(
  projectId: string,
  name: string,
  type: EnvironmentType,
  description: string | null = null
): Promise<Environment> {
  const now = new Date().toISOString();
  const env: Environment = {
    id: crypto.randomUUID(),
    project_id: projectId,
    name: name.trim(),
    type,
    description,
    is_active: true,
    created_at: now,
    updated_at: now,
  };

  const db = loadLocalDb();
  db.environments.push(env);
  saveLocalDb(db);

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('environments')
        .insert({ project_id: projectId, name: env.name, type, description })
        .select()
        .single();
      if (!error && data) {
        const remoteEnv = data as Environment;
        const idx = db.environments.findIndex(e => e.id === env.id);
        if (idx >= 0) {
          db.environments[idx] = remoteEnv;
          saveLocalDb(db);
        }
        return remoteEnv;
      }
    } catch {
      // Use local env
    }
  }

  return env;
}

// ─── Secrets ────────────────────────────────────────────────────────

export async function getSecrets(environmentId: string): Promise<EncryptedSecret[]> {
  const db = loadLocalDb();
  const filterSecrets = (list: EncryptedSecret[]) =>
    list
      .filter(
        s =>
          s.environment_id === environmentId &&
          !isIdDeleted(db, s.id) &&
          !isIdDeleted(db, `secret:${environmentId}:${s.variable_name}`)
      )
      .sort((a, b) => a.variable_name.localeCompare(b.variable_name));

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('encrypted_secrets')
        .select('*')
        .eq('environment_id', environmentId)
        .order('variable_name');
      if (!error && data && data.length > 0) {
        const remote = (data as EncryptedSecret[]).filter(
          s =>
            !isIdDeleted(db, s.id) &&
            !isIdDeleted(db, `secret:${environmentId}:${s.variable_name}`)
        );
        const merged: EncryptedSecret[] = [];
        for (const rs of remote) {
          const localIdx = db.encrypted_secrets.findIndex(
            ls =>
              ls.id === rs.id ||
              (ls.environment_id === environmentId && ls.variable_name === rs.variable_name)
          );
          if (localIdx >= 0) {
            const localSec = db.encrypted_secrets[localIdx];
            const chosen = localSec.updated_at > rs.updated_at ? localSec : rs;
            db.encrypted_secrets[localIdx] = chosen;
            merged.push(chosen);
          } else {
            db.encrypted_secrets.push(rs);
            merged.push(rs);
          }
        }
        saveLocalDb(db);
        const remoteNames = new Set(merged.map(s => s.variable_name));
        const localExtras = filterSecrets(db.encrypted_secrets).filter(
          ls => !remoteNames.has(ls.variable_name)
        );
        return [...merged, ...localExtras].sort((a, b) =>
          a.variable_name.localeCompare(b.variable_name)
        );
      }
    } catch {
      // Return localSecrets
    }
  }

  return filterSecrets(db.encrypted_secrets);
}

export async function getProjectSecretCounts(projectId: string): Promise<Record<string, number>> {
  const db = loadLocalDb();
  const counts: Record<string, number> = {};
  for (const s of db.encrypted_secrets) {
    if (
      s.project_id === projectId &&
      !isIdDeleted(db, s.id) &&
      !isIdDeleted(db, `secret:${s.environment_id}:${s.variable_name}`)
    ) {
      counts[s.environment_id] = (counts[s.environment_id] || 0) + 1;
    }
  }
  return counts;
}

export async function createSecret(
  environmentId: string,
  projectId: string,
  variableName: string,
  encryptedValue: string,
  nonce: string,
  keyVersion: number,
  actorId?: string
): Promise<EncryptedSecret> {
  const now = new Date().toISOString();
  const cleanName = variableName.trim();
  const db = loadLocalDb();

  // Clear any previous tombstone for this variable name in this environment
  db.deleted_ids = db.deleted_ids.filter(id => id !== `secret:${environmentId}:${cleanName}`);

  // Upsert if variable_name already exists in this environment
  const existingIdx = db.encrypted_secrets.findIndex(
    s => s.environment_id === environmentId && s.variable_name === cleanName
  );

  let secretRecord: EncryptedSecret;
  if (existingIdx >= 0) {
    secretRecord = {
      ...db.encrypted_secrets[existingIdx],
      encrypted_value: encryptedValue,
      nonce,
      key_version: keyVersion,
      updated_at: now,
    };
    db.encrypted_secrets[existingIdx] = secretRecord;
  } else {
    secretRecord = {
      id: crypto.randomUUID(),
      environment_id: environmentId,
      project_id: projectId,
      variable_name: cleanName,
      encrypted_value: encryptedValue,
      nonce,
      crypto_version: '1',
      key_version: keyVersion,
      is_secret: true,
      created_at: now,
      updated_at: now,
    };
    db.encrypted_secrets.push(secretRecord);
  }
  saveLocalDb(db);

  if (actorId) {
    const project = db.projects.find(p => p.id === projectId);
    await logAuditEvent({
      actor_id: actorId,
      action: existingIdx >= 0 ? 'secret.updated' : 'secret.created',
      resource_type: 'encrypted_secret',
      resource_id: secretRecord.id,
      workspace_id: project?.workspace_id,
      project_id: projectId,
      outcome: 'success',
      metadata: { variable_name: cleanName },
    });
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('encrypted_secrets')
        .upsert(
          {
            environment_id: environmentId,
            project_id: projectId,
            variable_name: cleanName,
            encrypted_value: encryptedValue,
            nonce,
            key_version: keyVersion,
          },
          { onConflict: 'environment_id,variable_name' }
        )
        .select()
        .single();
      if (!error && data) {
        const remoteSecret = data as EncryptedSecret;
        const idx = db.encrypted_secrets.findIndex(s => s.id === secretRecord.id);
        if (idx >= 0) {
          db.encrypted_secrets[idx] = remoteSecret;
          saveLocalDb(db);
        }
        return remoteSecret;
      }
    } catch {
      // Use local secretRecord
    }
  }

  return secretRecord;
}

export async function deleteSecret(id: string, actorId?: string): Promise<void> {
  const db = loadLocalDb();
  const target = db.encrypted_secrets.find(s => s.id === id);
  markIdDeleted(db, id);
  if (target) {
    markIdDeleted(db, `secret:${target.environment_id}:${target.variable_name}`);
  }
  db.encrypted_secrets = db.encrypted_secrets.filter(s => s.id !== id);
  saveLocalDb(db);

  if (actorId && target) {
    const project = db.projects.find(p => p.id === target.project_id);
    await logAuditEvent({
      actor_id: actorId,
      action: 'secret.deleted',
      resource_type: 'encrypted_secret',
      resource_id: id,
      workspace_id: project?.workspace_id,
      project_id: target.project_id,
      outcome: 'success',
      metadata: { variable_name: target.variable_name },
    });
  }

  if (isSupabaseConfigured) {
    try {
      await supabase.from('encrypted_secrets').delete().eq('id', id);
    } catch {
      // Handled locally
    }
  }
}

// ─── Branches ───────────────────────────────────────────────────────

export async function getBranches(projectId: string): Promise<Branch[]> {
  const db = loadLocalDb();
  const filterBranches = (list: Branch[]) =>
    list
      .filter(
        b =>
          b.project_id === projectId &&
          !isIdDeleted(db, b.id) &&
          !isIdDeleted(db, `branch:${projectId}:${b.name}`)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('branches')
        .select('*')
        .eq('project_id', projectId)
        .order('updated_at', { ascending: false });
      if (!error && data && data.length > 0) {
        const remote = (data as Branch[]).filter(
          b => !isIdDeleted(db, b.id) && !isIdDeleted(db, `branch:${projectId}:${b.name}`)
        );
        const merged: Branch[] = [];
        for (const rb of remote) {
          const localIdx = db.branches.findIndex(
            lb => lb.id === rb.id || (lb.project_id === projectId && lb.name === rb.name)
          );
          if (localIdx >= 0) {
            const localBr = db.branches[localIdx];
            const chosen = localBr.updated_at > rb.updated_at ? localBr : rb;
            db.branches[localIdx] = chosen;
            merged.push(chosen);
          } else {
            db.branches.push(rb);
            merged.push(rb);
          }
        }
        saveLocalDb(db);
        const remoteNames = new Set(merged.map(b => b.name));
        const localExtras = filterBranches(db.branches).filter(lb => !remoteNames.has(lb.name));
        return [...merged, ...localExtras].sort((a, b) =>
          b.updated_at.localeCompare(a.updated_at)
        );
      }
    } catch {
      // Return localBranches
    }
  }

  return filterBranches(db.branches);
}

export async function createBranch(
  projectId: string,
  name: string,
  repositoryRef?: string,
  commitMessage?: string,
  actorId?: string
): Promise<Branch> {
  const now = new Date().toISOString();
  const cleanName = name.trim();
  const sha = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 7);

  const branch: Branch = {
    id: crypto.randomUUID(),
    project_id: projectId,
    name: cleanName,
    repository_ref: repositoryRef?.trim() || `refs/heads/${cleanName}`,
    commit_sha: sha,
    commit_message: commitMessage?.trim() || `Initialize branch ${cleanName}`,
    commit_date: now,
    is_active: true,
    is_synced: true,
    created_at: now,
    updated_at: now,
  };

  const db = loadLocalDb();
  db.deleted_ids = db.deleted_ids.filter(id => id !== `branch:${projectId}:${cleanName}`);
  db.branches.unshift(branch);
  saveLocalDb(db);

  if (actorId) {
    const project = db.projects.find(p => p.id === projectId);
    await logAuditEvent({
      actor_id: actorId,
      action: 'branch.created',
      resource_type: 'branch',
      resource_id: branch.id,
      workspace_id: project?.workspace_id,
      project_id: projectId,
      outcome: 'success',
      metadata: { branch_name: cleanName },
    });
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('branches')
        .upsert(
          {
            project_id: projectId,
            name: cleanName,
            repository_ref: branch.repository_ref,
            commit_sha: branch.commit_sha,
            commit_message: branch.commit_message,
            commit_date: now,
            is_active: true,
            is_synced: true,
          },
          { onConflict: 'project_id,name' }
        )
        .select()
        .single();
      if (!error && data) {
        const remoteBranch = data as Branch;
        const idx = db.branches.findIndex(b => b.id === branch.id);
        if (idx >= 0) {
          db.branches[idx] = remoteBranch;
          saveLocalDb(db);
        }
        return remoteBranch;
      }
    } catch {
      // Return local branch
    }
  }

  return branch;
}

export async function updateBranch(id: string, updates: Partial<Branch>): Promise<Branch> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const idx = db.branches.findIndex(b => b.id === id);
  if (idx >= 0) {
    db.branches[idx] = { ...db.branches[idx], ...updates, updated_at: now };
    saveLocalDb(db);
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('branches')
        .update({ ...updates, updated_at: now })
        .eq('id', id)
        .select()
        .single();
      if (!error && data) {
        const remoteBranch = data as Branch;
        if (idx >= 0) {
          db.branches[idx] = remoteBranch;
          saveLocalDb(db);
        }
        return remoteBranch;
      }
    } catch {
      // Use local branch
    }
  }

  if (idx < 0) throw new Error('Branch not found');
  return db.branches[idx];
}

export async function deleteBranch(id: string, actorId?: string): Promise<void> {
  const db = loadLocalDb();
  const target = db.branches.find(b => b.id === id);
  markIdDeleted(db, id);
  if (target) {
    markIdDeleted(db, `branch:${target.project_id}:${target.name}`);
  }
  db.branches = db.branches.filter(b => b.id !== id);
  saveLocalDb(db);

  if (actorId && target) {
    const project = db.projects.find(p => p.id === target.project_id);
    await logAuditEvent({
      actor_id: actorId,
      action: 'branch.deleted',
      resource_type: 'branch',
      resource_id: id,
      workspace_id: project?.workspace_id,
      project_id: target.project_id,
      outcome: 'success',
      metadata: { branch_name: target.name },
    });
  }

  if (isSupabaseConfigured) {
    try {
      await supabase.from('branches').delete().eq('id', id);
    } catch {
      // Handled locally
    }
  }
}

// ─── Tasks ──────────────────────────────────────────────────────────

export async function getTasks(
  projectId?: string,
  status?: TaskStatus,
  workspaceId?: string
): Promise<Task[]> {
  const db = loadLocalDb();
  const getFilteredLocal = () => {
    let filtered = db.tasks.filter(t => !isIdDeleted(db, t.id));
    if (projectId) {
      filtered = filtered.filter(t => t.project_id === projectId);
    } else if (workspaceId) {
      const wsProjectIds = new Set(
        db.projects
          .filter(p => p.workspace_id === workspaceId && !isIdDeleted(db, p.id))
          .map(p => p.id)
      );
      filtered = filtered.filter(t => wsProjectIds.has(t.project_id));
    }
    if (status) {
      filtered = filtered.filter(t => t.status === status);
    }
    return filtered
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(t => ({
        ...t,
        assignee: t.assignee_id ? db.profiles.find(p => p.id === t.assignee_id) : undefined,
      }));
  };

  if (isSupabaseConfigured && projectId) {
    try {
      let query = supabase
        .from('tasks')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        const remote = (data as Task[]).filter(t => !isIdDeleted(db, t.id));
        const profileMap = await resolveProfilesByIds(remote.map(rt => rt.assignee_id));
        const merged: Task[] = [];
        for (const rt of remote) {
          const enriched: Task = {
            ...rt,
            assignee: rt.assignee_id ? profileMap.get(rt.assignee_id) : undefined,
          };
          const localIdx = db.tasks.findIndex(lt => lt.id === enriched.id);
          if (localIdx >= 0) {
            const localTask = db.tasks[localIdx];
            const chosen =
              localTask.updated_at > enriched.updated_at
                ? {
                    ...localTask,
                    assignee: localTask.assignee_id
                      ? profileMap.get(localTask.assignee_id)
                      : undefined,
                  }
                : enriched;
            db.tasks[localIdx] = chosen;
            merged.push(chosen);
          } else {
            db.tasks.push(enriched);
            merged.push(enriched);
          }
        }
        saveLocalDb(db);
        const remoteIds = new Set(merged.map(t => t.id));
        const localExtras = getFilteredLocal().filter(lt => !remoteIds.has(lt.id));
        return [...merged, ...localExtras];
      }
    } catch {
      // Return localTasks
    }
  }

  return getFilteredLocal();
}

export async function createTask(
  projectId: string,
  title: string,
  description: string | null,
  priority: TaskPriority = 'medium',
  options?: {
    status?: TaskStatus;
    due_date?: string | null;
    assignee_id?: string | null;
    actor_id?: string;
  }
): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    project_id: projectId,
    title: title.trim(),
    description: description?.trim() || null,
    status: options?.status || 'todo',
    priority,
    assignee_id: options?.assignee_id || options?.actor_id || null,
    due_date: options?.due_date || null,
    created_at: now,
    updated_at: now,
  };

  const db = loadLocalDb();
  db.tasks.unshift(task);
  saveLocalDb(db);

  if (options?.actor_id) {
    const project = db.projects.find(p => p.id === projectId);
    await logAuditEvent({
      actor_id: options.actor_id,
      action: 'task.created',
      resource_type: 'task',
      resource_id: task.id,
      workspace_id: project?.workspace_id,
      project_id: projectId,
      outcome: 'success',
      metadata: { title: task.title, priority, status: task.status },
    });
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .insert({
          project_id: projectId,
          title: task.title,
          description: task.description,
          priority,
          status: task.status,
          due_date: task.due_date,
          assignee_id: task.assignee_id,
        })
        .select()
        .single();
      if (!error && data) {
        const remoteTask = data as Task;
        const idx = db.tasks.findIndex(t => t.id === task.id);
        if (idx >= 0) {
          db.tasks[idx] = remoteTask;
          saveLocalDb(db);
        }
        return remoteTask;
      }
    } catch {
      // Return local task
    }
  }

  return task;
}

export async function updateTask(
  id: string,
  updates: Partial<Task>,
  actorId?: string
): Promise<Task> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const idx = db.tasks.findIndex(t => t.id === id);
  if (idx >= 0) {
    db.tasks[idx] = { ...db.tasks[idx], ...updates, updated_at: now };
    saveLocalDb(db);

    if (actorId && updates.status) {
      const project = db.projects.find(p => p.id === db.tasks[idx].project_id);
      await logAuditEvent({
        actor_id: actorId,
        action: `task.status.${updates.status}`,
        resource_type: 'task',
        resource_id: id,
        workspace_id: project?.workspace_id,
        project_id: db.tasks[idx].project_id,
        outcome: 'success',
        metadata: { title: db.tasks[idx].title, status: updates.status },
      });
    }
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .update({ ...updates, updated_at: now })
        .eq('id', id)
        .select()
        .single();
      if (!error && data) {
        const remoteTask = data as Task;
        if (idx >= 0) {
          db.tasks[idx] = remoteTask;
          saveLocalDb(db);
        }
        return remoteTask;
      }
    } catch {
      // Return local task
    }
  }

  if (idx < 0) throw new Error('Task not found');
  return db.tasks[idx];
}

export async function deleteTask(id: string, actorId?: string): Promise<void> {
  const db = loadLocalDb();
  const target = db.tasks.find(t => t.id === id);
  markIdDeleted(db, id);
  db.tasks = db.tasks.filter(t => t.id !== id);
  saveLocalDb(db);

  if (actorId && target) {
    const project = db.projects.find(p => p.id === target.project_id);
    await logAuditEvent({
      actor_id: actorId,
      action: 'task.deleted',
      resource_type: 'task',
      resource_id: id,
      workspace_id: project?.workspace_id,
      project_id: target.project_id,
      outcome: 'success',
      metadata: { title: target.title },
    });
  }

  if (isSupabaseConfigured) {
    try {
      await supabase.from('tasks').delete().eq('id', id);
    } catch {
      // Handled locally
    }
  }
}

// ─── Audit Events ───────────────────────────────────────────────────

export async function logAuditEvent(event: {
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  workspace_id?: string;
  project_id?: string;
  outcome?: 'success' | 'failure';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const record: AuditEvent = {
    id: crypto.randomUUID(),
    actor_id: event.actor_id,
    action: event.action,
    resource_type: event.resource_type,
    resource_id: event.resource_id || null,
    workspace_id: event.workspace_id || null,
    project_id: event.project_id || null,
    outcome: event.outcome || 'success',
    metadata: event.metadata || {},
    created_at: now,
  };
  db.audit_events.unshift(record);
  if (db.audit_events.length > 250) {
    db.audit_events = db.audit_events.slice(0, 250);
  }
  saveLocalDb(db);

  if (isSupabaseConfigured) {
    try {
      await supabase.from('audit_events').insert({
        ...event,
        outcome: event.outcome || 'success',
        metadata: event.metadata || {},
      });
    } catch {
      // Saved locally
    }
  }
}

export async function getAuditEvents(
  workspaceId?: string,
  limit = 50
): Promise<AuditEvent[]> {
  const db = loadLocalDb();
  const localEvents: AuditEvent[] = db.audit_events
    .filter(ev => !workspaceId || ev.workspace_id === workspaceId || ev.workspace_id === null)
    .slice(0, limit)
    .map(ev => ({
      ...ev,
      actor: ev.actor_id ? db.profiles.find(p => p.id === ev.actor_id) : undefined,
    }));

  if (isSupabaseConfigured) {
    try {
      let query = supabase
        .from('audit_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (workspaceId) query = query.eq('workspace_id', workspaceId);

      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        const rawEvents = data as AuditEvent[];
        const profileMap = await resolveProfilesByIds(rawEvents.map(ev => ev.actor_id));
        return rawEvents.map(ev => ({
          ...ev,
          actor: ev.actor_id ? profileMap.get(ev.actor_id) : undefined,
        }));
      }
    } catch {
      // Return localEvents
    }
  }

  return localEvents;
}

// ─── Project Key Envelopes ──────────────────────────────────────────

export async function getProjectKeyEnvelope(
  projectId: string,
  userId: string
): Promise<ProjectKeyEnvelope | null> {
  const db = loadLocalDb();
  const localEnv = db.project_key_envelopes.find(
    e => e.project_id === projectId && e.user_id === userId
  );

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('project_key_envelopes')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!error && data) return data as ProjectKeyEnvelope;
    } catch {
      // Return localEnv
    }
  }

  return localEnv || null;
}

export async function storeProjectKeyEnvelope(
  projectId: string,
  userId: string,
  encryptedProjectKey: string,
  keyVersion: number
): Promise<ProjectKeyEnvelope> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const existingIdx = db.project_key_envelopes.findIndex(
    e => e.project_id === projectId && e.user_id === userId
  );
  const record: ProjectKeyEnvelope = {
    id: existingIdx >= 0 ? db.project_key_envelopes[existingIdx].id : crypto.randomUUID(),
    project_id: projectId,
    user_id: userId,
    encrypted_project_key: encryptedProjectKey,
    key_version: keyVersion,
    created_at: existingIdx >= 0 ? db.project_key_envelopes[existingIdx].created_at : now,
    updated_at: now,
  };

  if (existingIdx >= 0) db.project_key_envelopes[existingIdx] = record;
  else db.project_key_envelopes.push(record);
  saveLocalDb(db);

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('project_key_envelopes')
        .upsert({
          project_id: projectId,
          user_id: userId,
          encrypted_project_key: encryptedProjectKey,
          key_version: keyVersion,
        })
        .select()
        .single();
      if (!error && data) return data as ProjectKeyEnvelope;
    } catch {
      // Return local record
    }
  }

  return record;
}

// ─── Integrations ───────────────────────────────────────────────────

export async function getProjectIntegrations(projectId: string): Promise<IntegrationConnection[]> {
  const db = loadLocalDb();
  const localInt = db.integration_connections.filter(i => i.project_id === projectId);

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('integration_connections')
        .select('*')
        .eq('project_id', projectId);
      if (!error && data && data.length > 0) {
        return data as IntegrationConnection[];
      }
    } catch {
      // Return localInt
    }
  }

  return localInt;
}

export async function getIntegration(
  projectId: string,
  provider: string
): Promise<IntegrationConnection | null> {
  const list = await getProjectIntegrations(projectId);
  return list.find(i => i.provider === provider) || null;
}

export async function updateIntegrationStatus(
  projectId: string,
  provider: 'github' | 'gitlab' | 'jira' | 'slack',
  status: 'connected' | 'disconnected' | 'error' | 'setup_required',
  options?: {
    scopes?: string[];
    metadata?: Record<string, unknown>;
    error?: string;
    actorId?: string;
  }
): Promise<IntegrationConnection> {
  const now = new Date().toISOString();
  const db = loadLocalDb();
  const idx = db.integration_connections.findIndex(
    i => i.project_id === projectId && i.provider === provider
  );

  const record: IntegrationConnection = {
    id: idx >= 0 ? db.integration_connections[idx].id : crypto.randomUUID(),
    project_id: projectId,
    provider,
    status,
    scopes: options?.scopes || (idx >= 0 ? db.integration_connections[idx].scopes : ['repo:read', 'commits:sync']),
    last_sync_at: status === 'connected' ? now : (idx >= 0 ? db.integration_connections[idx].last_sync_at : null),
    last_error: options?.error || null,
    metadata: options?.metadata || (idx >= 0 ? db.integration_connections[idx].metadata : {}),
    created_at: idx >= 0 ? db.integration_connections[idx].created_at : now,
    updated_at: now,
  };

  if (idx >= 0) db.integration_connections[idx] = record;
  else db.integration_connections.push(record);
  saveLocalDb(db);

  if (options?.actorId) {
    const project = db.projects.find(p => p.id === projectId);
    await logAuditEvent({
      actor_id: options.actorId,
      action: `integration.${provider}.${status}`,
      resource_type: 'integration_connection',
      resource_id: record.id,
      workspace_id: project?.workspace_id,
      project_id: projectId,
      outcome: status === 'error' ? 'failure' : 'success',
      metadata: { provider, status, ...options.metadata },
    });
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error: dbError } = await supabase
        .from('integration_connections')
        .upsert({
          project_id: projectId,
          provider,
          status,
          scopes: record.scopes,
          metadata: record.metadata,
          last_error: record.last_error,
          last_sync_at: record.last_sync_at,
        })
        .select()
        .single();
      if (!dbError && data) return data as IntegrationConnection;
    } catch {
      // Return local record
    }
  }

  return record;
}
