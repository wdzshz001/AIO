// 拉取 animeko 在线源订阅，打印各源的当前域名，用于发现站点换域名
const SUB = process.env.ANI_SUB || 'https://sub.creamycake.org/v1/css1.json';

const res = await fetch(SUB, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  console.error('订阅拉取失败', res.status);
  process.exit(1);
}
const json = await res.json();
const sources = json.mediaSources ?? [];
console.log(`订阅 ${SUB}：${sources.length} 个源\n`);

for (const s of sources) {
  const args = s.arguments ?? {};
  const searchUrl = args.searchConfig?.searchUrl ?? args.searchConfig?.baseUrl ?? '';
  let host = '';
  try {
    host = searchUrl ? new URL(searchUrl).host : '';
  } catch {
    host = '';
  }
  console.log(
    `${String(s.id).padEnd(24)} ${String(args.name ?? '').padEnd(10)} tier=${String(args.tier ?? '-').padEnd(2)} ${host || '(json api)'}`,
  );
}
