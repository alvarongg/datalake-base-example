// Cliente mínimo de la API. Cada llamada adjunta el JWT de Cognito.
import { currentIdToken } from './auth.js';

let apiUrl = '';
export const setApiUrl = (url) => (apiUrl = url.replace(/\/$/, ''));

async function call(method, path, body) {
  const token = await currentIdToken();
  if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Error ${res.status}`);
  return data;
}

/** Estado de cada dataset y modelo Gold (qué está al día, qué se está procesando). */
export const getState = () => call('GET', '/state');

/** Procesa un dataset ('single') o ese dataset con todo lo que necesita ('with_dependencies').
 *  dataset = 'all' procesa todos en orden de dependencias. */
export const startDatasets = (dataset, mode = 'single') => call('POST', '/pipeline/start', { kind: 'datasets', dataset, mode });

/** Construye modelos Gold; sin lista, todos. */
export const startGold = (models = []) => call('POST', '/pipeline/start', { kind: 'gold', models });

export const resetLake = (includeLanding) => call('POST', '/reset', { includeLanding });
export const runQuery = (sql) => call('POST', '/query', { sql });

/** Sube un CSV directo a S3 con una URL prefirmada (no pasa por la API). */
export async function uploadFile(file) {
  const { url, contentType } = await call('POST', '/upload-url', { filename: file.name });
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!res.ok) throw new Error(`S3 rechazó ${file.name} (${res.status})`);
}
