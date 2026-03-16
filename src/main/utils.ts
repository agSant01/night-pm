import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function scanProjectTree(dir: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as { name: string; isDirectory: () => boolean }[];
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const nipmPath = path.join(fullPath, 'project.nipm');

      let isProject = false;
      let info: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(nipmPath, 'utf-8');
        info = JSON.parse(raw);
        isProject = true;
      } catch { /* not a project */ }

      const children = await scanProjectTree(fullPath);

      if (isProject) {
        results.push({
          name: info.name || entry.name,
          description: info.description || '',
          path: fullPath,
          children,
        });
      } else if (children.length > 0) {
        results.push(...children);
      }
    }
    return results;
  }
