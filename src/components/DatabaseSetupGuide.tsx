import { useState, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { useAuth } from '@/stores/AuthContext';
import { Database, ExternalLink, Copy, Check, X } from 'lucide-react';

const SCHEMA_VERIFIED_KEY = 'idp_supabase_schema_verified';

export default function DatabaseSetupGuide() {
  const { user, storageMode } = useAuth();
  const [status, setStatus] = useState<'checking' | 'ready' | 'needs_setup'>('ready');
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured || !user || storageMode !== 'supabase') {
      setStatus('ready');
      return;
    }
    if (typeof window !== 'undefined' && window.sessionStorage.getItem(SCHEMA_VERIFIED_KEY) === '1') {
      setStatus('ready');
      return;
    }
    async function checkDatabase() {
      try {
        const { error } = await supabase.from('profiles').select('id').limit(1);
        if (error && (error.message.includes('does not exist') || error.code === '42P01')) {
          setStatus('needs_setup');
        } else {
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem(SCHEMA_VERIFIED_KEY, '1');
          }
          setStatus('ready');
        }
      } catch {
        setStatus('ready');
      }
    }
    checkDatabase();
  }, [user, storageMode]);

  const handleCopy = () => {
    const sqlInstructions = `Go to your Supabase Dashboard → SQL Editor → New Query, then paste the contents of supabase/migrations/001_initial_schema.sql and click Run.`;
    navigator.clipboard.writeText(sqlInstructions);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (status === 'ready' || status === 'checking' || dismissed) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 max-w-lg w-full p-6 relative">
        <button
          onClick={() => setDismissed(true)}
          className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
          aria-label="Close setup guide"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/60 flex items-center justify-center">
            <Database className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Supabase Schema Optional Setup</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Local user-scoped persistence is active. Run migrations to sync with Supabase tables.
            </p>
          </div>
        </div>

        <div className="bg-slate-50 dark:bg-slate-800/70 rounded-xl p-4 mb-4 text-xs text-slate-600 dark:text-slate-300 space-y-1.5">
          <p>1. Open your Supabase SQL Editor and create a New Query.</p>
          <p>2. Run the SQL files inside <code className="font-mono px-1 py-0.5 bg-slate-200 dark:bg-slate-700 rounded">supabase/migrations/</code> in order (001 to 004).</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setDismissed(true)}
            className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition"
          >
            Continue with Local Hybrid Storage
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy SQL Hint'}
          </button>
          <a
            href="https://supabase.com/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
