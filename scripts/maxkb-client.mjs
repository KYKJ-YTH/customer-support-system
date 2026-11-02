import { constants, publicEncrypt } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const savedLogin = await readFile(new URL('../.local/login.json', import.meta.url), 'utf8')
  .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
export const username = process.env.MAXKB_USERNAME || savedLogin.username || 'admin';
export const password = process.env.MAXKB_PASSWORD || savedLogin.password || 'MaxKB@123..';

export const origin = process.env.MAXKB_URL || 'http://127.0.0.1:8088';
export const workspace = '/workspace/default';

export async function connect() {
  let token;
  async function api(path, method = 'GET', body) {
    const response = await fetch(`${origin}/admin/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'zh-CN',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 200) {
      throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    }
    return result.data;
  }
  const profile = await api('/profile');
  const encryptedData = publicEncrypt(
    { key: profile.rsa, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(JSON.stringify({ username, password, captcha: '' })),
  ).toString('base64');
  const auth = await api('/user/login', 'POST', { username, encryptedData });
  token = typeof auth === 'string' ? auth : auth.token;
  if (!token) throw new Error('Login did not return a token');
  return { api, token };
}
