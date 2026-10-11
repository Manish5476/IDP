import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useAuth } from '@/stores/AuthContext';
import { getWorkspaces, getProjects } from '@/services/api';
import type { Workspace, Project, UserRole } from '@/types';

export type WorkspaceWithRole = Workspace & { member_role: UserRole };

interface WorkspaceContextType {
  workspaces: WorkspaceWithRole[];
  activeWorkspace: WorkspaceWithRole | null;
  setActiveWorkspace: (ws: WorkspaceWithRole | null) => void;
  projects: Project[];
  activeProject: Project | null;
  setActiveProject: (project: Project | null) => void;
  isLoading: boolean;
  projectsLoading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  refreshProjects: (selectProjectId?: string) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceWithRole[]>([]);
  const [activeWorkspace, setActiveWorkspaceState] = useState<WorkspaceWithRole | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProjectState] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const userId = user?.id;
  const userEmail = user?.email;

  const setActiveWorkspace = useCallback(
    (ws: WorkspaceWithRole | null) => {
      setActiveWorkspaceState(ws);
      if (userId && typeof window !== 'undefined') {
        if (ws) {
          window.localStorage.setItem(`devportal_active_ws_${userId}`, ws.id);
        } else {
          window.localStorage.removeItem(`devportal_active_ws_${userId}`);
        }
      }
    },
    [userId]
  );

  const setActiveProject = useCallback(
    (project: Project | null) => {
      setActiveProjectState(project);
      if (userId && typeof window !== 'undefined') {
        if (project) {
          window.localStorage.setItem(`devportal_active_proj_${userId}`, project.id);
        } else {
          window.localStorage.removeItem(`devportal_active_proj_${userId}`);
        }
      }
    },
    [userId]
  );

  const activeWorkspaceId = activeWorkspace?.id;

  const refreshProjects = useCallback(
    async (selectProjectId?: string) => {
      if (!activeWorkspaceId) {
        setProjects([]);
        setActiveProjectState(null);
        return;
      }

      setProjectsLoading(true);
      try {
        const list = await getProjects(activeWorkspaceId);
        setProjects(list);

        const savedProjId =
          selectProjectId ||
          (userId && typeof window !== 'undefined'
            ? window.localStorage.getItem(`devportal_active_proj_${userId}`)
            : null);

        setActiveProjectState(current => {
          let chosen: Project | null = null;
          if (selectProjectId) {
            chosen = list.find(p => p.id === selectProjectId) ?? null;
          }
          if (!chosen && current) {
            chosen = list.find(p => p.id === current.id) ?? null;
          }
          if (!chosen && savedProjId) {
            chosen = list.find(p => p.id === savedProjId) ?? null;
          }
          if (!chosen) {
            chosen = list.find(p => p.status === 'active') ?? list[0] ?? null;
          }
          if (
            current &&
            chosen &&
            current.id === chosen.id &&
            current.updated_at === chosen.updated_at &&
            current.status === chosen.status &&
            current.name === chosen.name &&
            current.repository_url === chosen.repository_url
          ) {
            return current;
          }
          return chosen;
        });
      } catch (err) {
        console.error('Failed to load projects:', err);
      } finally {
        setProjectsLoading(false);
      }
    },
    [activeWorkspaceId, userId]
  );

  const refresh = useCallback(async () => {
    if (!userId) {
      setWorkspaces([]);
      setActiveWorkspaceState(null);
      setProjects([]);
      setActiveProjectState(null);
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await getWorkspaces(userId, userEmail);
      setWorkspaces(data);

      const savedWsId =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(`devportal_active_ws_${userId}`)
          : null;

      setActiveWorkspaceState(current => {
        let chosen: WorkspaceWithRole | null = null;
        if (current) {
          chosen = data.find(w => w.id === current.id) ?? null;
        }
        if (!chosen && savedWsId) {
          chosen = data.find(w => w.id === savedWsId) ?? null;
        }
        if (!chosen) {
          chosen = data[0] ?? null;
        }
        if (
          current &&
          chosen &&
          current.id === chosen.id &&
          current.updated_at === chosen.updated_at &&
          current.name === chosen.name &&
          current.member_role === chosen.member_role
        ) {
          return current;
        }
        return chosen;
      });
    } catch (err) {
      console.error('Failed to load workspaces:', err);
      setLoadError(err instanceof Error ? err.message : 'Could not load workspaces.');
    } finally {
      setIsLoading(false);
    }
  }, [userId, userEmail]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        setActiveWorkspace,
        projects,
        activeProject,
        setActiveProject,
        isLoading,
        projectsLoading,
        loadError,
        refresh,
        refreshProjects,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return context;
}
