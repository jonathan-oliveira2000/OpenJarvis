import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, LogIn, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../lib/api';
import { useAuthStore, type AuthUser } from '../lib/auth';
import { initAnalytics } from '../lib/analytics';
import {
  clearLegacyConversations,
  readLegacyConversations,
  useAppStore,
} from '../lib/store';
import { useTtsStore } from '../lib/tts';
import type { Conversation } from '../types';

interface AuthGateProps {
  children: ReactNode;
}

type FormMode = 'login' | 'register';

interface AuthFormReset {
  mode: FormMode;
  name: string;
  password: string;
  confirmation: string;
  showPassword: boolean;
  busy: boolean;
  error: string;
}

export function getAuthFormReset(name = ''): AuthFormReset {
  return {
    mode: 'login',
    name: name.trim(),
    password: '',
    confirmation: '',
    showPassword: false,
    busy: false,
    error: '',
  };
}

export function completeRegistration(name: string): AuthFormReset {
  toast.success('Conta criada com sucesso! Faça login para continuar.');
  return getAuthFormReset(name);
}

const UNEXPECTED_SERVER_RESPONSE =
  'O servidor não respondeu como esperado. Verifique se o backend está rodando e atualizado.';

export async function readAuthJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new Error(UNEXPECTED_SERVER_RESPONSE);
  }
  return (await response.json()) as T;
}

async function prepareUser(
  user: AuthUser,
  isActive: () => boolean = () => true,
): Promise<void> {
  if (user.role === 'admin') {
    const legacy = readLegacyConversations();
    const imported = await apiFetch('/v1/conversations/legacy-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: legacy }),
    });
    if (!imported.ok) {
      throw new Error('Não foi possível migrar o histórico antigo.');
    }
  }
  if (!isActive()) return;
  const historyResponse = await apiFetch('/v1/conversations');
  if (!historyResponse.ok) {
    throw new Error('Não foi possível carregar seu histórico.');
  }
  const history = (await historyResponse.json()) as {
    conversations: Conversation[];
  };
  if (!isActive()) return;
  useAppStore.getState().activateUserConversations(user.id, history.conversations);
  if (user.role === 'admin') clearLegacyConversations();
  useAuthStore.getState().setUser(user);
  void initAnalytics();
}

function getErrorMessage(response: Response, body: { detail?: string }): string {
  if (response.status === 429) return 'Muitas tentativas. Aguarde antes de tentar novamente.';
  if (response.status === 409) return body.detail || 'Esse nome já está em uso.';
  if (response.status === 422) return body.detail || 'Confira os dados informados.';
  return body.detail || 'Não foi possível entrar. Verifique os dados e tente novamente.';
}

export function AuthGate({ children }: AuthGateProps) {
  const status = useAuthStore((state) => state.status);
  const sessionExpired = useAuthStore((state) => state.sessionExpired);
  const clearUser = useAuthStore((state) => state.clearUser);
  const [mode, setMode] = useState<FormMode>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const previousStatus = useRef(status);

  useEffect(() => {
    if (previousStatus.current === 'authenticated' && status === 'unauthenticated') {
      const reset = getAuthFormReset();
      setMode(reset.mode);
      setName(reset.name);
      setPassword(reset.password);
      setConfirmation(reset.confirmation);
      setShowPassword(reset.showPassword);
      setBusy(reset.busy);
      setError(reset.error);
    }
    previousStatus.current = status;
  }, [status]);

  const checkSession = useCallback(async (alive: () => boolean) => {
    setConnectionError('');
    try {
      const response = await apiFetch('/auth/me');
      const data = await readAuthJson<{ user?: AuthUser; detail?: string }>(response);
      if (response.status === 401) {
        if (alive()) clearUser(false);
        return;
      }
      if (!response.ok) throw new Error('Não foi possível verificar a sessão.');
      if (!data.user) throw new Error('Não foi possível verificar a sessão.');
      if (!alive()) return;
      await prepareUser(data.user, alive);
    } catch (reason) {
      if (alive()) {
        setConnectionError(
          reason instanceof Error
            ? reason.message
            : 'Não foi possível conectar ao servidor.',
        );
        if (useAuthStore.getState().status === 'checking') clearUser(false);
      }
    }
  }, [clearUser]);

  useEffect(() => {
    let active = true;
    void checkSession(() => active);
    return () => {
      active = false;
    };
  }, [checkSession]);

  useEffect(() => {
    const onExpired = () => {
      useTtsStore.getState().stop();
      useAppStore.getState().clearUserData();
      clearUser(true);
    };
    window.addEventListener('openjarvis:auth-expired', onExpired);
    const onHistorySyncError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      toast.error(message || 'Não foi possível sincronizar o histórico.');
    };
    window.addEventListener('openjarvis:history-sync-error', onHistorySyncError);
    return () => {
      window.removeEventListener('openjarvis:auth-expired', onExpired);
      window.removeEventListener('openjarvis:history-sync-error', onHistorySyncError);
    };
  }, [clearUser]);

  useEffect(() => {
    if (status === 'unauthenticated') nameInput.current?.focus();
  }, [mode, status]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      setError('O nome deve ter pelo menos 3 caracteres.');
      return;
    }
    if (password.length < 8) {
      setError('A senha deve ter pelo menos 8 caracteres.');
      return;
    }
    if (mode === 'register' && password !== confirmation) {
      setError('As senhas não coincidem.');
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch(
        mode === 'login' ? '/auth/login' : '/auth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName, password }),
        },
      );
      const body = await readAuthJson<{
        user?: AuthUser;
        detail?: string;
      }>(response);
      if (!response.ok || !body.user) {
        setError(getErrorMessage(response, body));
        return;
      }
      if (mode === 'register') {
        const reset = completeRegistration(trimmedName);
        setMode(reset.mode);
        setName(reset.name);
        setPassword(reset.password);
        setConfirmation(reset.confirmation);
        setShowPassword(reset.showPassword);
        setBusy(reset.busy);
        setError(reset.error);
        return;
      }
      await prepareUser(body.user);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Não foi possível conectar ao servidor.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (status === 'authenticated') return children;

  if (status === 'checking' || connectionError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-6 text-[var(--color-text)]">
        <section className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center shadow-xl">
          {connectionError ? (
            <>
              <h1 className="text-xl font-semibold">Não foi possível conectar</h1>
              <p className="mt-3 text-sm text-[var(--color-text-secondary)]">
                {connectionError}
              </p>
              <button
                type="button"
                className="mt-6 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-white"
                onClick={() => {
                  useAuthStore.setState({ status: 'checking' });
                  void checkSession(() => true);
                }}
              >
                Tentar novamente
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="mx-auto animate-spin text-[var(--color-accent)]" size={28} />
              <p className="mt-4 text-sm text-[var(--color-text-secondary)]">
                Verificando sua sessão…
              </p>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-6 py-10 text-[var(--color-text)]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-2xl"
      >
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-[var(--color-accent)]">
            {mode === 'login' ? <LogIn size={22} /> : <UserPlus size={22} />}
          </div>
          <h1 id="auth-title" className="text-2xl font-semibold">
            {mode === 'login' ? 'Entrar na M.E.G.A.' : 'Criar uma conta'}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            {mode === 'login'
              ? 'Entre para acessar suas conversas e ferramentas.'
              : 'O nome precisa ter 3 caracteres e a senha 8 caracteres.'}
          </p>
        </div>

        {sessionExpired && (
          <p role="status" className="mb-4 rounded-lg bg-[var(--color-accent-subtle)] p-3 text-sm">
            Sua sessão expirou. Faça login novamente.
          </p>
        )}
        {error && (
          <p role="alert" className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="auth-name">
            Nome
            <input
              ref={nameInput}
              id="auth-name"
              name="name"
              autoComplete="username"
              required
              minLength={3}
              maxLength={128}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 py-2.5 font-normal outline-none focus:border-[var(--color-accent)]"
            />
          </label>

          <label className="block text-sm font-medium" htmlFor="auth-password">
            Senha
            <input
              id="auth-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 py-2.5 font-normal outline-none focus:border-[var(--color-accent)]"
            />
          </label>

          {mode === 'register' && (
            <label className="block text-sm font-medium" htmlFor="auth-confirm-password">
              Confirmar senha
              <input
                id="auth-confirm-password"
                name="confirm-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 py-2.5 font-normal outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          )}

          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
            />
            Mostrar senha
          </label>

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-medium text-white transition-opacity disabled:cursor-wait disabled:opacity-60"
          >
            {busy && <LoaderCircle className="animate-spin" size={17} />}
            {mode === 'login' ? 'Logar' : 'Cadastrar'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
          {mode === 'login' ? 'Ainda não tem uma conta?' : 'Já tem uma conta?'}{' '}
          <button
            type="button"
            className="font-medium text-[var(--color-accent)] underline underline-offset-2"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setPassword('');
              setConfirmation('');
              setError('');
            }}
          >
            {mode === 'login' ? 'Cadastre-se' : 'Voltar ao login'}
          </button>
        </p>
      </section>
    </main>
  );
}
