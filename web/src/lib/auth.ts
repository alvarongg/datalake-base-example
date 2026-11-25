// Autenticación con Cognito (flujo SRP: la contraseña nunca viaja por la red).
import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';

export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
}

let pool: CognitoUserPool | null = null;

/** config.json lo genera deplo.sh a partir de las salidas de CloudFormation. */
export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No se encontró config.json');
  const config = (await res.json()) as AppConfig;
  pool = new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.userPoolClientId });
  return config;
}

/** ID token (JWT) de la sesión vigente o null. Si expiró, lo renueva con el refresh token. */
export function currentIdToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const user = pool?.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err: Error | null, session: { isValid(): boolean; getIdToken(): { getJwtToken(): string } } | null) => {
      if (err || !session?.isValid()) return resolve(null);
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

/** Email del usuario, leído del ID token (el "username" de Cognito es un UUID). */
export function currentEmail(): string {
  let email = '';
  pool?.getCurrentUser()?.getSession((err: Error | null, session: { getIdToken(): { payload: Record<string, string> } } | null) => {
    if (!err && session) email = session.getIdToken().payload.email ?? '';
  });
  return email;
}

export function login(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!pool) return reject(new Error('Configuración no cargada'));
    const user = new CognitoUser({ Username: email, Pool: pool });
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: () => resolve(),
      onFailure: (err: Error) => reject(err),
      newPasswordRequired: () =>
        reject(new Error('El usuario debe cambiar su contraseña. Pídele al administrador una contraseña permanente.')),
    });
  });
}

export const logout = () => pool?.getCurrentUser()?.signOut();
