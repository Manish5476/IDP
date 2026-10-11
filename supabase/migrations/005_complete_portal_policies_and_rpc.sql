-- Supabase Migration: 005_complete_portal_policies_and_rpc.sql
-- Complete Master Migration for DevPortal IDP
-- Fixes:
--   1. Error 42501 ('new row violates row-level security policy for table "projects"') on Create / Edit / Pause / Archive
--   2. Silent 204 No Content with 0 rows deleted on Project / Branch / Task / Secret / Member DELETE
--   3. Missing workspace_members owner rows on existing workspaces & trigger for new workspaces
--   4. Atomic SECURITY DEFINER RPCs for create_project_with_defaults, update_project_safe, and delete_project_safe
-- Safe and idempotent to run in the Supabase SQL Editor at any time.

-- ─── 1. Automatic Profile Creation & Backfill ───────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO public.profiles (id, email, full_name)
SELECT id, email, raw_user_meta_data ->> 'full_name'
FROM auth.users
WHERE email IS NOT NULL
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ─── 2. Workspace Owner Membership Backfill & Auto-Trigger ──────────
INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT w.id, w.owner_id, 'owner'
FROM public.workspaces w
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner';

CREATE OR REPLACE FUNCTION public.handle_new_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (NEW.id, NEW.owner_id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_workspace_created ON public.workspaces;
CREATE TRIGGER on_workspace_created
  AFTER INSERT ON public.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_workspace();

-- Backfill project_members and 4 default environments for any existing projects
INSERT INTO public.project_members (project_id, user_id, role)
SELECT p.id, p.owner_id, 'owner'
FROM public.projects p
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO public.environments (project_id, name, type)
SELECT p.id, env.name, env.type
FROM public.projects p
CROSS JOIN (
  VALUES
    ('Development', 'development'),
    ('Testing', 'testing'),
    ('Staging', 'staging'),
    ('Production', 'production')
) AS env(name, type)
ON CONFLICT (project_id, name) DO NOTHING;

-- ─── 3. Non-Recursive Workspace & Project Role Helpers ──────────────
CREATE OR REPLACE FUNCTION public.has_workspace_role(
  target_workspace_id UUID,
  allowed_roles TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.workspace_members AS wm
      WHERE wm.workspace_id = target_workspace_id
        AND wm.user_id = (SELECT auth.uid())
        AND wm.role = ANY (allowed_roles)
    )
    OR EXISTS (
      SELECT 1
      FROM public.workspaces AS w
      WHERE w.id = target_workspace_id
        AND w.owner_id = (SELECT auth.uid())
    );
$$;

REVOKE ALL ON FUNCTION public.has_workspace_role(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_workspace_role(UUID, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_workspace_role(UUID, TEXT[]) TO service_role;

CREATE OR REPLACE FUNCTION public.has_project_access(
  target_project_id UUID,
  allowed_roles TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects AS p
    WHERE p.id = target_project_id
      AND (
        p.owner_id = (SELECT auth.uid())
        OR public.has_workspace_role(p.workspace_id, allowed_roles)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.has_project_access(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_project_access(UUID, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_project_access(UUID, TEXT[]) TO service_role;

-- ─── 4. Reset & Recreate Full CRUD RLS Policies on All Tables ───────
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'workspaces',
        'workspace_members',
        'workspace_invitations',
        'projects',
        'project_members',
        'project_key_envelopes',
        'environments',
        'encrypted_secrets',
        'branches',
        'tasks',
        'integration_connections',
        'audit_events'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END;
$$;

-- Workspaces policies
CREATE POLICY "workspaces_select_members" ON public.workspaces
  FOR SELECT USING (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "workspaces_insert_auth" ON public.workspaces
  FOR INSERT WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY "workspaces_update_admin" ON public.workspaces
  FOR UPDATE
  USING (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(id, ARRAY['owner', 'admin']::TEXT[])
  )
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(id, ARRAY['owner', 'admin']::TEXT[])
  );

CREATE POLICY "workspaces_delete_owner" ON public.workspaces
  FOR DELETE USING (owner_id = (SELECT auth.uid()));

-- Workspace Members policies
CREATE POLICY "workspace_members_select" ON public.workspace_members
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
    OR public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[]
    )
  );

CREATE POLICY "workspace_members_insert_admin" ON public.workspace_members
  FOR INSERT WITH CHECK (
    user_id = (SELECT auth.uid())
    OR public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[])
  );

CREATE POLICY "workspace_members_update_owner" ON public.workspace_members
  FOR UPDATE
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[]));

CREATE POLICY "workspace_members_delete_admin" ON public.workspace_members
  FOR DELETE USING (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[])
  );

-- Workspace Invitations policies
CREATE POLICY "workspace_invitations_select" ON public.workspace_invitations
  FOR SELECT USING (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[]
    )
  );

CREATE POLICY "workspace_invitations_insert_admin" ON public.workspace_invitations
  FOR INSERT WITH CHECK (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[])
  );

CREATE POLICY "workspace_invitations_update_admin" ON public.workspace_invitations
  FOR UPDATE
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[]));

CREATE POLICY "workspace_invitations_delete_admin" ON public.workspace_invitations
  FOR DELETE USING (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::TEXT[])
  );

-- Projects policies (Fixes 42501 on INSERT/UPDATE and silent 204 on DELETE)
CREATE POLICY "projects_select_members" ON public.projects
  FOR SELECT USING (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[]
    )
  );

CREATE POLICY "projects_insert_members" ON public.projects
  FOR INSERT WITH CHECK (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer']::TEXT[]
    )
  );

CREATE POLICY "projects_update_members" ON public.projects
  FOR UPDATE
  USING (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer']::TEXT[]
    )
  )
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer']::TEXT[]
    )
  );

CREATE POLICY "projects_delete_members" ON public.projects
  FOR DELETE USING (
    owner_id = (SELECT auth.uid())
    OR public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'developer']::TEXT[]
    )
  );

-- Project Members policies
CREATE POLICY "project_members_select" ON public.project_members
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "project_members_insert" ON public.project_members
  FOR INSERT WITH CHECK (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "project_members_update" ON public.project_members
  FOR UPDATE
  USING (public.has_project_access(project_id, ARRAY['owner', 'admin']::TEXT[]))
  WITH CHECK (public.has_project_access(project_id, ARRAY['owner', 'admin']::TEXT[]));

CREATE POLICY "project_members_delete" ON public.project_members
  FOR DELETE USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin']::TEXT[])
  );

-- Project Key Envelopes policies
CREATE POLICY "project_key_envelopes_select_own" ON public.project_key_envelopes
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin']::TEXT[])
  );

CREATE POLICY "project_key_envelopes_insert_admin" ON public.project_key_envelopes
  FOR INSERT WITH CHECK (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "project_key_envelopes_update_admin" ON public.project_key_envelopes
  FOR UPDATE
  USING (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "project_key_envelopes_delete_admin" ON public.project_key_envelopes
  FOR DELETE USING (
    user_id = (SELECT auth.uid())
    OR public.has_project_access(project_id, ARRAY['owner', 'admin']::TEXT[])
  );

-- Environments policies
CREATE POLICY "environments_select" ON public.environments
  FOR SELECT USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "environments_insert" ON public.environments
  FOR INSERT WITH CHECK (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "environments_update" ON public.environments
  FOR UPDATE
  USING (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]))
  WITH CHECK (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]));

CREATE POLICY "environments_delete" ON public.environments
  FOR DELETE USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

-- Encrypted Secrets policies
CREATE POLICY "encrypted_secrets_select" ON public.encrypted_secrets
  FOR SELECT USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "encrypted_secrets_insert" ON public.encrypted_secrets
  FOR INSERT WITH CHECK (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "encrypted_secrets_update" ON public.encrypted_secrets
  FOR UPDATE
  USING (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]))
  WITH CHECK (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]));

CREATE POLICY "encrypted_secrets_delete" ON public.encrypted_secrets
  FOR DELETE USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

-- Branches policies
CREATE POLICY "branches_select" ON public.branches
  FOR SELECT USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "branches_insert" ON public.branches
  FOR INSERT WITH CHECK (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "branches_update" ON public.branches
  FOR UPDATE
  USING (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]))
  WITH CHECK (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]));

CREATE POLICY "branches_delete" ON public.branches
  FOR DELETE USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

-- Tasks policies
CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "tasks_insert" ON public.tasks
  FOR INSERT WITH CHECK (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "tasks_update" ON public.tasks
  FOR UPDATE
  USING (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]))
  WITH CHECK (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]));

CREATE POLICY "tasks_delete" ON public.tasks
  FOR DELETE USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

-- Integration Connections policies
CREATE POLICY "integration_connections_select" ON public.integration_connections
  FOR SELECT USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[])
  );

CREATE POLICY "integration_connections_insert" ON public.integration_connections
  FOR INSERT WITH CHECK (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

CREATE POLICY "integration_connections_update" ON public.integration_connections
  FOR UPDATE
  USING (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]))
  WITH CHECK (public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[]));

CREATE POLICY "integration_connections_delete" ON public.integration_connections
  FOR DELETE USING (
    public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer']::TEXT[])
  );

-- Audit Events policies
CREATE POLICY "audit_events_select" ON public.audit_events
  FOR SELECT USING (
    actor_id = (SELECT auth.uid())
    OR (workspace_id IS NOT NULL AND public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[]))
    OR (project_id IS NOT NULL AND public.has_project_access(project_id, ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[]))
  );

CREATE POLICY "audit_events_insert" ON public.audit_events
  FOR INSERT WITH CHECK (actor_id = (SELECT auth.uid()));

-- Profiles co-member SELECT policy
DROP POLICY IF EXISTS "profiles_select_comembers" ON public.profiles;
CREATE POLICY "profiles_select_comembers" ON public.profiles
  FOR SELECT USING (
    auth.uid() = id
    OR EXISTS (
      SELECT 1
      FROM public.workspace_members wm_target
      WHERE wm_target.user_id = profiles.id
        AND public.has_workspace_role(
          wm_target.workspace_id,
          ARRAY['owner', 'admin', 'developer', 'viewer']::TEXT[]
        )
    )
  );

-- ─── 5. Atomic Project RPCs (Create, Update, Delete) ────────────────

-- 5a. Create Project with 4 Default Environments + Main Branch
CREATE OR REPLACE FUNCTION public.create_project_with_defaults(
  p_workspace_id UUID,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_repository_url TEXT DEFAULT NULL
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  created_project public.projects;
  project_slug TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to create a project'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_workspace_role(
    p_workspace_id,
    ARRAY['owner', 'admin', 'developer']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'You do not have permission to create projects in this workspace'
      USING ERRCODE = '42501';
  END IF;

  project_slug := trim(both '-' FROM regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  IF project_slug = '' THEN
    RAISE EXCEPTION 'Project name must contain at least one letter or number'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.projects
    WHERE workspace_id = p_workspace_id AND slug = project_slug
  ) THEN
    project_slug := project_slug || '-' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 6);
  END IF;

  INSERT INTO public.projects (
    workspace_id, name, slug, description, repository_url, owner_id
  )
  VALUES (
    p_workspace_id, trim(p_name), project_slug, p_description, p_repository_url, auth.uid()
  )
  RETURNING * INTO created_project;

  INSERT INTO public.project_members (project_id, user_id, role)
  VALUES (created_project.id, auth.uid(), 'owner')
  ON CONFLICT (project_id, user_id) DO NOTHING;

  INSERT INTO public.environments (project_id, name, type)
  VALUES
    (created_project.id, 'Development', 'development'),
    (created_project.id, 'Testing', 'testing'),
    (created_project.id, 'Staging', 'staging'),
    (created_project.id, 'Production', 'production')
  ON CONFLICT (project_id, name) DO NOTHING;

  INSERT INTO public.branches (
    project_id, name, repository_ref, commit_sha, commit_message, commit_date, is_active, is_synced
  )
  VALUES (
    created_project.id,
    'main',
    'refs/heads/main',
    substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 7),
    'Initial project branch provisioned',
    NOW(),
    TRUE,
    TRUE
  )
  ON CONFLICT (project_id, name) DO NOTHING;

  RETURN created_project;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project_with_defaults(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_project_with_defaults(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_project_with_defaults(UUID, TEXT, TEXT, TEXT) TO service_role;

-- 5b. Safe Update Project RPC (avoids RLS 42501 if workspace_members was out of sync)
CREATE OR REPLACE FUNCTION public.update_project_safe(
  p_project_id UUID,
  p_name TEXT DEFAULT NULL,
  p_slug TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_repository_url TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  updated_project public.projects;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to update a project'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_project_access(
    p_project_id,
    ARRAY['owner', 'admin', 'developer']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'You do not have permission to update this project'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.projects
  SET
    name = COALESCE(NULLIF(trim(p_name), ''), name),
    slug = COALESCE(NULLIF(trim(p_slug), ''), slug),
    description = CASE WHEN p_description IS NOT NULL THEN p_description ELSE description END,
    repository_url = CASE WHEN p_repository_url IS NOT NULL THEN p_repository_url ELSE repository_url END,
    status = COALESCE(NULLIF(trim(p_status), ''), status),
    updated_at = NOW()
  WHERE id = p_project_id
  RETURNING * INTO updated_project;

  RETURN updated_project;
END;
$$;

REVOKE ALL ON FUNCTION public.update_project_safe(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_project_safe(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_safe(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- 5c. Safe Delete Project RPC (deletes project and cascades to all child records)
CREATE OR REPLACE FUNCTION public.delete_project_safe(
  p_project_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to delete a project'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_project_access(
    p_project_id,
    ARRAY['owner', 'admin', 'developer']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'You do not have permission to delete this project'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.projects WHERE id = p_project_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_project_safe(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_project_safe(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_project_safe(UUID) TO service_role;

-- ─── 6. Add Public Schema Foreign Keys to Profiles (Fixes PGRST200) ─
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_user_id_profiles_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_assignee_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_assignee_id_profiles_fkey
      FOREIGN KEY (assignee_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_actor_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_actor_id_profiles_fkey
      FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

