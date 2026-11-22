import type { AppDef, Site } from '@agg/core';
import { apps } from '@agg/adapters';

/** 按应用把源分组；未知 kind 归到「其他」 */
export function sourceGroups(allSites: Site[]): { app: AppDef; sites: Site[] }[] {
  const groups = apps
    .map((app) => ({
      app,
      sites: allSites.filter((s) => app.kinds.includes(s.kind)),
    }))
    .filter((g) => g.sites.length > 0);

  const known = new Set(groups.flatMap((g) => g.app.kinds));
  const rest = allSites.filter((s) => !known.has(s.kind));
  if (rest.length) {
    groups.push({
      app: { id: 'other', name: '其他', icon: '·', color: '#666', kinds: [], desc: '其他源' },
      sites: rest,
    });
  }
  return groups;
}
