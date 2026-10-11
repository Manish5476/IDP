import { useState } from 'react';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { useAuth } from '@/stores/AuthContext';
import { CheckCircle, Database, Loader2, X } from 'lucide-react';

export default function ConnectionStatus() {
  const { isLoading, storageMode } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const status: 'checking' | 'connected' | 'local' = isLoading
    ? 'checking'
    : isSupabaseConfigured && storageMode === 'supabase'
      ? 'connected'
      : 'local';

  const message =
    status === 'checking'
      ? 'Checking storage...'
      : status === 'connected'
        ? 'Supabase Cloud + Local Sync active'
        : 'User-scoped Local Vault DB active';

  return (
    <div className="fixed bottom-4 right-4 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg px-3.5 py-2.5 flex items-center gap-2.5 text-xs">
      {status === 'checking' && <Loader2 className="w-4 h-4 text-indigo-500 animate-spin shrink-0" />}
      {status === 'connected' && <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />}
      {status === 'local' && <Database className="w-4 h-4 text-indigo-500 shrink-0" />}
      <div>
        <span className="font-semibold text-slate-900 dark:text-white mr-1.5">Storage:</span>
        <span className="text-slate-600 dark:text-slate-400">{message}</span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="ml-1 p-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600"
        aria-label="Dismiss storage status"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
