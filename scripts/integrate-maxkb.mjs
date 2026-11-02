import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';

// Version-specific, reproducible overlay. Never patch an unknown upstream bundle.
const bundleName = 'admin-CQJSXL2_.js';
const directory = '.local/maxkb-integration';
const container = execFileSync('docker', ['compose', 'ps', '-q', 'maxkb'], { encoding: 'utf8' }).trim();
if (!container) throw new Error('Start MaxKB first: docker compose up -d');
const image = execFileSync('docker', ['inspect', container, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).trim();
if (image !== 'registry.fit2cloud.com/maxkb/maxkb:v2.10.6-lts') throw new Error('Unsupported MaxKB version. Review integration before upgrading.');
await mkdir(directory, { recursive: true });
execFileSync('docker', ['cp', `${container}:/opt/maxkb-app/ui/dist/admin`, directory]);
// The ui/dist copy remains original even when apps/static is overlaid.
execFileSync('docker', ['cp', `${container}:/opt/maxkb-app/ui/dist/admin/assets/${bundleName}`, `${directory}/original.js`]);
execFileSync('docker', ['cp', `${container}:/opt/maxkb-app/ui/dist/admin/index.html`, `${directory}/original.html`]);
const original = await readFile(`${directory}/original.js`, 'utf8');
const ast = parse(original, { ecmaVersion: 'latest', sourceType: 'module' });
const declarations = ast.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations);
const routes = declarations.find(n => n.id.name === 'routes')?.init;
const property = (node, key) => node?.properties?.find(p => p.key.name === key || p.key.value === key)?.value;
const root = routes?.elements?.find(n => property(n, 'name')?.value === 'root');
const children = property(root, 'children');
const home = children?.elements?.find(n => property(n, 'name')?.value === 'home');
const layout = property(home, 'component');
const vueRender = ast.body.some(n => n.type === 'FunctionDeclaration' && n.id.name === 'h$3');
if (!layout || !vueRender) throw new Error('Unexpected bundle layout. No files were changed.');
const component = await readFile('integration/intake-view.js', 'utf8');
const path = '/customer-knowledge-intake';
const entry = `{
  path: '${path}', name: 'customer-knowledge-intake', redirect: '${path}',
  meta: { title: '客服知识录入', menu: true, order: 3.5, group: 'workspace',
    icon: 'app-knowledge', iconActive: 'app-knowledge-active',
    permission: [RoleConst.ADMIN, RoleConst.EXTENDS_ADMIN] },
  component: ${original.slice(layout.start, layout.end)},
  children: [{ path: '${path}', name: 'customer-knowledge-intake-index',
    meta: { title: '客服知识录入', activeMenu: '${path}', sameRoute: 'customer-knowledge-intake',
      permission: [RoleConst.ADMIN, RoleConst.EXTENDS_ADMIN] },
    component: ${component.trim()} }]
},`;
const patched = original.slice(0, children.start + 1) + entry + original.slice(children.start + 1);
parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
const hash = createHash('sha256').update(patched).digest('hex').slice(0, 12);
const html = await readFile(`${directory}/original.html`, 'utf8');
if (!html.includes(`./assets/${bundleName}`)) throw new Error('Unexpected entry HTML');
await writeFile(`${directory}/admin/assets/${bundleName}`, patched);
// Lazy chunks import this bundle by filename. Keep one module identity with an import map.
const importMap = JSON.stringify({ imports: { [`/admin/assets/${bundleName}`]: `/admin/assets/${bundleName}?intake=${hash}` } });
await writeFile(`${directory}/admin/index.html`, html.replace('<head>', `<head><script type="importmap">${importMap}</script>`));
await writeFile(`${directory}/manifest.json`, JSON.stringify({ image, bundleName, originalSha256: createHash('sha256').update(original).digest('hex'), overlayHash: hash }, null, 2));
console.log('Prepared MaxKB navigation overlay. Apply with docker compose up -d.');
