import { afterEach, describe, expect, it } from 'vitest';
import {
  getStatus,
  startMcpHttpServer,
  stopMcpHttpServer,
} from '../main/mcp-http';
import {
  createMcpContext,
  requireProject,
  tools,
} from '../main/tool-handlers';
import { scanProjectTree } from '../main/utils';

describe('mcp-http', () => {
  afterEach(async () => {
    await stopMcpHttpServer();
  });

  describe('getStatus', () => {
    it('reports not running when server has not been started', () => {
      const status = getStatus();
      expect(status.running).toBe(false);
      expect(status.port).toBeNull();
      expect(status.connections).toBe(0);
      expect(status.url).toBeNull();
    });

    it('reports running and port after start', async () => {
      await startMcpHttpServer(() => null, () => null);
      const status = getStatus();
      expect(status.running).toBe(true);
      expect(status.port).toBeGreaterThan(0);
      expect(status.url).toBe(`http://127.0.0.1:${status.port}/sse`);
    });

    it('reports not running after stop', async () => {
      await startMcpHttpServer(() => null, () => null);
      await stopMcpHttpServer();
      const status = getStatus();
      expect(status.running).toBe(false);
      expect(status.port).toBeNull();
      expect(status.connections).toBe(0);
      expect(status.url).toBeNull();
    });
  });

  describe('startMcpHttpServer', () => {
    it('health endpoint returns 200 and JSON', async () => {
      await startMcpHttpServer(() => null, () => null);
      const status = getStatus();
      const res = await fetch(`http://127.0.0.1:${status.port}/`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.name).toBe('night-pm');
      expect(body.version).toBe('1.0.0');
      expect(typeof body.connections).toBe('number');
    });

    it('root path returns same health payload', async () => {
      await startMcpHttpServer(() => null, () => null);
      const status = getStatus();
      const res = await fetch(`http://127.0.0.1:${status.port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    it('unknown path returns 404', async () => {
      await startMcpHttpServer(() => null, () => null);
      const status = getStatus();
      const res = await fetch(`http://127.0.0.1:${status.port}/unknown`);
      expect(res.status).toBe(404);
    });

    it('OPTIONS returns 204', async () => {
      await startMcpHttpServer(() => null, () => null);
      const status = getStatus();
      const res = await fetch(`http://127.0.0.1:${status.port}/sse`, {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
    });

    it('idempotent: second start returns same status', async () => {
      await startMcpHttpServer(() => null, () => null);
      const first = getStatus();
      await startMcpHttpServer(() => null, () => null);
      const second = getStatus();
      expect(second.running).toBe(true);
      expect(second.port).toBe(first.port);
    });
  });

  describe('stopMcpHttpServer', () => {
    it('no-op when server not running', async () => {
      await stopMcpHttpServer();
      expect(getStatus().running).toBe(false);
    });
  });

  describe('require project', () => {
    const ctxNoProject = createMcpContext({
      projectPath: null,
      scanRoot: '',
      setActiveProject: undefined,
      scanProjectTree,
    });
    const ctxEmptyProject = createMcpContext({
      projectPath: '',
      scanRoot: '',
      setActiveProject: undefined,
      scanProjectTree,
    });

    it.each(
      Object.entries(tools).filter(
        ([, t]) => !t.skipProjectCheck,
      ) as [string, (typeof tools)[keyof typeof tools]][],
    )('%s returns error when no project selected', async (name, tool) => {
      const run = requireProject(tool.handler);
      const result = await run(ctxNoProject, {});
      expect(result.isError, `${name} should return isError: true`).toBe(true);
      expect(
        result.content[0].text,
        `${name} should return "No project selected"`,
      ).toContain('No project selected');
    });

    it.each(
      Object.entries(tools).filter(
        ([, t]) => !t.skipProjectCheck,
      ) as [string, (typeof tools)[keyof typeof tools]][],
    )('%s returns error when projectPath is empty string', async (name, tool) => {
      const run = requireProject(tool.handler);
      const result = await run(ctxEmptyProject, {});
      expect(result.isError, `${name} should return isError: true`).toBe(true);
      expect(
        result.content[0].text,
        `${name} should return "No project selected"`,
      ).toContain('No project selected');
    });

    it.each(
      Object.entries(tools).filter(
        ([, t]) => t.skipProjectCheck === true,
      ) as [string, (typeof tools)[keyof typeof tools]][],
    )('%s does not return "No project selected" when no project', async (name, tool) => {
      const result = await tool.handler(ctxNoProject, {});
      expect(
        result.content[0].text,
        `${name} (skipProjectCheck) must not return "No project selected"`,
      ).not.toContain('No project selected');
    });
  });

  describe('setActiveProject', () => {
    it('project_set_active invokes setActiveProject and updates current activeProject', async () => {
      let activeProject: string | null = null;
      const setActiveProject = (p: string): void => {
        activeProject = p;
      };
      const ctx = createMcpContext({
        projectPath: null,
        scanRoot: '',
        setActiveProject,
        scanProjectTree,
      });
      const result = await tools.project_set_active.handler(ctx, {
        path: '/my/active/project',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Active project set to');
      expect(activeProject).toBe('/my/active/project');
    });

    it('project_set_active returns error when setActiveProject is not provided', async () => {
      const ctx = createMcpContext({
        projectPath: null,
        scanRoot: '',
        setActiveProject: undefined,
        scanProjectTree,
      });
      const result = await tools.project_set_active.handler(ctx, {
        path: '/some/path',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot change active project');
    });
  });
});
