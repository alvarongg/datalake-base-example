import { useState, type FormEvent } from 'react';
import { Button } from '@heroui/react';
import { Card, CardContent } from '@/components/ui/card';
import { AwsIcon } from '@/components/common';
import { login } from '@/lib/auth';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await login(email.trim(), password); onLogin(); }
    catch (err) { setError((err as Error).message || 'No se pudo iniciar sesión.'); }
    finally { setBusy(false); }
  }

  const input = 'w-full rounded-lg border border-border bg-field px-3 py-2.5 text-field-foreground outline-none focus:border-accent';
  return (
    <div className="grid min-h-full place-items-center bg-[radial-gradient(ellipse_at_top,var(--surface-secondary),transparent_60%)] p-6">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-8">
          <div className="flex items-center gap-3">
            <AwsIcon name="cognito" size={40} />
            <div>
              <h1 className="text-xl font-semibold">Data Lake Medallion</h1>
              <p className="text-sm text-muted">Landing → Bronze → Silver → Gold → Athena</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-3">
            <input className={input} type="email" placeholder="Email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className={input} type="password" placeholder="Contraseña" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" fullWidth isPending={busy}>Entrar</Button>
          </form>
          <p className="text-xs text-muted">El login usa Amazon Cognito con SRP: la contraseña nunca viaja por la red. No hay auto-registro; el usuario lo crea deplo.sh.</p>
        </CardContent>
      </Card>
    </div>
  );
}
