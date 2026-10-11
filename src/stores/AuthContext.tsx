import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { supabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { CryptoService } from '@/lib/crypto/cryptoService';
import {
  loadLocalDb,
  saveLocalDb,
  hashString,
  ensureUserProvisioned,
} from '@/lib/storage/localDb';
import type { Profile, UserVault, UserCryptoKey } from '@/types';
import type { Session, User } from '@supabase/supabase-js';

interface VaultState {
  isLocked: boolean;
  isInitialized: boolean;
  vaultKey: CryptoKey | null;
  privateKey: CryptoKey | null;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  vault: VaultState;
  isLoading: boolean;
  isOnboarded: boolean;
  storageMode: 'supabase' | 'local';
}

interface AuthContextType extends AuthState {
  isVaultModalOpen: boolean;
  openVaultModal: () => void;
  closeVaultModal: () => void;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: string | null; autoSignedIn?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInDemo: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  unlockVault: (passphrase: string) => Promise<{ error: string | null }>;
  recoverVaultWithKey: (recoveryKey: string, newPassphrase: string) => Promise<{ error: string | null }>;
  changeVaultPassphrase: (newPassphrase: string) => Promise<{ error: string | null }>;
  lockVault: () => void;
  setupVault: (passphrase: string) => Promise<{ error: string | null; recoveryKey?: string }>;
  updateProfile: (data: Partial<Profile>) => Promise<{ error: string | null }>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function makeSyntheticSupabaseUser(id: string, email: string, fullName: string): User {
  const now = new Date().toISOString();
  return {
    id,
    app_metadata: { provider: 'email' },
    user_metadata: { full_name: fullName },
    aud: 'authenticated',
    created_at: now,
    email,
  } as User;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    profile: null,
    vault: { isLocked: true, isInitialized: false, vaultKey: null, privateKey: null },
    isLoading: true,
    isOnboarded: false,
    storageMode: isSupabaseConfigured ? 'supabase' : 'local',
  });
  const [isVaultModalOpen, setIsVaultModalOpen] = useState(false);

  const openVaultModal = useCallback(() => setIsVaultModalOpen(true), []);
  const closeVaultModal = useCallback(() => setIsVaultModalOpen(false), []);
  const hydrationCacheRef = React.useRef<{ userId: string; timestamp: number; inFlight: boolean }>({
    userId: '',
    timestamp: 0,
    inFlight: false,
  });

  const hydrateUserContext = useCallback(async (user: User, mode: 'supabase' | 'local', force = false) => {
    const nowMs = Date.now();
    if (
      !force &&
      hydrationCacheRef.current.userId === user.id &&
      (hydrationCacheRef.current.inFlight || nowMs - hydrationCacheRef.current.timestamp < 4000)
    ) {
      return;
    }
    hydrationCacheRef.current = { userId: user.id, timestamp: nowMs, inFlight: true };

    try {
      const email = user.email || 'developer@devportal.local';
      const metaName = (user.user_metadata?.full_name as string | undefined) || null;

      // Always ensure local user-scoped provisioning exists as fallback/sync
      const localProfile = ensureUserProvisioned(user.id, email, metaName);
      let resolvedProfile: Profile = localProfile;

      if (mode === 'supabase' && isSupabaseConfigured) {
        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();
          if (!error && data) {
            resolvedProfile = data as Profile;
          }
        } catch {
          // Fallback to local profile
        }
      }

      // Check vault initialization status in Supabase or localDb
      const db = loadLocalDb();
      let localVault = db.user_vaults.find(v => v.user_id === user.id) || null;

      if (mode === 'supabase' && isSupabaseConfigured) {
        try {
          const { data, error } = await supabase
            .from('user_vaults')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();
          if (!error && data) {
            localVault = data as UserVault;
            // Sync to localDb so offline/hybrid access works
            const existingIdx = db.user_vaults.findIndex(v => v.user_id === user.id);
            if (existingIdx >= 0) db.user_vaults[existingIdx] = localVault;
            else db.user_vaults.push(localVault);
            saveLocalDb(db);
          }
        } catch {
          // Use localVault
        }
      }

      const isVaultInit = Boolean(localVault);

      setState(s => ({
        ...s,
        user,
        profile: resolvedProfile,
        vault: {
          ...s.vault,
          isInitialized: isVaultInit,
        },
        isOnboarded: isVaultInit,
        isLoading: false,
        storageMode: mode,
      }));
    } finally {
      hydrationCacheRef.current.inFlight = false;
      hydrationCacheRef.current.timestamp = Date.now();
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    async function initSession() {
      // 1. Check local session first
      const db = loadLocalDb();
      if (db.currentSessionUserId) {
        const localUser = db.users.find(u => u.id === db.currentSessionUserId);
        if (localUser) {
          const syntheticUser = makeSyntheticSupabaseUser(
            localUser.id,
            localUser.email,
            localUser.full_name
          );
          if (mounted) {
            await hydrateUserContext(syntheticUser, 'local');
          }
          return;
        }
      }

      // 2. If Supabase is configured, check Supabase session
      if (isSupabaseConfigured) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user && mounted) {
            setState(s => ({ ...s, session }));
            await hydrateUserContext(session.user, 'supabase');
            return;
          }
        } catch {
          // Ignore and fall through
        }
      }

      if (mounted) {
        setState(s => ({ ...s, isLoading: false }));
      }
    }

    initSession();

    if (isSupabaseConfigured) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        if (session?.user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
          setState(s => ({ ...s, session }));
          hydrateUserContext(session.user, 'supabase', event === 'USER_UPDATED');
        }
      });
      return () => {
        mounted = false;
        subscription.unsubscribe();
      };
    }

    return () => {
      mounted = false;
    };
  }, [hydrateUserContext]);

  const signUp = async (
    email: string,
    password: string,
    fullName: string
  ): Promise<{ error: string | null; autoSignedIn?: boolean }> => {
    const normalizedEmail = email.trim().toLowerCase();
    const cleanedName = fullName.trim() || normalizedEmail.split('@')[0];

    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            data: { full_name: cleanedName },
            emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
          },
        });

        if (!error && data.user) {
          // Also mirror in localDb so user-scoped storage is always ready
          const db = loadLocalDb();
          const pwdHash = await hashString(password);
          if (!db.users.some(u => u.email.toLowerCase() === normalizedEmail)) {
            db.users.push({
              id: data.user.id,
              email: normalizedEmail,
              password_hash: pwdHash,
              full_name: cleanedName,
              created_at: new Date().toISOString(),
            });
          }
          db.currentSessionUserId = data.user.id;
          saveLocalDb(db);

          await hydrateUserContext(data.user, data.session ? 'supabase' : 'local');
          return { error: null, autoSignedIn: true };
        }
      } catch {
        // Fall back to local user-scoped registration below
      }
    }

    // Local user-scoped registration
    const db = loadLocalDb();
    const existing = db.users.find(u => u.email.toLowerCase() === normalizedEmail);
    if (existing) {
      return { error: 'An account with this email already exists. Please sign in.' };
    }

    const userId = crypto.randomUUID();
    const pwdHash = await hashString(password);
    const now = new Date().toISOString();

    db.users.push({
      id: userId,
      email: normalizedEmail,
      password_hash: pwdHash,
      full_name: cleanedName,
      created_at: now,
    });
    db.currentSessionUserId = userId;
    saveLocalDb(db);

    const syntheticUser = makeSyntheticSupabaseUser(userId, normalizedEmail, cleanedName);
    await hydrateUserContext(syntheticUser, 'local');
    return { error: null, autoSignedIn: true };
  };

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Check local user database first
    const db = loadLocalDb();
    const pwdHash = await hashString(password);
    const localUser = db.users.find(u => u.email.toLowerCase() === normalizedEmail);

    if (localUser) {
      if (localUser.password_hash !== pwdHash) {
        return { error: 'Invalid email or password.' };
      }
      db.currentSessionUserId = localUser.id;
      saveLocalDb(db);
      const syntheticUser = makeSyntheticSupabaseUser(
        localUser.id,
        localUser.email,
        localUser.full_name
      );
      await hydrateUserContext(syntheticUser, 'local');
      return { error: null };
    }

    // 2. Try Supabase Auth if configured
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (!error && data.user) {
          await hydrateUserContext(data.user, 'supabase');
          return { error: null };
        }
        if (error) {
          return { error: error.message };
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Sign-in failed' };
      }
    }

    return { error: 'No account found with this email. Create an account or use Quick Demo Access.' };
  };

  const signInDemo = async (): Promise<{ error: string | null }> => {
    const demoEmail = 'alex.rivera@devportal.io';
    const demoName = 'Alex Rivera';
    const demoPassphrase = 'devportal-demo-vault-key';

    const db = loadLocalDb();
    let demoUser = db.users.find(u => u.email === demoEmail);
    const pwdHash = await hashString('DemoPassword123!');

    if (!demoUser) {
      demoUser = {
        id: 'demo-user-alex-rivera',
        email: demoEmail,
        password_hash: pwdHash,
        full_name: demoName,
        created_at: new Date().toISOString(),
      };
      db.users.push(demoUser);
    }
    db.currentSessionUserId = demoUser.id;
    saveLocalDb(db);

    const syntheticUser = makeSyntheticSupabaseUser(demoUser.id, demoUser.email, demoUser.full_name);
    await hydrateUserContext(syntheticUser, 'local');

    // Auto-initialize and unlock demo user's vault if not already initialized
    const refreshedDb = loadLocalDb();
    const existingVault = refreshedDb.user_vaults.find(v => v.user_id === demoUser.id);
    if (!existingVault) {
      const vaultData = await CryptoService.createVault(demoPassphrase);
      const vaultKey = await CryptoService.unlockVault(
        demoPassphrase,
        vaultData.encryptedVaultKey,
        vaultData.salt,
        vaultData.nonce
      );
      const keyPair = await CryptoService.generateKeyPair();
      const publicKeyJwk = await CryptoService.exportPublicKey(keyPair.publicKey);
      const encPrivKey = await CryptoService.encryptPrivateKey(keyPair.privateKey, vaultKey);
      const recoveryKey = CryptoService.generateRecoveryKey();
      const recoveryBundle = await CryptoService.createRecoveryBundle(vaultKey, recoveryKey);
      const now = new Date().toISOString();

      refreshedDb.user_vaults.push({
        id: crypto.randomUUID(),
        user_id: demoUser.id,
        encrypted_vault_key: vaultData.encryptedVaultKey,
        kdf_salt: vaultData.salt,
        kdf_algorithm: 'argon2id',
        kdf_version: 1,
        kdf_params: { memoryCost: 65536, timeCost: 3, parallelism: 4 },
        recovery_envelope: recoveryBundle,
        crypto_version: '1',
        created_at: now,
        updated_at: now,
      });

      refreshedDb.user_crypto_keys.push({
        id: crypto.randomUUID(),
        user_id: demoUser.id,
        public_key: publicKeyJwk,
        encrypted_private_key: encPrivKey,
        key_version: 1,
        created_at: now,
        updated_at: now,
      });

      // Also seed encrypted demo secrets in the default project's Development environment
      const userWs = refreshedDb.workspace_members.find(wm => wm.user_id === demoUser!.id);
      const project = userWs
        ? refreshedDb.projects.find(p => p.workspace_id === userWs.workspace_id)
        : undefined;
      const devEnv = project
        ? refreshedDb.environments.find(e => e.project_id === project.id && e.type === 'development')
        : undefined;

      if (project && devEnv) {
        const sampleSecrets = [
          { name: 'DATABASE_URL', value: 'postgresql://postgres:s3cr3t@db.internal.devportal.io:5432/core' },
          { name: 'JWT_SIGNING_SECRET', value: 'zp9_live_8f92a7c4b1e09d3f6a2b5c8e1d4f7a0b' },
          { name: 'STRIPE_WEBHOOK_SECRET', value: 'whsec_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d' },
        ];
        for (const sec of sampleSecrets) {
          const exists = refreshedDb.encrypted_secrets.some(
            s => s.environment_id === devEnv.id && s.variable_name === sec.name
          );
          if (!exists) {
            const encrypted = await CryptoService.encryptSecretValue(sec.value, vaultKey);
            refreshedDb.encrypted_secrets.push({
              id: crypto.randomUUID(),
              environment_id: devEnv.id,
              project_id: project.id,
              variable_name: sec.name,
              encrypted_value: encrypted.ciphertext,
              nonce: encrypted.nonce,
              crypto_version: '1',
              key_version: 1,
              is_secret: true,
              created_at: now,
              updated_at: now,
            });
          }
        }
      }

      saveLocalDb(refreshedDb);

      setState(s => ({
        ...s,
        vault: {
          isLocked: false,
          isInitialized: true,
          vaultKey,
          privateKey: keyPair.privateKey,
        },
        isOnboarded: true,
      }));
    } else {
      try {
        const vaultKey = await CryptoService.unlockVault(
          demoPassphrase,
          existingVault.encrypted_vault_key,
          existingVault.kdf_salt
        );
        const keyRecord = refreshedDb.user_crypto_keys.find(k => k.user_id === demoUser!.id);
        const privateKey = keyRecord
          ? await CryptoService.decryptPrivateKey(keyRecord.encrypted_private_key, vaultKey)
          : null;
        setState(s => ({
          ...s,
          vault: { isLocked: false, isInitialized: true, vaultKey, privateKey },
          isOnboarded: true,
        }));
      } catch {
        // Leave vault locked if demo user changed their passphrase
      }
    }

    return { error: null };
  };

  const signOut = async () => {
    const db = loadLocalDb();
    db.currentSessionUserId = null;
    saveLocalDb(db);

    setState({
      user: null,
      session: null,
      profile: null,
      vault: { isLocked: true, isInitialized: false, vaultKey: null, privateKey: null },
      isLoading: false,
      isOnboarded: false,
      storageMode: isSupabaseConfigured ? 'supabase' : 'local',
    });

    if (isSupabaseConfigured) {
      try {
        await supabase.auth.signOut();
      } catch {
        // Ignore signOut errors when offline
      }
    }
  };

  const resetPassword = async (email: string) => {
    if (isSupabaseConfigured && state.storageMode === 'supabase') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${window.location.pathname}#/reset-password`,
      });
      return { error: error?.message ?? null };
    }
    const db = loadLocalDb();
    const found = db.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!found) return { error: 'No account found with that email address.' };
    return { error: null };
  };

  const updatePassword = async (newPassword: string) => {
    if (!state.user) return { error: 'Not authenticated' };
    if (newPassword.length < 8) return { error: 'Password must be at least 8 characters' };

    const db = loadLocalDb();
    const localUser = db.users.find(u => u.id === state.user!.id);
    if (localUser) {
      localUser.password_hash = await hashString(newPassword);
      saveLocalDb(db);
    }

    if (isSupabaseConfigured && state.storageMode === 'supabase') {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) return { error: error.message };
    }
    return { error: null };
  };

  const setupVault = async (passphrase: string): Promise<{ error: string | null; recoveryKey?: string }> => {
    if (!state.user) return { error: 'Not authenticated' };

    try {
      // 1. Create encrypted vault key with embedded nonce
      const vaultData = await CryptoService.createVault(passphrase);

      // 2. Unlock the vault key in memory
      const vaultKey = await CryptoService.unlockVault(
        passphrase,
        vaultData.encryptedVaultKey,
        vaultData.salt,
        vaultData.nonce
      );

      // 3. Generate 4096-bit RSA-OAEP keypair and encrypt private key with vaultKey
      const keyPair = await CryptoService.generateKeyPair();
      const publicKeyJwk = await CryptoService.exportPublicKey(keyPair.publicKey);
      const encPrivKey = await CryptoService.encryptPrivateKey(keyPair.privateKey, vaultKey);

      // 4. Generate high-entropy recovery key & bundle
      const recoveryKey = CryptoService.generateRecoveryKey();
      const recoveryBundle = await CryptoService.createRecoveryBundle(vaultKey, recoveryKey);

      const now = new Date().toISOString();
      const vaultRecord: UserVault = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        encrypted_vault_key: vaultData.encryptedVaultKey,
        kdf_salt: vaultData.salt,
        kdf_algorithm: 'argon2id',
        kdf_version: 1,
        kdf_params: { memoryCost: 65536, timeCost: 3, parallelism: 4 },
        recovery_envelope: recoveryBundle,
        crypto_version: '1',
        created_at: now,
        updated_at: now,
      };

      const cryptoKeyRecord: UserCryptoKey = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        public_key: publicKeyJwk,
        encrypted_private_key: encPrivKey,
        key_version: 1,
        created_at: now,
        updated_at: now,
      };

      // Persist in user-scoped local database
      const db = loadLocalDb();
      db.user_vaults = db.user_vaults.filter(v => v.user_id !== state.user!.id);
      db.user_vaults.push(vaultRecord);
      db.user_crypto_keys = db.user_crypto_keys.filter(k => k.user_id !== state.user!.id);
      db.user_crypto_keys.push(cryptoKeyRecord);
      db.audit_events.unshift({
        id: crypto.randomUUID(),
        actor_id: state.user.id,
        action: 'vault.initialized',
        resource_type: 'user_vault',
        resource_id: vaultRecord.id,
        workspace_id: null,
        project_id: null,
        outcome: 'success',
        metadata: { algorithm: 'AES-256-GCM + RSA-OAEP-4096' },
        created_at: now,
      });
      saveLocalDb(db);

      // Also persist to Supabase if configured
      if (isSupabaseConfigured && state.storageMode === 'supabase') {
        try {
          await supabase.from('user_vaults').upsert({
            user_id: state.user.id,
            encrypted_vault_key: vaultData.encryptedVaultKey,
            kdf_salt: vaultData.salt,
            kdf_algorithm: 'argon2id',
            kdf_version: 1,
            kdf_params: { memoryCost: 65536, timeCost: 3, parallelism: 4 },
            recovery_envelope: recoveryBundle,
            crypto_version: '1',
          });
          await supabase.from('user_crypto_keys').upsert({
            user_id: state.user.id,
            public_key: publicKeyJwk,
            encrypted_private_key: encPrivKey,
            key_version: 1,
          });
        } catch {
          // Local persistence succeeded
        }
      }

      setState(s => ({
        ...s,
        vault: {
          isLocked: false,
          isInitialized: true,
          vaultKey,
          privateKey: keyPair.privateKey,
        },
        isOnboarded: true,
      }));

      return { error: null, recoveryKey };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Vault setup failed' };
    }
  };

  const unlockVault = async (passphrase: string): Promise<{ error: string | null }> => {
    if (!state.user) return { error: 'Not authenticated' };

    try {
      const db = loadLocalDb();
      let vaultData: UserVault | null = db.user_vaults.find(v => v.user_id === state.user!.id) || null;
      let keyData: UserCryptoKey | null = db.user_crypto_keys.find(k => k.user_id === state.user!.id) || null;

      if (!vaultData && isSupabaseConfigured) {
        const { data } = await supabase
          .from('user_vaults')
          .select('*')
          .eq('user_id', state.user.id)
          .maybeSingle();
        if (data) vaultData = data as UserVault;
      }

      if (!keyData && isSupabaseConfigured) {
        const { data } = await supabase
          .from('user_crypto_keys')
          .select('*')
          .eq('user_id', state.user.id)
          .maybeSingle();
        if (data) keyData = data as UserCryptoKey;
      }

      if (!vaultData) {
        return { error: 'Vault is not initialized yet. Please set up your vault first.' };
      }

      const vaultKey = await CryptoService.unlockVault(
        passphrase,
        vaultData.encrypted_vault_key,
        vaultData.kdf_salt
      );

      let privateKey: CryptoKey | null = null;
      if (keyData) {
        privateKey = await CryptoService.decryptPrivateKey(
          keyData.encrypted_private_key,
          vaultKey
        );
      }

      db.audit_events.unshift({
        id: crypto.randomUUID(),
        actor_id: state.user.id,
        action: 'vault.unlocked',
        resource_type: 'user_vault',
        resource_id: vaultData.id,
        workspace_id: null,
        project_id: null,
        outcome: 'success',
        metadata: {},
        created_at: new Date().toISOString(),
      });
      saveLocalDb(db);

      setState(s => ({
        ...s,
        vault: { isLocked: false, isInitialized: true, vaultKey, privateKey },
      }));

      return { error: null };
    } catch {
      return { error: 'Invalid vault passphrase. Please check your passphrase or use your recovery key.' };
    }
  };

  const recoverVaultWithKey = async (
    recoveryKey: string,
    newPassphrase: string
  ): Promise<{ error: string | null }> => {
    if (!state.user) return { error: 'Not authenticated' };
    if (newPassphrase.length < 12) {
      return { error: 'New vault passphrase must be at least 12 characters.' };
    }

    try {
      const db = loadLocalDb();
      const vaultData = db.user_vaults.find(v => v.user_id === state.user!.id);
      if (!vaultData || !vaultData.recovery_envelope) {
        return { error: 'No recovery bundle found for this account.' };
      }

      const vaultKey = await CryptoService.recoverVault(
        vaultData.recovery_envelope,
        recoveryKey.trim()
      );
      const updated = await CryptoService.changePassphrase(vaultKey, newPassphrase);

      vaultData.encrypted_vault_key = updated.encryptedVaultKey;
      vaultData.kdf_salt = updated.salt;
      vaultData.updated_at = new Date().toISOString();
      saveLocalDb(db);

      const keyData = db.user_crypto_keys.find(k => k.user_id === state.user!.id);
      const privateKey = keyData
        ? await CryptoService.decryptPrivateKey(keyData.encrypted_private_key, vaultKey)
        : null;

      setState(s => ({
        ...s,
        vault: { isLocked: false, isInitialized: true, vaultKey, privateKey },
      }));

      return { error: null };
    } catch {
      return { error: 'Invalid recovery key. Could not decrypt recovery bundle.' };
    }
  };

  const changeVaultPassphrase = async (newPassphrase: string): Promise<{ error: string | null }> => {
    if (!state.user) return { error: 'Not authenticated' };
    if (!state.vault.vaultKey || state.vault.isLocked) {
      return { error: 'Unlock your vault first before rotating your passphrase.' };
    }
    if (newPassphrase.length < 12) {
      return { error: 'New passphrase must be at least 12 characters.' };
    }

    try {
      const updated = await CryptoService.changePassphrase(state.vault.vaultKey, newPassphrase);
      const db = loadLocalDb();
      const vaultData = db.user_vaults.find(v => v.user_id === state.user!.id);
      if (vaultData) {
        vaultData.encrypted_vault_key = updated.encryptedVaultKey;
        vaultData.kdf_salt = updated.salt;
        vaultData.updated_at = new Date().toISOString();
      }
      db.audit_events.unshift({
        id: crypto.randomUUID(),
        actor_id: state.user.id,
        action: 'vault.passphrase_rotated',
        resource_type: 'user_vault',
        resource_id: vaultData?.id ?? null,
        workspace_id: null,
        project_id: null,
        outcome: 'success',
        metadata: {},
        created_at: new Date().toISOString(),
      });
      saveLocalDb(db);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to rotate passphrase' };
    }
  };

  const lockVault = () => {
    setState(s => ({
      ...s,
      vault: { isLocked: true, isInitialized: s.vault.isInitialized, vaultKey: null, privateKey: null },
    }));
  };

  const updateProfile = async (data: Partial<Profile>) => {
    if (!state.user) return { error: 'Not authenticated' };
    const now = new Date().toISOString();

    const db = loadLocalDb();
    const profileIdx = db.profiles.findIndex(p => p.id === state.user!.id);
    if (profileIdx >= 0) {
      db.profiles[profileIdx] = {
        ...db.profiles[profileIdx],
        ...data,
        updated_at: now,
      };
      saveLocalDb(db);
      setState(s => ({ ...s, profile: db.profiles[profileIdx] }));
    }

    if (isSupabaseConfigured && state.storageMode === 'supabase') {
      try {
        await supabase
          .from('profiles')
          .update({ ...data, updated_at: now })
          .eq('id', state.user.id);
      } catch {
        // Local profile already updated
      }
    }
    return { error: null };
  };

  const refreshProfile = async () => {
    if (state.user) {
      await hydrateUserContext(state.user, state.storageMode);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        ...state,
        isVaultModalOpen,
        openVaultModal,
        closeVaultModal,
        signUp,
        signIn,
        signInDemo,
        signOut,
        resetPassword,
        updatePassword,
        unlockVault,
        recoverVaultWithKey,
        changeVaultPassphrase,
        lockVault,
        setupVault,
        updateProfile,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
