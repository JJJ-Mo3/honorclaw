export interface ContainerSpec {
  image: string;
  name?: string;
  env: Record<string, string>;
  network?: string;
  resourceLimits?: {
    cpus?: string;
    memory?: string;
  };
  readOnly?: boolean;
  user?: string;
  tmpfs?: string[];
  timeout?: number;
}

export interface ContainerHandle {
  id: string;
  name: string;
}

export interface ContainerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ComputeProvider {
  spawnContainer(spec: ContainerSpec): Promise<ContainerHandle>;
  waitForContainer(handle: ContainerHandle, timeoutMs: number): Promise<ContainerResult>;
  stopContainer(handle: ContainerHandle): Promise<void>;
}
