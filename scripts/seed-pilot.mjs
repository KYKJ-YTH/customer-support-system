import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { connect, workspace, origin } from './maxkb-client.mjs';

const { api } = await connect();
const embeddings = await api(`${workspace}/model?model_type=EMBEDDING`);
const model = embeddings.find(item => item.model_type === 'EMBEDDING' || item.model_name?.includes('text2vec'));
if (!model) throw new Error('No embedding model available; configure a local embedding model first.');

const knowledgeList = await api(`${workspace}/knowledge`);
const appList = await api(`${workspace}/application`);
const output = { origin, embeddingModel: model.name, products: [] };

async function ensureKnowledge(name, desc) {
  let knowledge = knowledgeList.find(item => item.name === name);
  if (!knowledge) {
    knowledge = await api(`${workspace}/knowledge/base`, 'POST', {
      name, desc, folder_id: 'default', embedding_model_id: model.id,
    });
    knowledgeList.push(knowledge);
  }
  return knowledge;
}

async function ensureDocument(knowledge, name, paragraphs, active) {
  const prefix = `${workspace}/knowledge/${knowledge.id}/document`;
  const documents = await api(prefix);
  let document = documents.find(item => item.name === name);
  if (!document) {
    document = await api(prefix, 'POST', { name, paragraphs });
    await api(`${prefix}/${document.id}`, 'PUT', {
      is_active: active,
      hit_handling_method: 'directly_return',
      directly_return_similarity: 0.75,
    });
  }
  return document;
}

for (const suffix of ['A', 'B']) {
  const name = `演示产品 ${suffix}（非真实商品）`;
  const knowledge = await ensureKnowledge(name, `产品隔离验收专用，测试型号 DEMO-${suffix}。不含真实商品信息。`);
  const document = await ensureDocument(knowledge, `DEMO-${suffix} 已确认演示问答`, [{
    title: '型号识别',
    content: `【演示数据，不可发送给客户】演示产品 ${suffix} 的测试型号是 DEMO-${suffix}。此记录只用于检验按产品检索，不代表任何真实商品参数。`,
    problem_list: [{ content: '这款产品的型号是什么？' }, { content: '如何识别这款产品的型号？' }],
  }], true);
  const appName = `客服查询 · 演示产品 ${suffix}`;
  let app = appList.find(item => item.name === appName);
  if (!app) {
    app = await api(`${workspace}/application`, 'POST', {
      name: appName,
      desc: `仅检索演示产品 ${suffix} 的知识。命中后返回原文，无匹配则提示待解答。`,
      type: 'SIMPLE', folder_id: 'default', model_id: null,
      dialogue_number: 0, problem_optimization: false,
      prologue: `演示产品 ${suffix} · 非真实商品`,
      knowledge_id_list: [knowledge.id],
      knowledge_setting: {
        top_n: 1, similarity: 0.75, max_paragraph_char_number: 5000,
        search_mode: 'embedding',
        no_references_setting: { status: 'designated_answer', value: '暂无已确认答案，请登记待解答问题。' },
      },
      model_setting: {
        prompt: '{data}\n{question}',
        system: await readFile('prompts/customer-assistant.md', 'utf8'),
        no_references_prompt: '暂无已确认答案，请登记待解答问题。',
      },
    });
    appList.push(app);
    await api(`${workspace}/application/${app.id}/publish`, 'PUT', {});
  }
  await api(`${workspace}/application/${app.id}/access_token`, 'PUT', { show_source: true, language: 'zh-CN' });
  const access = await api(`${workspace}/application/${app.id}/access_token`);
  output.products.push({ name, knowledgeId: knowledge.id, documentId: document.id, applicationId: app.id, access });
}

const pending = await ensureKnowledge('待确认区 · 不参与客服回答', '未解决案例与产品身份不完整的记录，仅供负责人补全，不绑定客服查询应用。');
await ensureDocument(pending, 'BATTERY-001 电池充满快、耗尽快（待解答）', [{
  title: 'BATTERY-001 · 待解答',
  content: await readFile('data/pending/BATTERY-001.md', 'utf8'),
  problem_list: [],
}], false);
output.pendingKnowledgeId = pending.id;
await mkdir('.local', { recursive: true });
await writeFile('.local/pilot.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ products: output.products.map(({ name, knowledgeId, applicationId }) => ({ name, knowledgeId, applicationId })), pendingKnowledgeId: pending.id }, null, 2));
