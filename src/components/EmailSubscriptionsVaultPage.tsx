import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/AuthContext';
import { useWorkspace } from '@/stores/WorkspaceContext';
import { CryptoService } from '@/lib/crypto/cryptoService';
import {
  getEmailIdentities,
  createEmailIdentity,
  updateEmailIdentity,
  deleteEmailIdentity,
  getEmailSubscriptions,
  createEmailSubscription,
  updateEmailSubscription,
  deleteEmailSubscription,
} from '@/services/api';
import type {
  EmailIdentity,
  EmailSubscription,
  EmailIdentitySecretPayload,
  SubscriptionSecretPayload,
  SubscriptionCategory,
  SubscriptionStatus,
  BillingCycle,
  VaultTodoItem,
} from '@/types';
import {
  Mail,
  Plus,
  Lock,
  Unlock,
  Shield,
  Key,
  Eye,
  EyeOff,
  Copy,
  Check,
  Trash2,
  Edit3,
  ExternalLink,
  CheckSquare,
  FileText,
  Search,
  Sparkles,
  RefreshCw,
  Calendar,
  CreditCard,
  FolderKanban,
  AlertTriangle,
  CheckCircle,
  Globe,
  Server,
  X,
} from 'lucide-react';

const EMPTY_IDENTITY_SECRET: EmailIdentitySecretPayload = {
  emailPassword: '',
  recoveryInfo: '',
  purposeNotes: '',
  todos: [],
};

const EMPTY_SUBSCRIPTION_SECRET: SubscriptionSecretPayload = {
  usernameOrLogin: '',
  password: '',
  twoFactorOrRecovery: '',
  purposeNotes: '',
  todos: [],
};

const CATEGORY_LABELS: Record<SubscriptionCategory, string> = {
  cloud: 'Cloud & Infra',
  ai: 'AI & LLM',
  devtools: 'DevTools & CI',
  domain: 'Domains & DNS',
  database: 'Database & Storage',
  design: 'Design & Product',
  communication: 'Email & Comms',
  other: 'Other SaaS',
};

const STATUS_STYLES: Record<SubscriptionStatus, string> = {
  active: 'bg-[#E3F5E1] text-[#2A9D5C] dark:bg-emerald-950/70 dark:text-emerald-300',
  trial: 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300',
  free: 'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300',
  paused: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  cancelled: 'bg-rose-100 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300',
};

function generateStrongPassword(length = 20): string {
  const charset =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  const randomBytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(randomBytes)
    .map(b => charset[b % charset.length])
    .join('');
}

export function EmailSubscriptionsVaultPage() {
  const navigate = useNavigate();
  const { user, profile, vault, openVaultModal } = useAuth();
  const { activeWorkspace, projects } = useWorkspace();

  const [identities, setIdentities] = useState<EmailIdentity[]>([]);
  const [subscriptions, setSubscriptions] = useState<EmailSubscription[]>([]);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string>('ALL');
  const [loading, setLoading] = useState(true);

  // Decrypted in-memory maps (never persisted to storage)
  const [decryptedIdentities, setDecryptedIdentities] = useState<
    Record<string, EmailIdentitySecretPayload>
  >({});
  const [decryptedSubscriptions, setDecryptedSubscriptions] = useState<
    Record<string, SubscriptionSecretPayload>
  >({});

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<SubscriptionCategory | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | 'all'>('all');

  // Visibility & clipboard state
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [cipherPreviewId, setCipherPreviewId] = useState<string | null>(null);

  // Inline todo inputs per identity or subscription id
  const [newTodoTexts, setNewTodoTexts] = useState<Record<string, string>>({});

  // Email Identity Modal state
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState<EmailIdentity | null>(null);
  const [identityEmail, setIdentityEmail] = useState('');
  const [identityAlias, setIdentityAlias] = useState('');
  const [identityProvider, setIdentityProvider] = useState('Gmail');
  const [identityPassword, setIdentityPassword] = useState('');
  const [identityRecovery, setIdentityRecovery] = useState('');
  const [identityPurpose, setIdentityPurpose] = useState('');
  const [identityTodoDraft, setIdentityTodoDraft] = useState('');
  const [identityTodos, setIdentityTodos] = useState<VaultTodoItem[]>([]);
  const [showIdentityModalPassword, setShowIdentityModalPassword] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);

  // Subscription Modal state
  const [showSubModal, setShowSubModal] = useState(false);
  const [editingSub, setEditingSub] = useState<EmailSubscription | null>(null);
  const [subIdentityId, setSubIdentityId] = useState('');
  const [subProjectId, setSubProjectId] = useState('');
  const [subServiceName, setSubServiceName] = useState('');
  const [subServiceUrl, setSubServiceUrl] = useState('');
  const [subCategory, setSubCategory] = useState<SubscriptionCategory>('cloud');
  const [subStatus, setSubStatus] = useState<SubscriptionStatus>('active');
  const [subBillingCycle, setSubBillingCycle] = useState<BillingCycle>('monthly');
  const [subCostAmount, setSubCostAmount] = useState('0');
  const [subCurrency, setSubCurrency] = useState('USD');
  const [subRenewalDate, setSubRenewalDate] = useState('');
  const [subUsername, setSubUsername] = useState('');
  const [subPassword, setSubPassword] = useState('');
  const [subTwoFactor, setSubTwoFactor] = useState('');
  const [subPurposeNotes, setSubPurposeNotes] = useState('');
  const [subTodoDraft, setSubTodoDraft] = useState('');
  const [subTodos, setSubTodos] = useState<VaultTodoItem[]>([]);
  const [showSubModalPassword, setShowSubModalPassword] = useState(false);
  const [savingSub, setSavingSub] = useState(false);

  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const workspaceId = activeWorkspace?.id;
  const userId = user?.id;

  const loadData = useCallback(async () => {
    if (!workspaceId || !userId) {
      setIdentities([]);
      setSubscriptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [idList, subList] = await Promise.all([
        getEmailIdentities(workspaceId, userId),
        getEmailSubscriptions(workspaceId, userId),
      ]);
      setIdentities(idList);
      setSubscriptions(subList);
      setSelectedIdentityId(prev => {
        if (prev === 'ALL') return idList.length === 1 ? idList[0].id : 'ALL';
        return idList.some(i => i.id === prev) ? prev : idList[0]?.id || 'ALL';
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, userId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Decrypt all identities and subscriptions in memory when vault.vaultKey is unlocked
  useEffect(() => {
    let cancelled = false;
    async function decryptAll() {
      if (!vault.vaultKey || vault.isLocked) {
        setDecryptedIdentities({});
        setDecryptedSubscriptions({});
        return;
      }

      const idMap: Record<string, EmailIdentitySecretPayload> = {};
      for (const item of identities) {
        try {
          const json = await CryptoService.decryptSecretValue(
            {
              ciphertext: item.encrypted_payload,
              nonce: item.nonce,
              version: item.crypto_version || '1',
              key_version: item.key_version || 1,
            },
            vault.vaultKey
          );
          const parsed = JSON.parse(json) as Partial<EmailIdentitySecretPayload>;
          idMap[item.id] = {
            emailPassword: parsed.emailPassword || '',
            recoveryInfo: parsed.recoveryInfo || '',
            purposeNotes: parsed.purposeNotes || '',
            todos: Array.isArray(parsed.todos) ? parsed.todos : [],
          };
        } catch {
          idMap[item.id] = { ...EMPTY_IDENTITY_SECRET };
        }
      }

      const subMap: Record<string, SubscriptionSecretPayload> = {};
      for (const sub of subscriptions) {
        try {
          const json = await CryptoService.decryptSecretValue(
            {
              ciphertext: sub.encrypted_payload,
              nonce: sub.nonce,
              version: sub.crypto_version || '1',
              key_version: sub.key_version || 1,
            },
            vault.vaultKey
          );
          const parsed = JSON.parse(json) as Partial<SubscriptionSecretPayload>;
          subMap[sub.id] = {
            usernameOrLogin: parsed.usernameOrLogin || '',
            password: parsed.password || '',
            twoFactorOrRecovery: parsed.twoFactorOrRecovery || '',
            purposeNotes: parsed.purposeNotes || '',
            todos: Array.isArray(parsed.todos) ? parsed.todos : [],
          };
        } catch {
          subMap[sub.id] = { ...EMPTY_SUBSCRIPTION_SECRET };
        }
      }

      if (!cancelled) {
        setDecryptedIdentities(idMap);
        setDecryptedSubscriptions(subMap);
      }
    }

    decryptAll();
    return () => {
      cancelled = true;
    };
  }, [identities, subscriptions, vault.vaultKey, vault.isLocked]);

  const ensureVaultUnlocked = (): boolean => {
    if (!vault.isInitialized) {
      navigate('/onboarding');
      return false;
    }
    if (vault.isLocked || !vault.vaultKey) {
      openVaultModal();
      return false;
    }
    return true;
  };

  const copyValue = (key: string, value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey(prev => (prev === key ? null : prev));
    }, 1800);
  };

  const toggleReveal = (key: string) => {
    if (!ensureVaultUnlocked()) return;
    setRevealedIds(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // ─── Open Modals ────────────────────────────────────────────────────

  const openNewIdentityModal = (prefillEmail = '') => {
    if (!ensureVaultUnlocked()) return;
    setEditingIdentity(null);
    setIdentityEmail(prefillEmail);
    setIdentityAlias(prefillEmail ? 'Primary Account' : '');
    setIdentityProvider(
      prefillEmail.endsWith('@gmail.com')
        ? 'Gmail'
        : prefillEmail.endsWith('@outlook.com') || prefillEmail.endsWith('@hotmail.com')
          ? 'Outlook / M365'
          : prefillEmail.endsWith('@proton.me') || prefillEmail.endsWith('@protonmail.com')
            ? 'ProtonMail'
            : 'Custom Domain'
    );
    setIdentityPassword('');
    setIdentityRecovery('');
    setIdentityPurpose('');
    setIdentityTodoDraft('');
    setIdentityTodos([]);
    setShowIdentityModalPassword(false);
    setErrorBanner(null);
    setShowIdentityModal(true);
  };

  const openEditIdentityModal = (identity: EmailIdentity) => {
    if (!ensureVaultUnlocked()) return;
    const secret = decryptedIdentities[identity.id] || EMPTY_IDENTITY_SECRET;
    setEditingIdentity(identity);
    setIdentityEmail(identity.email);
    setIdentityAlias(identity.alias_label);
    setIdentityProvider(identity.provider);
    setIdentityPassword(secret.emailPassword);
    setIdentityRecovery(secret.recoveryInfo);
    setIdentityPurpose(secret.purposeNotes);
    setIdentityTodoDraft('');
    setIdentityTodos([...secret.todos]);
    setShowIdentityModalPassword(false);
    setErrorBanner(null);
    setShowIdentityModal(true);
  };

  const openNewSubscriptionModal = (defaultIdentityId?: string) => {
    if (!ensureVaultUnlocked()) return;
    const targetIdentityId =
      defaultIdentityId && defaultIdentityId !== 'ALL'
        ? defaultIdentityId
        : identities[0]?.id || '';
    if (!targetIdentityId) {
      openNewIdentityModal(profile?.email || '');
      return;
    }
    const targetIdentity = identities.find(i => i.id === targetIdentityId);
    setEditingSub(null);
    setSubIdentityId(targetIdentityId);
    setSubProjectId('');
    setSubServiceName('');
    setSubServiceUrl('');
    setSubCategory('cloud');
    setSubStatus('active');
    setSubBillingCycle('monthly');
    setSubCostAmount('0');
    setSubCurrency('USD');
    setSubRenewalDate('');
    setSubUsername(targetIdentity?.email || '');
    setSubPassword('');
    setSubTwoFactor('');
    setSubPurposeNotes('');
    setSubTodoDraft('');
    setSubTodos([]);
    setShowSubModalPassword(false);
    setErrorBanner(null);
    setShowSubModal(true);
  };

  const openEditSubscriptionModal = (sub: EmailSubscription) => {
    if (!ensureVaultUnlocked()) return;
    const secret = decryptedSubscriptions[sub.id] || EMPTY_SUBSCRIPTION_SECRET;
    setEditingSub(sub);
    setSubIdentityId(sub.email_identity_id);
    setSubProjectId(sub.project_id || '');
    setSubServiceName(sub.service_name);
    setSubServiceUrl(sub.service_url || '');
    setSubCategory(sub.category);
    setSubStatus(sub.status);
    setSubBillingCycle(sub.billing_cycle);
    setSubCostAmount(String(sub.cost_amount ?? 0));
    setSubCurrency(sub.currency || 'USD');
    setSubRenewalDate(sub.renewal_date || '');
    setSubUsername(secret.usernameOrLogin);
    setSubPassword(secret.password);
    setSubTwoFactor(secret.twoFactorOrRecovery);
    setSubPurposeNotes(secret.purposeNotes);
    setSubTodoDraft('');
    setSubTodos([...secret.todos]);
    setShowSubModalPassword(false);
    setErrorBanner(null);
    setShowSubModal(true);
  };

  // ─── Save Handlers (Encrypting with AES-256-GCM) ────────────────────

  const handleSaveIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !userId || !vault.vaultKey) {
      ensureVaultUnlocked();
      return;
    }

    setSavingIdentity(true);
    setErrorBanner(null);
    try {
      const finalTodos = [...identityTodos];
      if (identityTodoDraft.trim()) {
        finalTodos.push({
          id: crypto.randomUUID(),
          text: identityTodoDraft.trim(),
          completed: false,
          created_at: new Date().toISOString(),
        });
      }

      const secretPayload: EmailIdentitySecretPayload = {
        emailPassword: identityPassword,
        recoveryInfo: identityRecovery.trim(),
        purposeNotes: identityPurpose.trim(),
        todos: finalTodos,
      };

      const encrypted = await CryptoService.encryptSecretValue(
        JSON.stringify(secretPayload),
        vault.vaultKey
      );

      if (editingIdentity) {
        const updated = await updateEmailIdentity(
          editingIdentity.id,
          {
            email: identityEmail,
            alias_label: identityAlias || 'Primary Email',
            provider: identityProvider || 'Custom',
            encrypted_payload: encrypted.ciphertext,
            nonce: encrypted.nonce,
            crypto_version: encrypted.version,
            key_version: encrypted.key_version,
          },
          userId
        );
        setIdentities(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setDecryptedIdentities(prev => ({ ...prev, [updated.id]: secretPayload }));
      } else {
        const created = await createEmailIdentity({
          workspaceId,
          userId,
          email: identityEmail,
          aliasLabel: identityAlias || 'Primary Email',
          provider: identityProvider || 'Custom',
          encryptedPayload: encrypted.ciphertext,
          nonce: encrypted.nonce,
          cryptoVersion: encrypted.version,
          keyVersion: encrypted.key_version,
        });
        setIdentities(prev => [created, ...prev]);
        setDecryptedIdentities(prev => ({ ...prev, [created.id]: secretPayload }));
        setSelectedIdentityId(created.id);
      }

      setShowIdentityModal(false);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to encrypt and save email');
    } finally {
      setSavingIdentity(false);
    }
  };

  const handleDeleteIdentity = async (identity: EmailIdentity) => {
    const subCount = subscriptions.filter(s => s.email_identity_id === identity.id).length;
    const confirmed = window.confirm(
      `Delete email identity "${identity.email}" and its ${subCount} encrypted subscription record(s)?`
    );
    if (!confirmed) return;

    await deleteEmailIdentity(identity.id, userId);
    const remaining = identities.filter(i => i.id !== identity.id);
    setIdentities(remaining);
    setSubscriptions(prev => prev.filter(s => s.email_identity_id !== identity.id));
    if (selectedIdentityId === identity.id) {
      setSelectedIdentityId(remaining[0]?.id || 'ALL');
    }
  };

  const handleSaveSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !userId || !vault.vaultKey || !subIdentityId) {
      ensureVaultUnlocked();
      return;
    }

    setSavingSub(true);
    setErrorBanner(null);
    try {
      const finalTodos = [...subTodos];
      if (subTodoDraft.trim()) {
        finalTodos.push({
          id: crypto.randomUUID(),
          text: subTodoDraft.trim(),
          completed: false,
          created_at: new Date().toISOString(),
        });
      }

      const secretPayload: SubscriptionSecretPayload = {
        usernameOrLogin: subUsername.trim(),
        password: subPassword,
        twoFactorOrRecovery: subTwoFactor.trim(),
        purposeNotes: subPurposeNotes.trim(),
        todos: finalTodos,
      };

      const encrypted = await CryptoService.encryptSecretValue(
        JSON.stringify(secretPayload),
        vault.vaultKey
      );

      const numericCost = parseFloat(subCostAmount);

      if (editingSub) {
        const updated = await updateEmailSubscription(
          editingSub.id,
          {
            email_identity_id: subIdentityId,
            project_id: subProjectId || null,
            service_name: subServiceName,
            service_url: subServiceUrl || null,
            category: subCategory,
            status: subStatus,
            billing_cycle: subBillingCycle,
            cost_amount: Number.isFinite(numericCost) ? numericCost : 0,
            currency: subCurrency || 'USD',
            renewal_date: subRenewalDate || null,
            encrypted_payload: encrypted.ciphertext,
            nonce: encrypted.nonce,
            crypto_version: encrypted.version,
            key_version: encrypted.key_version,
          },
          userId
        );
        setSubscriptions(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setDecryptedSubscriptions(prev => ({ ...prev, [updated.id]: secretPayload }));
      } else {
        const created = await createEmailSubscription({
          emailIdentityId: subIdentityId,
          workspaceId,
          userId,
          projectId: subProjectId || null,
          serviceName: subServiceName,
          serviceUrl: subServiceUrl || null,
          category: subCategory,
          status: subStatus,
          billingCycle: subBillingCycle,
          costAmount: Number.isFinite(numericCost) ? numericCost : 0,
          currency: subCurrency || 'USD',
          renewalDate: subRenewalDate || null,
          encryptedPayload: encrypted.ciphertext,
          nonce: encrypted.nonce,
          cryptoVersion: encrypted.version,
          keyVersion: encrypted.key_version,
        });
        setSubscriptions(prev => [created, ...prev]);
        setDecryptedSubscriptions(prev => ({ ...prev, [created.id]: secretPayload }));
      }

      setShowSubModal(false);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Failed to encrypt and save subscription'
      );
    } finally {
      setSavingSub(false);
    }
  };

  const handleDeleteSubscription = async (sub: EmailSubscription) => {
    if (!window.confirm(`Delete encrypted subscription "${sub.service_name}"?`)) return;
    await deleteEmailSubscription(sub.id, userId);
    setSubscriptions(prev => prev.filter(item => item.id !== sub.id));
  };

  // ─── Interactive Encrypted Todo Mutations (Inline Add/Toggle/Delete) ─

  const updateIdentityTodosEncrypted = async (
    identity: EmailIdentity,
    nextTodos: VaultTodoItem[]
  ) => {
    if (!vault.vaultKey || !userId) {
      ensureVaultUnlocked();
      return;
    }
    const currentSecret = decryptedIdentities[identity.id] || EMPTY_IDENTITY_SECRET;
    const nextSecret: EmailIdentitySecretPayload = {
      ...currentSecret,
      todos: nextTodos,
    };
    setDecryptedIdentities(prev => ({ ...prev, [identity.id]: nextSecret }));

    const encrypted = await CryptoService.encryptSecretValue(
      JSON.stringify(nextSecret),
      vault.vaultKey
    );
    const updated = await updateEmailIdentity(
      identity.id,
      {
        encrypted_payload: encrypted.ciphertext,
        nonce: encrypted.nonce,
        crypto_version: encrypted.version,
        key_version: encrypted.key_version,
      },
      userId
    );
    setIdentities(prev => prev.map(i => (i.id === updated.id ? updated : i)));
  };

  const updateSubscriptionTodosEncrypted = async (
    sub: EmailSubscription,
    nextTodos: VaultTodoItem[]
  ) => {
    if (!vault.vaultKey || !userId) {
      ensureVaultUnlocked();
      return;
    }
    const currentSecret = decryptedSubscriptions[sub.id] || EMPTY_SUBSCRIPTION_SECRET;
    const nextSecret: SubscriptionSecretPayload = {
      ...currentSecret,
      todos: nextTodos,
    };
    setDecryptedSubscriptions(prev => ({ ...prev, [sub.id]: nextSecret }));

    const encrypted = await CryptoService.encryptSecretValue(
      JSON.stringify(nextSecret),
      vault.vaultKey
    );
    const updated = await updateEmailSubscription(
      sub.id,
      {
        encrypted_payload: encrypted.ciphertext,
        nonce: encrypted.nonce,
        crypto_version: encrypted.version,
        key_version: encrypted.key_version,
      },
      userId
    );
    setSubscriptions(prev => prev.map(s => (s.id === updated.id ? updated : s)));
  };

  const handleAddInlineSubTodo = async (sub: EmailSubscription) => {
    const text = (newTodoTexts[sub.id] || '').trim();
    if (!text) return;
    if (!ensureVaultUnlocked()) return;
    const currentTodos = decryptedSubscriptions[sub.id]?.todos || [];
    const nextTodos: VaultTodoItem[] = [
      ...currentTodos,
      {
        id: crypto.randomUUID(),
        text,
        completed: false,
        created_at: new Date().toISOString(),
      },
    ];
    setNewTodoTexts(prev => ({ ...prev, [sub.id]: '' }));
    await updateSubscriptionTodosEncrypted(sub, nextTodos);
  };

  const handleAddInlineIdentityTodo = async (identity: EmailIdentity) => {
    const key = `identity_${identity.id}`;
    const text = (newTodoTexts[key] || '').trim();
    if (!text) return;
    if (!ensureVaultUnlocked()) return;
    const currentTodos = decryptedIdentities[identity.id]?.todos || [];
    const nextTodos: VaultTodoItem[] = [
      ...currentTodos,
      {
        id: crypto.randomUUID(),
        text,
        completed: false,
        created_at: new Date().toISOString(),
      },
    ];
    setNewTodoTexts(prev => ({ ...prev, [key]: '' }));
    await updateIdentityTodosEncrypted(identity, nextTodos);
  };

  // ─── Derived Metrics & Filtered Views ───────────────────────────────

  const selectedIdentity = useMemo(
    () => identities.find(i => i.id === selectedIdentityId) || null,
    [identities, selectedIdentityId]
  );

  const visibleSubscriptions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return subscriptions.filter(sub => {
      if (selectedIdentityId !== 'ALL' && sub.email_identity_id !== selectedIdentityId) {
        return false;
      }
      if (categoryFilter !== 'all' && sub.category !== categoryFilter) {
        return false;
      }
      if (statusFilter !== 'all' && sub.status !== statusFilter) {
        return false;
      }
      if (!q) return true;

      const parentEmail =
        identities.find(i => i.id === sub.email_identity_id)?.email.toLowerCase() || '';
      const decrypted = decryptedSubscriptions[sub.id];
      const purposeText = decrypted?.purposeNotes.toLowerCase() || '';
      const loginText = decrypted?.usernameOrLogin.toLowerCase() || '';
      const todoMatch =
        decrypted?.todos.some(t => t.text.toLowerCase().includes(q)) || false;

      return (
        sub.service_name.toLowerCase().includes(q) ||
        (sub.service_url && sub.service_url.toLowerCase().includes(q)) ||
        parentEmail.includes(q) ||
        purposeText.includes(q) ||
        loginText.includes(q) ||
        todoMatch
      );
    });
  }, [
    subscriptions,
    selectedIdentityId,
    categoryFilter,
    statusFilter,
    searchQuery,
    identities,
    decryptedSubscriptions,
  ]);

  const stats = useMemo(() => {
    const scopedSubs =
      selectedIdentityId === 'ALL'
        ? subscriptions
        : subscriptions.filter(s => s.email_identity_id === selectedIdentityId);

    let monthlyEquivalent = 0;
    let activeCount = 0;
    let openTodos = 0;

    for (const sub of scopedSubs) {
      if (sub.status === 'active' || sub.status === 'trial') {
        activeCount += 1;
        if (sub.billing_cycle === 'monthly') {
          monthlyEquivalent += Number(sub.cost_amount) || 0;
        } else if (sub.billing_cycle === 'yearly') {
          monthlyEquivalent += (Number(sub.cost_amount) || 0) / 12;
        }
      }
      const subTodosList = decryptedSubscriptions[sub.id]?.todos || [];
      openTodos += subTodosList.filter(t => !t.completed).length;
    }

    if (selectedIdentityId === 'ALL') {
      for (const idItem of identities) {
        const idTodosList = decryptedIdentities[idItem.id]?.todos || [];
        openTodos += idTodosList.filter(t => !t.completed).length;
      }
    } else if (selectedIdentityId) {
      const idTodosList = decryptedIdentities[selectedIdentityId]?.todos || [];
      openTodos += idTodosList.filter(t => !t.completed).length;
    }

    return {
      totalIdentities: identities.length,
      scopedSubCount: scopedSubs.length,
      activeCount,
      monthlyEquivalent,
      openTodos,
    };
  }, [
    identities,
    subscriptions,
    selectedIdentityId,
    decryptedSubscriptions,
    decryptedIdentities,
  ]);

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-[#6F767E] dark:text-[#9A9FA5]">
        Loading encrypted email identities & subscriptions vault...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header & Action Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl sm:text-2xl font-extrabold text-[#1A1D1F] dark:text-white tracking-tight">
              Email Identities & Subscriptions Vault
            </h2>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#E3F5E1] text-[#2A9D5C] dark:bg-emerald-950/80 dark:text-emerald-300">
              <Shield className="w-3 h-3" /> AES-256-GCM Encrypted
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[#6F767E] dark:text-[#9A9FA5] mt-1">
            Organize all your email addresses, track every subscription & service registered per
            email, and store encrypted passwords, purpose notes, and action todos.
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={() => openNewIdentityModal()}
            className="px-4 py-2.5 rounded-full bg-white dark:bg-[#1A1D1F] hover:bg-black/5 dark:hover:bg-white/10 text-[#1A1D1F] dark:text-white border border-black/[0.08] dark:border-white/10 text-xs font-bold flex items-center gap-2 shadow-xs transition cursor-pointer"
          >
            <Mail className="w-3.5 h-3.5 text-indigo-500" /> + Add Email Address
          </button>
          <button
            type="button"
            onClick={() => openNewSubscriptionModal(selectedIdentityId)}
            className="px-5 py-2.5 rounded-full bg-[#1A1D1F] hover:bg-[#272B30] dark:bg-white dark:text-[#1A1D1F] dark:hover:bg-slate-200 text-white text-xs font-bold flex items-center gap-2 shadow-[0_4px_14px_rgba(0,0,0,0.12)] transition cursor-pointer"
          >
            <Plus className="w-4 h-4" /> Add Subscription / Service
          </button>
        </div>
      </div>

      {/* Zero-Knowledge Vault Status Banner if Locked */}
      {(vault.isLocked || !vault.vaultKey) && (
        <div className="rounded-3xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-amber-950 dark:text-amber-200">
                Zero-Knowledge Vault is Locked
              </h3>
              <p className="text-xs text-amber-800 dark:text-amber-300/90 mt-0.5">
                Passwords, recovery codes, purpose notes, and todo checklists are encrypted
                client-side with AES-256-GCM. Unlock your vault to decrypt, view, or add entries.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!vault.isInitialized) navigate('/onboarding');
              else openVaultModal();
            }}
            className="px-4 py-2.5 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-2 shrink-0 cursor-pointer shadow-xs"
          >
            <Unlock className="w-3.5 h-3.5" />
            {vault.isInitialized ? 'Unlock Vault Now' : 'Initialize Vault'}
          </button>
        </div>
      )}

      {errorBanner && (
        <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 p-4 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
          <span>{errorBanner}</span>
          <button type="button" onClick={() => setErrorBanner(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Summary Bento KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-5 border border-black/[0.04] dark:border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-[#6F767E] dark:text-[#9A9FA5] text-xs font-semibold">
            <span>Managed Emails</span>
            <Mail className="w-4 h-4 text-indigo-500" />
          </div>
          <p className="text-2xl font-extrabold text-[#1A1D1F] dark:text-white mt-2">
            {stats.totalIdentities}
          </p>
          <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] mt-1">
            Isolated per-email identity vaults
          </p>
        </div>

        <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-5 border border-black/[0.04] dark:border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-[#6F767E] dark:text-[#9A9FA5] text-xs font-semibold">
            <span>Active Subscriptions</span>
            <CreditCard className="w-4 h-4 text-[#2A9D5C]" />
          </div>
          <p className="text-2xl font-extrabold text-[#1A1D1F] dark:text-white mt-2">
            {stats.activeCount}{' '}
            <span className="text-xs font-normal text-[#6F767E]">/ {stats.scopedSubCount}</span>
          </p>
          <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] mt-1">
            {selectedIdentity ? `Linked to ${selectedIdentity.email}` : 'Across all your emails'}
          </p>
        </div>

        <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-5 border border-black/[0.04] dark:border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-[#6F767E] dark:text-[#9A9FA5] text-xs font-semibold">
            <span>Est. Monthly Spend</span>
            <Sparkles className="w-4 h-4 text-amber-500" />
          </div>
          <p className="text-2xl font-extrabold text-[#1A1D1F] dark:text-white mt-2">
            ${stats.monthlyEquivalent.toFixed(2)}
            <span className="text-xs font-normal text-[#6F767E]">/mo</span>
          </p>
          <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] mt-1">
            Active & trial subscriptions
          </p>
        </div>

        <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-5 border border-black/[0.04] dark:border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-[#6F767E] dark:text-[#9A9FA5] text-xs font-semibold">
            <span>Encrypted Action Todos</span>
            <CheckSquare className="w-4 h-4 text-purple-500" />
          </div>
          <p className="text-2xl font-extrabold text-[#1A1D1F] dark:text-white mt-2">
            {vault.isLocked ? '🔒' : stats.openTodos}
          </p>
          <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] mt-1">
            Pending reminders & purpose tasks
          </p>
        </div>
      </div>

      {/* Main Two-Column Layout: Left = Email Addresses List, Right = Selected Email Vault & Subscriptions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Email Identities Directory */}
        <div className="lg:col-span-4 space-y-3">
          <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-4 border border-black/[0.04] dark:border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.02)] space-y-3">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#6F767E] dark:text-[#9A9FA5]">
                Your Email Addresses ({identities.length})
              </h3>
              <button
                type="button"
                onClick={() => openNewIdentityModal()}
                className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> Add Email
              </button>
            </div>

            {/* All Emails Overview Selector */}
            <button
              type="button"
              onClick={() => setSelectedIdentityId('ALL')}
              className={`w-full text-left p-3.5 rounded-2xl transition flex items-center justify-between cursor-pointer border ${
                selectedIdentityId === 'ALL'
                  ? 'bg-[#1A1D1F] text-white dark:bg-white dark:text-[#1A1D1F] border-transparent shadow-sm'
                  : 'bg-[#F4F4F2]/70 dark:bg-white/5 text-[#1A1D1F] dark:text-white border-black/[0.04] dark:border-white/5 hover:bg-[#F4F4F2]'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    selectedIdentityId === 'ALL'
                      ? 'bg-white/15 dark:bg-black/10'
                      : 'bg-white dark:bg-[#1A1D1F]'
                  }`}
                >
                  <Globe className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold truncate">All Email Identities</p>
                  <p
                    className={`text-[11px] truncate ${
                      selectedIdentityId === 'ALL'
                        ? 'text-white/75 dark:text-black/70'
                        : 'text-[#6F767E] dark:text-[#9A9FA5]'
                    }`}
                  >
                    View all {subscriptions.length} subscriptions across {identities.length} emails
                  </p>
                </div>
              </div>
              <span
                className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                  selectedIdentityId === 'ALL'
                    ? 'bg-white/20 dark:bg-black/15'
                    : 'bg-white dark:bg-white/10'
                }`}
              >
                {subscriptions.length}
              </span>
            </button>

            {/* Individual Email Cards */}
            {identities.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/15 dark:border-white/15 p-5 text-center space-y-3">
                <Mail className="w-8 h-8 text-indigo-500 mx-auto opacity-80" />
                <div>
                  <p className="text-xs font-bold text-[#1A1D1F] dark:text-white">
                    No email addresses added yet
                  </p>
                  <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] mt-1">
                    Add your personal, work, or DevOps email to start tracking subscriptions,
                    passwords, and encrypted purpose notes.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  {profile?.email && (
                    <button
                      type="button"
                      onClick={() => openNewIdentityModal(profile.email)}
                      className="w-full py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition cursor-pointer"
                    >
                      + Add {profile.email}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => openNewIdentityModal('')}
                    className="w-full py-2 px-3 rounded-xl bg-[#F4F4F2] dark:bg-white/10 text-[#1A1D1F] dark:text-white text-xs font-semibold hover:opacity-90 transition cursor-pointer"
                  >
                    + Add Custom Email
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
                {identities.map(identity => {
                  const isSelected = selectedIdentityId === identity.id;
                  const subList = subscriptions.filter(s => s.email_identity_id === identity.id);
                  const activeSubs = subList.filter(
                    s => s.status === 'active' || s.status === 'trial'
                  );
                  const dec = decryptedIdentities[identity.id];
                  const pendingIdentityTodos =
                    dec?.todos.filter(t => !t.completed).length || 0;
                  const pendingSubTodos = subList.reduce((acc, s) => {
                    const st = decryptedSubscriptions[s.id]?.todos || [];
                    return acc + st.filter(t => !t.completed).length;
                  }, 0);
                  const totalOpenTodos = pendingIdentityTodos + pendingSubTodos;

                  return (
                    <div
                      key={identity.id}
                      onClick={() => setSelectedIdentityId(identity.id)}
                      className={`p-3.5 rounded-2xl border transition cursor-pointer ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                          : 'bg-[#F4F4F2]/60 dark:bg-white/[0.04] text-[#1A1D1F] dark:text-white border-black/[0.05] dark:border-white/10 hover:bg-[#F4F4F2] dark:hover:bg-white/[0.08]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span
                              className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                                isSelected
                                  ? 'bg-white/20 text-white'
                                  : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                              }`}
                            >
                              {identity.alias_label}
                            </span>
                            <span
                              className={`text-[10px] font-medium ${
                                isSelected ? 'text-white/80' : 'text-[#6F767E] dark:text-[#9A9FA5]'
                              }`}
                            >
                              {identity.provider}
                            </span>
                          </div>
                          <p className="text-xs sm:text-sm font-bold truncate mt-1.5">
                            {identity.email}
                          </p>
                        </div>

                        <div
                          className="flex items-center gap-1 shrink-0"
                          onClick={e => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => copyValue(`email_${identity.id}`, identity.email)}
                            title="Copy email address"
                            className={`p-1.5 rounded-lg transition ${
                              isSelected
                                ? 'hover:bg-white/20 text-white'
                                : 'hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]'
                            }`}
                          >
                            {copiedKey === `email_${identity.id}` ? (
                              <Check className="w-3.5 h-3.5 text-emerald-300" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditIdentityModal(identity)}
                            title="Edit email & encrypted credentials"
                            className={`p-1.5 rounded-lg transition ${
                              isSelected
                                ? 'hover:bg-white/20 text-white'
                                : 'hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]'
                            }`}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteIdentity(identity)}
                            title="Delete email identity"
                            className={`p-1.5 rounded-lg transition ${
                              isSelected
                                ? 'hover:bg-rose-500/40 text-white'
                                : 'hover:bg-rose-50 dark:hover:bg-rose-950/60 text-rose-500'
                            }`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {!vault.isLocked && dec?.purposeNotes && (
                        <p
                          className={`text-[11px] line-clamp-1 mt-1.5 ${
                            isSelected ? 'text-white/85' : 'text-[#6F767E] dark:text-[#9A9FA5]'
                          }`}
                        >
                          Purpose: {dec.purposeNotes}
                        </p>
                      )}

                      <div className="flex items-center justify-between gap-2 mt-3 pt-2.5 border-t border-current/10 text-[11px]">
                        <span>
                          <strong>{activeSubs.length}</strong> active / {subList.length} services
                        </span>
                        {!vault.isLocked && totalOpenTodos > 0 && (
                          <span
                            className={`px-2 py-0.5 rounded-full font-semibold ${
                              isSelected
                                ? 'bg-white/20 text-white'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                            }`}
                          >
                            {totalOpenTodos} todo{totalOpenTodos === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Selected Email's Encrypted Vault + Subscriptions List */}
        <div className="lg:col-span-8 space-y-5">
          {/* Selected Email Account Vault Card (when a specific email is selected) */}
          {selectedIdentity && (
            <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-6 border border-black/[0.05] dark:border-white/10 shadow-[0_4px_20px_rgba(0,0,0,0.03)] space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/[0.06] dark:border-white/10 pb-4">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                    <Mail className="w-6 h-6" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base sm:text-lg font-extrabold text-[#1A1D1F] dark:text-white truncate">
                        {selectedIdentity.email}
                      </h3>
                      <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                        {selectedIdentity.alias_label}
                      </span>
                      <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-[#F4F4F2] dark:bg-white/10 text-[#6F767E] dark:text-[#9A9FA5]">
                        {selectedIdentity.provider}
                      </span>
                    </div>
                    <p className="text-xs text-[#6F767E] dark:text-[#9A9FA5] mt-0.5">
                      Master Email Vault — Encrypted credentials, purpose notes & email-level todos
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEditIdentityModal(selectedIdentity)}
                    className="px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-xs font-bold text-[#1A1D1F] dark:text-white flex items-center gap-1.5 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" /> Edit Email Vault
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewSubscriptionModal(selectedIdentity.id)}
                    className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Subscription Here
                  </button>
                </div>
              </div>

              {/* Email-Level Encrypted Password, Recovery, Purpose & Todos */}
              {vault.isLocked || !vault.vaultKey ? (
                <div className="rounded-2xl bg-[#F4F4F2]/80 dark:bg-white/[0.03] p-4 flex items-center justify-between">
                  <div className="flex items-center gap-2.5 text-xs text-[#6F767E] dark:text-[#9A9FA5]">
                    <Lock className="w-4 h-4 text-amber-500" />
                    <span>
                      Email password, recovery info, purpose notes, and todos are encrypted
                      (AES-256-GCM).
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={openVaultModal}
                    className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    Unlock Vault
                  </button>
                </div>
              ) : (
                (() => {
                  const idSecret =
                    decryptedIdentities[selectedIdentity.id] || EMPTY_IDENTITY_SECRET;
                  const pwdRevealKey = `id_pwd_${selectedIdentity.id}`;
                  const isPwdRevealed = Boolean(revealedIds[pwdRevealKey]);
                  const todoInputKey = `identity_${selectedIdentity.id}`;

                  return (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Email Credentials & Purpose Box */}
                      <div className="rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.04] p-4 space-y-3 border border-black/[0.04] dark:border-white/5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-[#6F767E] dark:text-[#9A9FA5] flex items-center gap-1.5">
                            <Key className="w-3.5 h-3.5 text-indigo-500" /> Email Password & Purpose
                          </span>
                          <span className="text-[10px] font-mono text-[#2A9D5C]">AES-256-GCM</span>
                        </div>

                        <div className="bg-white dark:bg-[#111315] rounded-xl p-2.5 border border-black/[0.05] dark:border-white/10 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[10px] text-[#6F767E] uppercase font-semibold">
                              Email Account Password
                            </p>
                            <p className="text-xs font-mono font-semibold text-[#1A1D1F] dark:text-white truncate mt-0.5">
                              {idSecret.emailPassword
                                ? isPwdRevealed
                                  ? idSecret.emailPassword
                                  : '••••••••••••••••'
                                : 'No password stored (click Edit)'}
                            </p>
                          </div>
                          {idSecret.emailPassword && (
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => toggleReveal(pwdRevealKey)}
                                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
                                title={isPwdRevealed ? 'Hide secret' : 'Reveal secret'}
                              >
                                {isPwdRevealed ? (
                                  <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => copyValue(pwdRevealKey, idSecret.emailPassword)}
                                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
                                title="Copy password"
                              >
                                {copiedKey === pwdRevealKey ? (
                                  <Check className="w-3.5 h-3.5 text-[#2A9D5C]" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          )}
                        </div>

                        {idSecret.recoveryInfo && (
                          <div className="text-xs">
                            <span className="text-[10px] font-bold uppercase text-[#6F767E] block">
                              Recovery / 2FA Info:
                            </span>
                            <p className="text-[#1A1D1F] dark:text-slate-200 font-mono text-[11px] mt-0.5 break-all">
                              {idSecret.recoveryInfo}
                            </p>
                          </div>
                        )}

                        <div className="text-xs pt-1">
                          <span className="text-[10px] font-bold uppercase text-[#6F767E] block">
                            What Purpose This Email Is Used For:
                          </span>
                          <p className="text-[#1A1D1F] dark:text-slate-200 mt-0.5 whitespace-pre-wrap">
                            {idSecret.purposeNotes ||
                              'No purpose note added yet. Click "Edit Email Vault" to describe what you use this email for.'}
                          </p>
                        </div>
                      </div>

                      {/* Email-Level Encrypted Todo Checklist */}
                      <div className="rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.04] p-4 space-y-3 border border-black/[0.04] dark:border-white/5 flex flex-col justify-between">
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-[#6F767E] dark:text-[#9A9FA5] flex items-center gap-1.5">
                              <CheckSquare className="w-3.5 h-3.5 text-purple-500" /> Email Todo &
                              Notes ({idSecret.todos.filter(t => !t.completed).length} open)
                            </span>
                          </div>

                          {idSecret.todos.length === 0 ? (
                            <p className="text-xs text-[#6F767E] dark:text-[#9A9FA5] py-2">
                              No email-level todos yet. Add reminders below (e.g. "Rotate recovery
                              codes", "Check billing statements").
                            </p>
                          ) : (
                            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                              {idSecret.todos.map(todo => (
                                <div
                                  key={todo.id}
                                  className="flex items-center justify-between gap-2 bg-white dark:bg-[#111315] px-2.5 py-1.5 rounded-xl border border-black/[0.04] dark:border-white/10"
                                >
                                  <label className="flex items-center gap-2 text-xs text-[#1A1D1F] dark:text-white cursor-pointer min-w-0 flex-1">
                                    <input
                                      type="checkbox"
                                      checked={todo.completed}
                                      onChange={() => {
                                        const next = idSecret.todos.map(t =>
                                          t.id === todo.id ? { ...t, completed: !t.completed } : t
                                        );
                                        updateIdentityTodosEncrypted(selectedIdentity, next);
                                      }}
                                      className="rounded accent-indigo-600 cursor-pointer"
                                    />
                                    <span
                                      className={`truncate ${
                                        todo.completed ? 'line-through text-[#9A9FA5]' : ''
                                      }`}
                                    >
                                      {todo.text}
                                    </span>
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = idSecret.todos.filter(t => t.id !== todo.id);
                                      updateIdentityTodosEncrypted(selectedIdentity, next);
                                    }}
                                    className="text-[#9A9FA5] hover:text-rose-500 p-0.5"
                                    title="Remove todo"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 pt-1">
                          <input
                            type="text"
                            value={newTodoTexts[todoInputKey] || ''}
                            onChange={e =>
                              setNewTodoTexts(prev => ({
                                ...prev,
                                [todoInputKey]: e.target.value,
                              }))
                            }
                            onKeyDown={e => {
                              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                handleAddInlineIdentityTodo(selectedIdentity);
                              }
                            }}
                            placeholder="Add encrypted todo for this email..."
                            className="flex-1 px-3 py-1.5 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.08] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleAddInlineIdentityTodo(selectedIdentity)}
                            className="px-3 py-1.5 rounded-xl bg-[#1A1D1F] dark:bg-white text-white dark:text-[#1A1D1F] text-xs font-bold cursor-pointer"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          )}

          {/* Filter & Search Bar for Subscriptions */}
          <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-4 border border-black/[0.04] dark:border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.02)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-[#6F767E] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search subscriptions, service URLs, purpose notes, or todos..."
                className="w-full pl-9 pr-4 py-2 rounded-2xl bg-[#F4F4F2] dark:bg-[#111315] text-xs font-medium text-[#1A1D1F] dark:text-white placeholder:text-[#9A9FA5] outline-none"
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value as SubscriptionCategory | 'all')}
                className="px-3 py-2 rounded-2xl bg-[#F4F4F2] dark:bg-[#111315] text-xs font-semibold text-[#1A1D1F] dark:text-white outline-none cursor-pointer"
              >
                <option value="all">All Categories</option>
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as SubscriptionStatus | 'all')}
                className="px-3 py-2 rounded-2xl bg-[#F4F4F2] dark:bg-[#111315] text-xs font-semibold text-[#1A1D1F] dark:text-white outline-none cursor-pointer capitalize"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active</option>
                <option value="trial">Trial</option>
                <option value="free">Free Tier</option>
                <option value="paused">Paused</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>

          {/* Subscriptions / Services Cards Grid */}
          {visibleSubscriptions.length === 0 ? (
            <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-10 border border-black/[0.04] dark:border-white/10 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto">
                <Key className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-[#1A1D1F] dark:text-white">
                {identities.length === 0
                  ? 'Start by adding your first Email Address'
                  : 'No subscriptions recorded for this filter yet'}
              </h3>
              <p className="text-xs text-[#6F767E] dark:text-[#9A9FA5] max-w-md mx-auto">
                {identities.length === 0
                  ? 'Once you add an email address, you can attach all subscriptions where that email is used, along with encrypted passwords, purpose notes, and todo checklists.'
                  : 'Add a subscription or service where this email address is registered (e.g., AWS, GitHub, OpenAI, Vercel, Cloudflare, Domain Registrar).'}
              </p>
              <div className="pt-2">
                {identities.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => openNewIdentityModal(profile?.email || '')}
                    className="px-5 py-2.5 rounded-full bg-[#1A1D1F] dark:bg-white text-white dark:text-[#1A1D1F] text-xs font-bold cursor-pointer"
                  >
                    + Add Email Identity
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openNewSubscriptionModal(selectedIdentityId)}
                    className="px-5 py-2.5 rounded-full bg-[#1A1D1F] dark:bg-white text-white dark:text-[#1A1D1F] text-xs font-bold cursor-pointer"
                  >
                    + Add Subscription for{' '}
                    {selectedIdentity ? selectedIdentity.email : 'Your Email'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {visibleSubscriptions.map(sub => {
                const parentIdentity = identities.find(i => i.id === sub.email_identity_id);
                const linkedProject = projects.find(p => p.id === sub.project_id);
                const subSecret = decryptedSubscriptions[sub.id] || EMPTY_SUBSCRIPTION_SECRET;
                const pwdKey = `sub_pwd_${sub.id}`;
                const loginKey = `sub_login_${sub.id}`;
                const isRevealed = Boolean(revealedIds[pwdKey]);
                const showCipher = cipherPreviewId === sub.id;

                return (
                  <div
                    key={sub.id}
                    className="bg-white dark:bg-[#1A1D1F] rounded-3xl p-5 sm:p-6 border border-black/[0.05] dark:border-white/10 shadow-[0_2px_14px_rgba(0,0,0,0.025)] space-y-4"
                  >
                    {/* Top Row: Service Info, Parent Email Badge, Cost & Actions */}
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-base font-extrabold text-[#1A1D1F] dark:text-white">
                            {sub.service_name}
                          </h4>
                          <span
                            className={`text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full ${
                              STATUS_STYLES[sub.status]
                            }`}
                          >
                            {sub.status}
                          </span>
                          <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full bg-[#F4F4F2] dark:bg-white/10 text-[#6F767E] dark:text-[#9A9FA5]">
                            {CATEGORY_LABELS[sub.category] || sub.category}
                          </span>
                          {linkedProject && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                              <FolderKanban className="w-3 h-3" /> {linkedProject.name}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-3 flex-wrap text-xs text-[#6F767E] dark:text-[#9A9FA5]">
                          {parentIdentity && (
                            <span className="inline-flex items-center gap-1 font-semibold text-[#1A1D1F] dark:text-slate-200">
                              <Mail className="w-3.5 h-3.5 text-indigo-500" />
                              {parentIdentity.email}
                            </span>
                          )}
                          {sub.service_url && (
                            <a
                              href={
                                sub.service_url.startsWith('http')
                                  ? sub.service_url
                                  : `https://${sub.service_url}`
                              }
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {sub.service_url.replace(/^https?:\/\//, '')}
                            </a>
                          )}
                          {sub.renewal_date && (
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="w-3 h-3" /> Renews {sub.renewal_date}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                        <div className="text-left sm:text-right">
                          <p className="text-sm font-extrabold text-[#1A1D1F] dark:text-white">
                            {sub.billing_cycle === 'free' || Number(sub.cost_amount) === 0
                              ? 'Free'
                              : `${sub.currency} ${Number(sub.cost_amount).toFixed(2)}`}
                          </p>
                          <p className="text-[10px] uppercase font-semibold text-[#6F767E] dark:text-[#9A9FA5]">
                            {sub.billing_cycle.replace('_', ' ')}
                          </p>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setCipherPreviewId(prev => (prev === sub.id ? null : sub.id))
                            }
                            title="Inspect AES-256-GCM ciphertext stored at rest"
                            className="p-2 rounded-xl hover:bg-[#F4F4F2] dark:hover:bg-white/10 text-[#6F767E] dark:text-[#9A9FA5]"
                          >
                            <Shield className="w-4 h-4 text-[#2A9D5C]" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditSubscriptionModal(sub)}
                            title="Edit subscription, password, purpose & todos"
                            className="p-2 rounded-xl hover:bg-[#F4F4F2] dark:hover:bg-white/10 text-[#1A1D1F] dark:text-white"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSubscription(sub)}
                            title="Delete subscription"
                            className="p-2 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/60 text-rose-500"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Ciphertext Proof Drawer (Optional inspection) */}
                    {showCipher && (
                      <div className="rounded-2xl bg-slate-950 text-emerald-400 p-3.5 font-mono text-[11px] space-y-1">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>ZERO-KNOWLEDGE AES-256-GCM STORAGE PROOF</span>
                          <span>IV/NONCE: {sub.nonce}</span>
                        </div>
                        <p className="break-all text-emerald-300/90">{sub.encrypted_payload}</p>
                      </div>
                    )}

                    {/* Encrypted Sections: 1) Password & Credentials, 2) Purpose Notes, 3) Action Todos */}
                    {vault.isLocked || !vault.vaultKey ? (
                      <div className="rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.03] p-4 flex items-center justify-between">
                        <span className="text-xs text-[#6F767E] dark:text-[#9A9FA5] flex items-center gap-2">
                          <Lock className="w-3.5 h-3.5 text-amber-500" />
                          Password details, purpose notes & todo checklist are encrypted.
                        </span>
                        <button
                          type="button"
                          onClick={openVaultModal}
                          className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                        >
                          Unlock to Decrypt
                        </button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 pt-1">
                        {/* 1. Password & Credentials Section (4 cols) */}
                        <div className="md:col-span-4 rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.04] p-3.5 space-y-2.5 border border-black/[0.04] dark:border-white/5">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#6F767E] dark:text-[#9A9FA5] flex items-center gap-1">
                              <Key className="w-3 h-3 text-amber-500" /> Password Details
                            </span>
                            <span className="text-[10px] text-[#2A9D5C] font-semibold">
                              Encrypted
                            </span>
                          </div>

                          {/* Login / Username */}
                          <div className="bg-white dark:bg-[#111315] rounded-xl px-2.5 py-2 border border-black/[0.04] dark:border-white/10 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[10px] text-[#6F767E]">Login / Email Used</p>
                              <p className="text-xs font-mono font-semibold text-[#1A1D1F] dark:text-white truncate">
                                {subSecret.usernameOrLogin || parentIdentity?.email || '—'}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                copyValue(
                                  loginKey,
                                  subSecret.usernameOrLogin || parentIdentity?.email || ''
                                )
                              }
                              className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
                              title="Copy login"
                            >
                              {copiedKey === loginKey ? (
                                <Check className="w-3.5 h-3.5 text-[#2A9D5C]" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>

                          {/* Password */}
                          <div className="bg-white dark:bg-[#111315] rounded-xl px-2.5 py-2 border border-black/[0.04] dark:border-white/10 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[10px] text-[#6F767E]">Service Password</p>
                              <p className="text-xs font-mono font-semibold text-[#1A1D1F] dark:text-white truncate">
                                {!subSecret.password
                                  ? 'Not set'
                                  : !isRevealed
                                    ? '••••••••••••••'
                                    : subSecret.password}
                              </p>
                            </div>
                            {subSecret.password && (
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => toggleReveal(pwdKey)}
                                  className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
                                  title={isRevealed ? 'Hide secret' : 'Show secret'}
                                >
                                  {isRevealed ? (
                                    <EyeOff className="w-3.5 h-3.5" />
                                  ) : (
                                    <Eye className="w-3.5 h-3.5" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => copyValue(pwdKey, subSecret.password)}
                                  className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
                                  title="Copy password"
                                >
                                  {copiedKey === pwdKey ? (
                                    <Check className="w-3.5 h-3.5 text-[#2A9D5C]" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            )}
                          </div>

                          {subSecret.twoFactorOrRecovery && (
                            <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] font-mono break-all">
                              2FA/Key: {subSecret.twoFactorOrRecovery}
                            </p>
                          )}
                        </div>

                        {/* 2. Encrypted Purpose Notes Section (4 cols) */}
                        <div className="md:col-span-4 rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.04] p-3.5 space-y-2 border border-black/[0.04] dark:border-white/5 flex flex-col justify-between">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#6F767E] dark:text-[#9A9FA5] flex items-center gap-1">
                                <FileText className="w-3 h-3 text-indigo-500" /> Purpose & Usage
                                Notes
                              </span>
                              <button
                                type="button"
                                onClick={() => openEditSubscriptionModal(sub)}
                                className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                              >
                                Edit Note
                              </button>
                            </div>
                            <p className="text-xs text-[#1A1D1F] dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                              {subSecret.purposeNotes ||
                                'No purpose description added yet. Click Edit to document why this subscription/email is used.'}
                            </p>
                          </div>
                          <div className="pt-2 border-t border-black/[0.05] dark:border-white/5 flex items-center justify-between text-[10px] text-[#6F767E]">
                            <span>Zero-knowledge encrypted note</span>
                            <span>Updated {new Date(sub.updated_at).toLocaleDateString()}</span>
                          </div>
                        </div>

                        {/* 3. Encrypted Todo / Action Items Section (4 cols) */}
                        <div className="md:col-span-4 rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.04] p-3.5 space-y-2.5 border border-black/[0.04] dark:border-white/5 flex flex-col justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#6F767E] dark:text-[#9A9FA5] flex items-center gap-1">
                                <CheckSquare className="w-3 h-3 text-purple-500" /> Todo Checklist (
                                {subSecret.todos.filter(t => !t.completed).length})
                              </span>
                            </div>

                            {subSecret.todos.length === 0 ? (
                              <p className="text-[11px] text-[#6F767E] dark:text-[#9A9FA5] py-1">
                                Add todos like "Cancel before renewal" or "Rotate API key".
                              </p>
                            ) : (
                              <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                                {subSecret.todos.map(todo => (
                                  <div
                                    key={todo.id}
                                    className="flex items-center justify-between gap-2 bg-white dark:bg-[#111315] px-2.5 py-1.5 rounded-xl border border-black/[0.04] dark:border-white/10"
                                  >
                                    <label className="flex items-center gap-2 text-xs text-[#1A1D1F] dark:text-white cursor-pointer min-w-0 flex-1">
                                      <input
                                        type="checkbox"
                                        checked={todo.completed}
                                        onChange={() => {
                                          const next = subSecret.todos.map(t =>
                                            t.id === todo.id
                                              ? { ...t, completed: !t.completed }
                                              : t
                                          );
                                          updateSubscriptionTodosEncrypted(sub, next);
                                        }}
                                        className="rounded accent-indigo-600 cursor-pointer"
                                      />
                                      <span
                                        className={`truncate ${
                                          todo.completed ? 'line-through text-[#9A9FA5]' : ''
                                        }`}
                                      >
                                        {todo.text}
                                      </span>
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const next = subSecret.todos.filter(
                                          t => t.id !== todo.id
                                        );
                                        updateSubscriptionTodosEncrypted(sub, next);
                                      }}
                                      className="text-[#9A9FA5] hover:text-rose-500 p-0.5"
                                      title="Delete todo"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={newTodoTexts[sub.id] || ''}
                              onChange={e =>
                                setNewTodoTexts(prev => ({ ...prev, [sub.id]: e.target.value }))
                              }
                              onKeyDown={e => {
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                  e.preventDefault();
                                  handleAddInlineSubTodo(sub);
                                }
                              }}
                              placeholder="New encrypted todo..."
                              className="flex-1 px-2.5 py-1.5 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.08] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => handleAddInlineSubTodo(sub)}
                              className="px-2.5 py-1.5 rounded-xl bg-[#1A1D1F] dark:bg-white text-white dark:text-[#1A1D1F] text-xs font-bold cursor-pointer"
                            >
                              +
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ─── Modal 1: Add / Edit Email Identity Vault ────────────────── */}
      {showIdentityModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl max-w-lg w-full p-6 border border-black/[0.08] dark:border-white/10 shadow-2xl space-y-5 my-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-[#1A1D1F] dark:text-white">
                    {editingIdentity ? 'Edit Email Identity Vault' : 'Add Email Identity'}
                  </h3>
                  <p className="text-xs text-[#6F767E] dark:text-[#9A9FA5]">
                    Credentials, purpose notes & todos are encrypted with AES-256-GCM
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowIdentityModal(false)}
                className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveIdentity} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  required
                  autoComplete="username"
                  value={identityEmail}
                  onChange={e => setIdentityEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-sm text-[#1A1D1F] dark:text-white outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Alias / Label *
                  </label>
                  <input
                    type="text"
                    required
                    value={identityAlias}
                    onChange={e => setIdentityAlias(e.target.value)}
                    placeholder="Personal, Work, DevOps, Billing..."
                    className="w-full px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Email Provider
                  </label>
                  <select
                    value={identityProvider}
                    onChange={e => setIdentityProvider(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                  >
                    <option value="Gmail">Gmail / Google Workspace</option>
                    <option value="Outlook / M365">Outlook / Microsoft 365</option>
                    <option value="ProtonMail">ProtonMail</option>
                    <option value="iCloud">Apple iCloud Mail</option>
                    <option value="Custom Domain">Custom Domain / Zoho / Fastmail</option>
                    <option value="Other">Other Provider</option>
                  </select>
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#F4F4F2]/70 dark:bg-white/[0.04] border border-black/[0.05] dark:border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-[#1A1D1F] dark:text-white flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-[#2A9D5C]" /> Encrypted Email Password &
                    Recovery
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setIdentityPassword(generateStrongPassword(20));
                      setShowIdentityModalPassword(true);
                    }}
                    className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    Generate Strong Password
                  </button>
                </div>

                <div className="relative">
                  <input
                    type={showIdentityModalPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={identityPassword}
                    onChange={e => setIdentityPassword(e.target.value)}
                    placeholder="Email account password (encrypted with AES-256-GCM)"
                    className="w-full pl-3.5 pr-10 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs font-mono text-[#1A1D1F] dark:text-white outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowIdentityModalPassword(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6F767E]"
                  >
                    {showIdentityModalPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <input
                  type="text"
                  value={identityRecovery}
                  onChange={e => setIdentityRecovery(e.target.value)}
                  placeholder="Recovery email, phone, or 2FA backup note (optional, encrypted)"
                  className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                  Encrypted Purpose Notes (Why do you use this email?)
                </label>
                <textarea
                  rows={2}
                  value={identityPurpose}
                  onChange={e => setIdentityPurpose(e.target.value)}
                  placeholder="e.g., Used for all production AWS, Supabase, and Vercel billing accounts..."
                  className="w-full px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                  Add Initial Encrypted Todo / Reminder (Optional)
                </label>
                <input
                  type="text"
                  value={identityTodoDraft}
                  onChange={e => setIdentityTodoDraft(e.target.value)}
                  placeholder="e.g., Enable hardware passkey on this Google account"
                  className="w-full px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowIdentityModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-[#6F767E] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingIdentity}
                  className="px-5 py-2.5 rounded-xl bg-[#1A1D1F] dark:bg-white text-white dark:text-[#1A1D1F] text-xs font-bold hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  {savingIdentity
                    ? 'Encrypting & Saving...'
                    : editingIdentity
                      ? 'Update Encrypted Email'
                      : 'Encrypt & Save Email'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Modal 2: Add / Edit Subscription & Encrypted Credentials/Purpose/Todo ─── */}
      {showSubModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-[#1A1D1F] rounded-3xl max-w-2xl w-full p-6 border border-black/[0.08] dark:border-white/10 shadow-2xl space-y-5 my-8 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 text-[#2A9D5C] flex items-center justify-center">
                  <Key className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-[#1A1D1F] dark:text-white">
                    {editingSub
                      ? `Edit Subscription — ${editingSub.service_name}`
                      : 'Add Subscription / Service for Email'}
                  </h3>
                  <p className="text-xs text-[#6F767E] dark:text-[#9A9FA5]">
                    Track where your email is used + encrypt password, purpose notes & todos
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSubModal(false)}
                className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-[#6F767E]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSubscription} className="space-y-4">
              {/* Row 1: Which Email + Optional Linked Project */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Email Address Used *
                  </label>
                  <select
                    required
                    value={subIdentityId}
                    onChange={e => {
                      const nextId = e.target.value;
                      setSubIdentityId(nextId);
                      const found = identities.find(i => i.id === nextId);
                      if (found && !subUsername) setSubUsername(found.email);
                    }}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs font-semibold text-[#1A1D1F] dark:text-white outline-none"
                  >
                    {identities.map(idItem => (
                      <option key={idItem.id} value={idItem.id}>
                        {idItem.email} ({idItem.alias_label})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Linked IDP Project (Optional)
                  </label>
                  <select
                    value={subProjectId}
                    onChange={e => setSubProjectId(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs font-semibold text-[#1A1D1F] dark:text-white outline-none"
                  >
                    <option value="">Not linked to a specific project</option>
                    {projects.map(proj => (
                      <option key={proj.id} value={proj.id}>
                        {proj.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Row 2: Service Name + Website URL */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Subscription / Service Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={subServiceName}
                    onChange={e => setSubServiceName(e.target.value)}
                    placeholder="e.g., AWS Production, Vercel Pro, OpenAI, GitHub..."
                    className="w-full px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Service / Login URL
                  </label>
                  <input
                    type="text"
                    value={subServiceUrl}
                    onChange={e => setSubServiceUrl(e.target.value)}
                    placeholder="https://console.aws.amazon.com"
                    className="w-full px-3.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>
              </div>

              {/* Row 3: Category, Status, Billing Cycle, Cost, Renewal Date */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Category
                  </label>
                  <select
                    value={subCategory}
                    onChange={e => setSubCategory(e.target.value as SubscriptionCategory)}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] text-xs text-[#1A1D1F] dark:text-white outline-none"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Status
                  </label>
                  <select
                    value={subStatus}
                    onChange={e => setSubStatus(e.target.value as SubscriptionStatus)}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] text-xs text-[#1A1D1F] dark:text-white outline-none"
                  >
                    <option value="active">Active</option>
                    <option value="trial">Trial</option>
                    <option value="free">Free Tier</option>
                    <option value="paused">Paused</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Billing Cycle
                  </label>
                  <select
                    value={subBillingCycle}
                    onChange={e => setSubBillingCycle(e.target.value as BillingCycle)}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] text-xs text-[#1A1D1F] dark:text-white outline-none"
                  >
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                    <option value="one_time">One-Time</option>
                    <option value="free">Free ($0)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Cost ({subCurrency})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={subCostAmount}
                    onChange={e => setSubCostAmount(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] text-xs text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-[11px] font-bold text-[#1A1D1F] dark:text-slate-200 mb-1">
                    Renewal Date
                  </label>
                  <input
                    type="date"
                    value={subRenewalDate}
                    onChange={e => setSubRenewalDate(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#F4F4F2] dark:bg-[#111315] text-xs text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>
              </div>

              {/* Encrypted Password & Credentials Block */}
              <div className="p-4 rounded-2xl bg-[#F4F4F2]/80 dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-[#1A1D1F] dark:text-white flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-[#2A9D5C]" /> Encrypted Password & Login
                    Section (AES-256-GCM)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSubPassword(generateStrongPassword(20));
                      setShowSubModalPassword(true);
                    }}
                    className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    Generate Strong Password
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-[#6F767E] mb-1">
                      Username / Login Email
                    </label>
                    <input
                      type="text"
                      autoComplete="username"
                      value={subUsername}
                      onChange={e => setSubUsername(e.target.value)}
                      placeholder="Login username or email"
                      className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs font-mono text-[#1A1D1F] dark:text-white outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-[#6F767E] mb-1">
                      Account Password (Encrypted)
                    </label>
                    <div className="relative">
                      <input
                        type={showSubModalPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={subPassword}
                        onChange={e => setSubPassword(e.target.value)}
                        placeholder="Enter password used on this service"
                        className="w-full pl-3 pr-9 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs font-mono text-[#1A1D1F] dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSubModalPassword(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6F767E]"
                      >
                        {showSubModalPassword ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[#6F767E] mb-1">
                    2FA / Recovery / API Key Note (Encrypted)
                  </label>
                  <input
                    type="text"
                    value={subTwoFactor}
                    onChange={e => setSubTwoFactor(e.target.value)}
                    placeholder="e.g., Authenticator App enabled, backup code in safe, org ID..."
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs font-mono text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>
              </div>

              {/* Encrypted Purpose Notes & Todo Section */}
              <div className="p-4 rounded-2xl bg-[#F4F4F2]/80 dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/10 space-y-3">
                <span className="text-xs font-extrabold text-[#1A1D1F] dark:text-white flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-indigo-500" /> Encrypted Purpose Notes &
                  Todo Checklist
                </span>

                <div>
                  <label className="block text-[11px] font-semibold text-[#6F767E] mb-1">
                    What Purpose We Used This Subscription For (Encrypted)
                  </label>
                  <textarea
                    rows={3}
                    value={subPurposeNotes}
                    onChange={e => setSubPurposeNotes(e.target.value)}
                    placeholder="Describe why this subscription/account was created, which project or client uses it, billing card used, etc."
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-[11px] font-semibold text-[#6F767E]">
                    Action Todos / Reminders for This Subscription (Encrypted)
                  </label>
                  {subTodos.length > 0 && (
                    <div className="space-y-1.5 max-h-28 overflow-y-auto">
                      {subTodos.map(t => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between bg-white dark:bg-[#111315] px-3 py-1.5 rounded-xl text-xs"
                        >
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={t.completed}
                              onChange={() =>
                                setSubTodos(prev =>
                                  prev.map(item =>
                                    item.id === t.id
                                      ? { ...item, completed: !item.completed }
                                      : item
                                  )
                                )
                              }
                            />
                            <span className={t.completed ? 'line-through text-[#9A9FA5]' : ''}>
                              {t.text}
                            </span>
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setSubTodos(prev => prev.filter(item => item.id !== t.id))
                            }
                            className="text-rose-500"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={subTodoDraft}
                      onChange={e => setSubTodoDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          if (subTodoDraft.trim()) {
                            setSubTodos(prev => [
                              ...prev,
                              {
                                id: crypto.randomUUID(),
                                text: subTodoDraft.trim(),
                                completed: false,
                                created_at: new Date().toISOString(),
                              },
                            ]);
                            setSubTodoDraft('');
                          }
                        }
                      }}
                      placeholder="e.g., Cancel trial before 15th, Rotate password..."
                      className="flex-1 px-3 py-2 rounded-xl bg-white dark:bg-[#111315] border border-black/[0.06] dark:border-white/10 text-xs text-[#1A1D1F] dark:text-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!subTodoDraft.trim()) return;
                        setSubTodos(prev => [
                          ...prev,
                          {
                            id: crypto.randomUUID(),
                            text: subTodoDraft.trim(),
                            completed: false,
                            created_at: new Date().toISOString(),
                          },
                        ]);
                        setSubTodoDraft('');
                      }}
                      className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold cursor-pointer"
                    >
                      + Add Todo
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSubModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-[#6F767E] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSub}
                  className="px-5 py-2.5 rounded-xl bg-[#1A1D1F] dark:bg-white text-white dark:text-[#1A1D1F] text-xs font-bold hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  {savingSub
                    ? 'Encrypting & Saving...'
                    : editingSub
                      ? 'Update Encrypted Subscription'
                      : 'Encrypt & Save Subscription'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
