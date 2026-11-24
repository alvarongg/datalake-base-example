// Autenticación con Cognito (flujo SRP: la contraseña nunca viaja por la red).
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';

let pool;

export async function loadConfig() {
  // config.json lo genera deplo.sh a partir de las salidas de CloudFormation.
  const res = await fetch('/config.json', { cache: 'no-store' });
  const config = await res.json();
  pool = new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.userPoolClientId });
  return config;
}

/** Devuelve el ID token (JWT) de la sesión vigente o null. Renueva con el refresh token. */
export function currentIdToken() {
  return new Promise((resolve) => {
    const user = pool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err, session) => {
      if (err || !session?.isValid()) return resolve(null);
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

export function currentEmail() {
  return pool.getCurrentUser()?.getUsername() ?? '';
}

export function login(email, password) {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: pool });
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err),
      newPasswordRequired: () =>
        reject(new Error('El usuario debe cambiar su contraseña. Pídele al administrador una contraseña permanente.')),
    });
  });
}

export function logout() {
  pool.getCurrentUser()?.signOut();
}
