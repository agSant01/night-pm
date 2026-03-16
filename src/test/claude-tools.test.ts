import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectMcpServer } from '../main/providers/claude';
import { createMcpContext, requireProject, tools } from '../main/tool-handlers';
import { scanProjectTree } from '../main/utils';

const testDir = path.join(process.cwd(), '.test-mcp-tools');

describe('claude-tools', () => {
  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('scanProjectTree', () => {
    it('returns empty array for non-existent directory', async () => {
      const result = await scanProjectTree(path.join(testDir, 'nonexistent'));
      expect(result).toEqual([]);
    });

    it('returns empty array for empty directory', async () => {
      const emptyDir = path.join(testDir, 'empty');
      await fs.mkdir(emptyDir, { recursive: true });
      const result = await scanProjectTree(emptyDir);
      expect(result).toEqual([]);
    });

    it('returns project entry when directory has project.nipm', async () => {
      const projectDir = path.join(testDir, 'has-project');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'project.nipm'),
        JSON.stringify({ name: 'Test Project', description: 'A test' }),
        'utf-8',
      );
      const result = await scanProjectTree(testDir);
      expect(result.length).toBeGreaterThanOrEqual(1);
      const project = result.find((r) => (r as { path?: string }).path === projectDir);
      expect(project).toBeDefined();
      expect((project as { name?: string }).name).toBe('Test Project');
      expect((project as { description?: string }).description).toBe('A test');
      expect(Array.isArray((project as { children?: unknown[] }).children)).toBe(true);
    });

    it('ignores directories without project.nipm unless they contain projects', async () => {
      const noNipm = path.join(testDir, 'no-nipm');
      await fs.mkdir(noNipm, { recursive: true });
      const result = await scanProjectTree(testDir);
      const asPath = result.find((r) => (r as { path?: string }).path === noNipm);
      expect(asPath).toBeUndefined();
    });
  });

  describe('createProjectMcpServer', () => {
    it('throws when projectPath is empty', () => {
      expect(() =>
        createProjectMcpServer({ projectPath: '' }),
      ).toThrow('Project path is required');
    });

    it('throws when projectPath is whitespace only', () => {
      expect(() =>
        createProjectMcpServer({ projectPath: '   ' }),
      ).toThrow('Project path is required');
    });

    it('returns an object with expected SDK server shape when given valid path', () => {
      const server = createProjectMcpServer({
        projectPath: testDir,
        rootPath: path.dirname(testDir),
      });
      expect(server).toBeDefined();
      expect(typeof server).toBe('object');
      // Claude SDK createSdkMcpServer returns a server object; we don't depend on internal shape
      expect(server).not.toBeNull();
    });

    it('accepts optional setActiveProject callback', () => {
      const setActive = (): void => {
        // no-op
      };
      const server = createProjectMcpServer({
        projectPath: testDir,
        setActiveProject: setActive,
      });
      expect(server).toBeDefined();
    });

    it('setActiveProject is invoked by project_set_active and updates current activeProject', async () => {
      let activeProject: string | null = null;
      const setActiveProject = (p: string): void => {
        activeProject = p;
      };
      const ctx = createMcpContext({
        projectPath: testDir,
        scanRoot: path.dirname(testDir),
        setActiveProject,
        scanProjectTree,
      });
      const result = await tools.project_set_active.handler(ctx, {
        path: '/new/active/project',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Active project set to');
      expect(activeProject).toBe('/new/active/project');
    });
  });

  describe('require project', () => {
    it('context built with valid projectPath passes requireProject', async () => {
      const ctx = createMcpContext({
        projectPath: testDir,
        scanRoot: path.dirname(testDir),
        setActiveProject: undefined,
        scanProjectTree,
      });
      expect(ctx.projectPath).toBe(testDir);
      const wrapped = requireProject(async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }));
      const result = await wrapped(ctx, {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('ok');
    });

    it('context built with null projectPath fails requireProject', async () => {
      const ctx = createMcpContext({
        projectPath: null,
        scanRoot: '',
        setActiveProject: undefined,
        scanProjectTree,
      });
      expect(ctx.projectPath).toBeNull();
      const wrapped = requireProject(async () => ({
        content: [{ type: 'text' as const, text: 'never' }],
      }));
      const result = await wrapped(ctx, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No project selected');
    });
  });
});
