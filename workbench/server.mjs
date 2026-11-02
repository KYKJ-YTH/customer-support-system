import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connect, workspace } from '../scripts/maxkb-client.mjs';
import { generateKnowledge, knowledgeSchema, sourceSchema, paragraphFor } from './domain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}/.local`, { recursive: true });
const filesDir = `${root}/.local/files`;
await mkdir(filesDir, { recursive: true });
const db = new DatabaseSync(`${root}/.local/intake.sqlite`);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
const configPath = `${root}/.local/generator.json`;
let config = await readFile(configPath, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
const port = Number(process.env.INTAKE_PORT || 8090);
const app = express();
app.disable('x-powered-by');
const session = randomBytes(32).toString('hex');
const busy = new Set();
let client;
async function api(path, method, body) {
  client ||= await connect();
  try { return await client.api(path, method, body); }
  catch (error) { client = undefined; throw error; }
}
function save(draft) {
  draft.updatedAt = new Date().toISOString();
  db.prepare('INSERT INTO drafts VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(draft.id, JSON.stringify(draft));
  return draft;
}
function get(id) {
  const row = db.prepare('SELECT payload FROM drafts WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('记录不存在'), { status: 404 });
  return JSON.parse(row.payload);
}
function editable(id) {
  const d = get(id);
  if (d.state === 'published' || d.documentId || busy.has(id)) throw Object.assign(new Error('该记录已入库或正在处理，不能修改。'), { status: 409 });
  return d;
}
async function binding(id) {
  const a = await api(`${workspace}/application/${id}`);
  if (a.knowledge_id_list?.length !== 1) throw Object.assign(new Error('该智能体必须只绑定一个产品知识库，请先在 MaxKB 调整。'), { status: 400 });
  return { applicationId: a.id, applicationName: a.name, knowledgeId: a.knowledge_id_list[0] };
}
app.use((req, res, next) => {
  if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.status(403).json({ error: '仅允许本机访问' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors http://127.0.0.1:8088 http://localhost:8088; base-uri 'none'; form-action 'self'");
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    const ownOrigin = `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== ownOrigin) return res.status(403).json({ error: '来源不受信任' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '来源不受信任' });
    if (!req.headers.cookie?.split('; ').includes(`intake_session=${session}`)) return res.status(401).json({ error: '请刷新工作台后重试' });
  } else if (req.path === '/') {
    res.setHeader('Set-Cookie', `intake_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
  }
  next();
});
app.use(express.json({ limit: '18mb' }));
app.get('/api/config', (req, res) => res.json({ baseUrl: config.baseUrl || '', model: config.model || '', hasKey: !!config.apiKey, ready: !!(config.baseUrl && config.model) }));
app.put('/api/config', async (req, res) => {
  const next = z.object({ baseUrl: z.string().url().max(1000), model: z.string().trim().min(1).max(200), apiKey: z.string().max(4000).optional() }).parse(req.body);
  const url = new URL(next.baseUrl);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Object.assign(new Error('API 地址须为 HTTPS；本机服务可使用 HTTP，地址不能包含密码或查询参数。'), { status: 400 });
  next.baseUrl = next.baseUrl.replace(/\/$/, '');
  if (!next.apiKey) next.apiKey = next.baseUrl === config.baseUrl ? config.apiKey || '' : '';
  await writeFile(`${configPath}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${configPath}.tmp`, configPath);
  config = next;
  res.json({ ok: true });
});
app.get('/api/products', async (req, res) => {
  const apps = await api(`${workspace}/application`);
  const products = [];
  for (const a of apps) {
    const detail = await api(`${workspace}/application/${a.id}`);
    products.push({ id: a.id, name: a.name, enabled: detail.knowledge_id_list?.length === 1 });
  }
  res.json(products);
});
app.get('/api/drafts', (req, res) => res.json(db.prepare('SELECT payload FROM drafts ORDER BY rowid DESC').all().map(row => {
  const d = JSON.parse(row.payload);
  return { id: d.id, title: d.knowledge?.title || d.source.product, state: d.state, product: d.source.product, updatedAt: d.updatedAt };
})));
app.get('/api/drafts/:id', (req, res) => res.json(get(req.params.id)));
app.post('/api/drafts', async (req, res) => {
  const source = sourceSchema.parse(req.body);
  const bound = await binding(source.applicationId);
  const draft = save({ id: randomUUID(), source, binding: bound, state: 'source', knowledge: null, createdAt: new Date().toISOString() });
  res.status(201).json(draft);
});
app.post('/api/drafts/:id/generate', async (req, res) => {
  const draft = editable(req.params.id);
  if (!config.baseUrl || !config.model) throw Object.assign(new Error('素材已保存。请先在模型设置中填写 API 地址和模型名称。'), { status: 409 });
  busy.add(draft.id);
  try {
    draft.knowledge = await generateKnowledge(config, draft.source);
    draft.state = 'draft';
    res.json(save(draft));
  } finally { busy.delete(draft.id); }
});
app.put('/api/drafts/:id', (req, res) => {
  const draft = editable(req.params.id);
  draft.knowledge = knowledgeSchema.parse(req.body.knowledge);
  draft.state = 'draft';
  res.json(save(draft));
});
app.post('/api/drafts/:id/publish', async (req, res) => {
  const draft = get(req.params.id);
  if (draft.state === 'published') return res.json(draft);
  if (busy.has(draft.id)) throw Object.assign(new Error('正在处理，请稍后重试'), { status: 409 });
  const review = z.object({ confirmed: z.literal(true), reviewer: z.string().trim().min(1).max(100) }).parse(req.body);
  const k = knowledgeSchema.parse(draft.knowledge);
  if (k.missing.length || !k.reply.trim() || !k.steps.trim() || !k.conditions.trim()) throw Object.assign(new Error('请补全处理步骤、客户回复、适用条件，并逐项解决待补充信息后保存。'), { status: 400 });
  busy.add(draft.id);
  try {
    const live = await binding(draft.source.applicationId);
    if (live.knowledgeId !== draft.binding.knowledgeId) throw Object.assign(new Error('智能体绑定已发生变化，请重新建立草稿以免写错知识库。'), { status: 409 });
    const prefix = `${workspace}/knowledge/${live.knowledgeId}/document`;
    const name = `${k.title.slice(0,100)} [${draft.id}]`;
    draft.reviewer = review.reviewer;
    draft.publishedAt ||= new Date().toISOString();
    const docs = await api(prefix);
    let doc = docs.find(d => d.id === draft.documentId || d.name === name);
    if (!doc) doc = await api(prefix, 'POST', { name, is_active: false, paragraphs: [paragraphFor(draft)] });
    draft.documentId = doc.id;
    draft.state = 'publishing';
    save(draft);
    await api(`${prefix}/${doc.id}`, 'PUT', { is_active: true, hit_handling_method: 'directly_return', directly_return_similarity: 0.75 });
    draft.state = 'published';
    res.json(save(draft));
  } finally { busy.delete(draft.id); }
});
// --- 产品资料文件管理 ---
const ALLOWED_EXTS = new Set(['.pdf','.jpg','.jpeg','.png','.webp','.gif','.doc','.docx','.xls','.xlsx','.txt','.md']);
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB per file

app.get('/api/files', (req, res) => {
  if (!existsSync(filesDir)) return res.json([]);
  const files = readdirSync(filesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .flatMap(dir => {
      const sub = join(filesDir, dir.name);
      return readdirSync(sub, { withFileTypes: true })
        .filter(f => f.isFile())
        .map(f => {
          let size = 0, mtime = 0;
          try { const s = statSync(join(sub, f.name)); size = s.size; mtime = s.mtimeMs; } catch {}
          return { product: dir.name, name: f.name, size, mtime };
        });
    });
  res.json(files);
});

app.get('/api/files/:product/:name', (req, res) => {
  const p = join(filesDir, req.params.product, req.params.name);
  if (!p.startsWith(filesDir)) return res.status(403).end();
  res.download(p);
});

app.post('/api/files', async (req, res) => {
  const body = z.object({
    product: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    data: z.string().min(1),   // base64
  }).parse(req.body);
  const ext = extname(body.name).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) throw Object.assign(new Error(`不支持的文件类型：${ext}`), { status: 400 });
  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_FILE_SIZE) throw Object.assign(new Error('文件超过 30MB 上限'), { status: 400 });
  const safeProduct = body.product.replace(/[\\/:*?"<>|]/g, '_');
  const dir = join(filesDir, safeProduct);
  await mkdir(dir, { recursive: true });
  const safeName = basename(body.name).replace(/[\\/:*?"<>|]/g, '_');
  await writeFile(join(dir, safeName), buf);
  res.status(201).json({ ok: true, product: safeProduct, name: safeName, size: buf.length });
});

app.delete('/api/files/:product/:name', async (req, res) => {
  const p = join(filesDir, req.params.product, req.params.name);
  if (!p.startsWith(filesDir)) return res.status(403).end();
  await unlink(p).catch(() => {});
  res.json({ ok: true });
});

app.get('/icons.js', (req, res) => res.sendFile(`${root}/node_modules/lucide/dist/umd/lucide.js`));
app.use(express.static(`${root}/workbench/public`));
app.use((error, req, res, next) => {
  const validation = error instanceof z.ZodError;
  const status = error.status || (validation ? 400 : 502);
  const message = validation ? `内容格式有误：${error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}` : error.message;
  res.status(status).json({ error: message?.includes('/workspace/') ? 'MaxKB 接口调用失败，请确认后台运行正常并稍后重试。' : message });
});
app.listen(port, '127.0.0.1', () => console.log(`Knowledge intake: http://127.0.0.1:${port}`));
