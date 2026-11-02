// This component runs inside the pinned MaxKB bundle and reuses its Vue runtime.
({
  name: 'CustomerKnowledgeIntake',
  render() {
    const url = new URL(window.location.href);
    url.port = '8090';
    url.pathname = '/';
    url.search = '?embed=1';
    url.hash = '';
    return h$3('iframe', {
      src: url.href,
      title: '客服知识录入',
      'data-testid': 'knowledge-intake-frame',
      style: 'display:block;width:100%;height:calc(100dvh - 56px);border:0;background:#f6f8fc',
    });
  },
})
