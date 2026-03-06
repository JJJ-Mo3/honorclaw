import type { ComputeProvider, ContainerSpec, ContainerHandle, ContainerResult } from '@honorclaw/core';
import Docker from 'dockerode';

export class DockerComputeProvider implements ComputeProvider {
  private docker: Docker;

  constructor(socketPath?: string) {
    this.docker = new Docker({
      socketPath: socketPath ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock',
    });
  }

  async spawnContainer(spec: ContainerSpec): Promise<ContainerHandle> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      name: spec.name,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        NetworkMode: spec.network ?? 'none',
        ReadonlyRootfs: spec.readOnly ?? true,
        Memory: parseMemory(spec.resourceLimits?.memory),
        NanoCpus: parseCpu(spec.resourceLimits?.cpus),
        Tmpfs: spec.tmpfs ? Object.fromEntries(spec.tmpfs.map(t => [t.split(':')[0], t.split(':')[1] ?? 'rw,noexec,nosuid,size=64m'])) : undefined,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
      },
      User: spec.user ?? '65534:65534',
    });

    await container.start();
    return { id: container.id, name: spec.name ?? container.id };
  }

  async waitForContainer(handle: ContainerHandle, timeoutMs: number): Promise<ContainerResult> {
    const container = this.docker.getContainer(handle.id);

    const result = await Promise.race([
      container.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Container timeout')), timeoutMs),
      ),
    ]);

    // Read stdout/stderr from container logs
    const logs = await container.logs({ stdout: true, stderr: true, follow: false });
    const output = logs.toString('utf-8');

    // Clean up
    await container.remove({ force: true }).catch(() => {});

    return {
      exitCode: (result as any).StatusCode ?? 1,
      stdout: output,
      stderr: '',
    };
  }

  async stopContainer(handle: ContainerHandle): Promise<void> {
    const container = this.docker.getContainer(handle.id);
    await container.stop({ t: 10 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  }
}

function parseMemory(mem?: string): number | undefined {
  if (!mem) return undefined;
  const match = mem.match(/^(\d+)(m|g)$/i);
  if (!match) return undefined;
  const val = parseInt(match[1]!);
  return match[2]!.toLowerCase() === 'g' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
}

function parseCpu(cpus?: string): number | undefined {
  if (!cpus) return undefined;
  return Math.round(parseFloat(cpus) * 1e9);
}
