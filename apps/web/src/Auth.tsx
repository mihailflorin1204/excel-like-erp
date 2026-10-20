import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { api, type CurrentUser, SIGNED_OUT_EVENT } from './api.ts';

/** Shows setup, sign-in or a forced password change until someone is signed in, then the app. */
export function AuthGate({ children }: { children: (user: CurrentUser, authEnabled: boolean) => ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  useEffect(() => {
    const onSignedOut = () => void queryClient.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [queryClient]);
  const done = () => {
    // Everything cached belonged to whoever was signed in before.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };

  if (me.isPending) return <div className="auth-page"><p className="muted">Loading…</p></div>;
  if (me.isError) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p>Can't reach the API. Is it running? ({me.error.message})</p>
          <button onClick={() => me.refetch()}>Try again</button>
        </div>
      </div>
    );
  }
  const state = me.data;
  if (state.state === 'setup') return <SetupForm onDone={done} />;
  if (state.state === 'signedOut') return <LoginForm onDone={done} />;
  if (state.user.mustChangePassword) return <PasswordForm forced onDone={done} />;
  return <>{children(state.user, state.authEnabled)}</>;
}

function useSubmit(action: () => Promise<unknown>, onDone: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

function Field({ label, ...input }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <input {...input} />
    </label>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(() => api.login({ email, password }), onDone);
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">ERP</div>
        <h1>Sign in</h1>
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small">Forgot your password? Ask an admin to reset it.</p>
      </form>
    </div>
  );
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(() => api.setup({ name, email, password }), onDone);
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">ERP</div>
        <h1>Create the admin account</h1>
        <p className="muted small">This is a new installation. The account you create here can add other users.</p>
        <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Field label="Password (at least 10 characters)" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create and sign in'}</button>
      </form>
    </div>
  );
}

/** Change password: forced after a reset (full page), or from the user menu (in a dialog). */
export function PasswordForm({ forced = false, onDone, onCancel }: { forced?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const { error, busy, submit } = useSubmit(async () => {
    if (password !== repeat) throw new Error('The two new passwords are different');
    await api.changePassword({ current, password });
  }, onDone);
  const form = (
    <form className="auth-card" onSubmit={submit}>
      <h1>{forced ? 'Choose your password' : 'Change password'}</h1>
      {forced && <p className="muted small">You signed in with a temporary password. Pick your own to continue.</p>}
      <Field label={forced ? 'Temporary password' : 'Current password'} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
      <Field label="New password (at least 10 characters)" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
      <Field label="New password again" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="auth-actions">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
      </div>
    </form>
  );
  return forced ? <div className="auth-page">{form}</div> : <div className="modal-backdrop">{form}</div>;
}

/** Name, role, change password and sign out, at the bottom of the sidebar. */
export function UserMenu({ user, authEnabled }: { user: CurrentUser; authEnabled: boolean }) {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  if (!authEnabled) return <div className="user-menu muted small">Sign-in is off</div>;
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  };
  return (
    <div className="user-menu">
      <div className="user-name" title={user.email}>{user.name}</div>
      <div className="muted small">{user.role}</div>
      <div className="user-links">
        <button className="link" onClick={() => setChanging(true)}>Change password</button>
        <button className="link" onClick={() => void signOut()}>Sign out</button>
      </div>
      {changing && <PasswordForm onDone={() => setChanging(false)} onCancel={() => setChanging(false)} />}
    </div>
  );
}
