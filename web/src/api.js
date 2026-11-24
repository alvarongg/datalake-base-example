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

export const listFiles = () => call('GET', '/files');
export const startPipeline = () => call('POST', '/pipeline/start');
export const pipelineStatus = (arn) =>
  call('GET', `/pipeline/status${arn ? `?executionArn=${encodeURIComponent(arn)}` : ''}`);
export const resetLake = (includeLanding) => call('POST', '/reset', { includeLanding });
export const runQuery = (sql) => call('POST', '/query', { sql });

/** Sube un CSV directo a S3 con una URL prefirmada (no pasa por la API). */
export async function uploadFile(file) {
  const { url, contentType } = await call('POST', '/upload-url', { filename: file.name });
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!res.ok) throw new Error(`S3 rechazó ${file.name} (${res.status})`);
}
