import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { connect, workspace } from './maxkb-client.mjs';

const { api } = await connect();
const config = JSON.parse(await readFile('.local/pilot.json', 'utf8'));
const results = [];
for (const [index, product] of config.products.entries()) {
  const suffix = index === 0 ? 'A' : 'B';
  const application = await api(`${workspace}/application/${product.applicationId}`);
  assert.deepEqual(application.knowledge_id_list, [product.knowledgeId]);
  const hit = await api(`${workspace}/knowledge/${product.knowledgeId}/hit_test`, 'POST', {
    query_text: '请问这个商品是什么型号？', top_number: 3, similarity: 0.75, search_mode: 'embedding',
  });
  console.log(JSON.stringify({ stage: 'retrieval', product: suffix, matches: hit.length, score: hit[0]?.similarity }));
  assert(hit.length > 0, 'Paraphrased question should retrieve an answer');
  assert(hit.every(item => item.content.includes(`DEMO-${suffix}`)), 'Results must belong to the selected product');
  for (const question of ['请问这个商品是什么型号？', '电池充满很快又很快没电，要怎么维修？']) {
    const chatId = await api(`${workspace}/application/${product.applicationId}/open`);
    const answer = await api(`/chat_message/${chatId}`, 'POST', {
      message: question, stream: false, re_chat: false,
    });
    console.log(JSON.stringify({ stage: 'answer', product: suffix, question, answer: answer.content }));
    if (question.includes('型号')) {
      assert(answer.content.includes(`DEMO-${suffix}`));
      assert(!answer.content.includes(`DEMO-${suffix === 'A' ? 'B' : 'A'}`));
    } else assert.equal(answer.content, '暂无已确认答案，请登记待解答问题。');
    results.push({ product: suffix, question, passed: true });
  }
}
const pendingDocuments = await api(`${workspace}/knowledge/${config.pendingKnowledgeId}/document`);
assert(pendingDocuments.length > 0 && pendingDocuments.every(item => !item.is_active));
results.push({ check: 'Pending documents are disabled and excluded from both applications', passed: true });
await writeFile('.local/verification.json', JSON.stringify({ verifiedAt: new Date().toISOString(), results }, null, 2));
console.log('PASS: product isolation, paraphrase retrieval, direct answer, unknown-answer fallback, pending isolation');
