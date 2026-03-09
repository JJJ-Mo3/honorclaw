# Creating Custom Tools

Tools are the actions agents can perform — search the web, query a database, send an email, call an API. HonorClaw ships with 19 built-in tool packages, but you can build custom tools using the Tool SDK.

## How Tools Work

Tools in HonorClaw are standalone processes. The agent never calls your tool directly — the trusted Tool Execution Layer does:

```
Agent → requests tool call → Control Plane validates against manifest → Tool Execution Layer runs tool → result returned to agent
```

This means:
- The agent never sees your tool's credentials (injected by the TEL)
- Every call is validated against the capability manifest
- Tools run in isolated containers with no access to the agent runtime

## Tool SDK Protocol

The Tool SDK handles all the plumbing. Your tool just needs to:

1. Define an input schema (Zod)
2. Implement a handler function
3. Return a result

**Input**: JSON via `HONORCLAW_TOOL_INPUT` env var (or stdin for large payloads)

**Output**: Single JSON line to stdout:
```json
{"status": "success", "result": { ... }}
```
or
```json
{"status": "error", "error": {"code": "error_code", "message": "description"}}
```

**Exit codes**: `0` = success, `1` = error, `2` = timeout

## Step 1: Create the Package

```bash
mkdir -p packages/tools/my-tool/src
cd packages/tools/my-tool
```

Create `package.json`:

```json
{
  "name": "@honorclaw/tool-my-tool",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@honorclaw/core": "workspace:*",
    "@honorclaw/tool-sdk": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

## Step 2: Define Input Schema and Handler

Create `src/index.ts`:

```typescript
import { createTool, z } from '@honorclaw/tool-sdk';

// 1. Define input schema with Zod
const InputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).optional(),
});

type Input = z.infer<typeof InputSchema>;

// 2. Define credential shape (injected via env var)
interface MyCreds {
  api_key: string;
  base_url?: string;
}

function getCredentials(): MyCreds {
  const raw = process.env.MY_TOOL_CREDENTIALS;
  if (!raw) throw new Error('MY_TOOL_CREDENTIALS env var is required');
  return JSON.parse(raw) as MyCreds;
}

// 3. Implement the handler
createTool(InputSchema, async (input: Input) => {
  const creds = getCredentials();
  const limit = input.limit ?? 10;

  const response = await fetch(`${creds.base_url ?? 'https://api.example.com'}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: input.query, limit }),
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { results: unknown[] };
  return { results: data.results, count: data.results.length };
});
```

## Step 3: Build and Test

```bash
# Install dependencies (from repo root)
pnpm install

# Build
pnpm turbo build --filter=@honorclaw/tool-my-tool

# Test locally
echo '{"query": "test"}' | HONORCLAW_TOOL_INPUT='{"query":"test"}' \
  MY_TOOL_CREDENTIALS='{"api_key":"test-key"}' \
  node dist/index.js
```

Expected output:
```json
{"status":"success","result":{"results":[],"count":0}}
```

## Step 4: Register in Agent Manifests

Reference your tool in an agent manifest:

```yaml
tools:
  - name: my_tool
    enabled: true
    parameters:
      query:
        type: string
        maxLength: 500
      limit:
        type: integer
        min: 1
        max: 50
    rateLimit:
      maxCallsPerMinute: 20
      maxCallsPerSession: 200
```

Store the credentials as a secret:

```bash
honorclaw secrets set tools/my-tool/credentials '{"api_key":"your-key","base_url":"https://api.example.com"}'
```

## Complete Example: Weather Lookup Tool

```typescript
// packages/tools/weather/src/index.ts
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  city: z.string().min(1).max(100),
  units: z.enum(['metric', 'imperial']).optional(),
});

interface WeatherCreds {
  api_key: string;
}

createTool(InputSchema, async (input) => {
  const creds = JSON.parse(
    process.env.WEATHER_CREDENTIALS ?? '{}'
  ) as WeatherCreds;

  if (!creds.api_key) {
    throw new Error('WEATHER_CREDENTIALS env var with api_key is required');
  }

  const units = input.units ?? 'metric';
  const url = new URL('https://api.openweathermap.org/data/2.5/weather');
  url.searchParams.set('q', input.city);
  url.searchParams.set('units', units);
  url.searchParams.set('appid', creds.api_key);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status}`);
  }

  const data = await res.json() as {
    main: { temp: number; humidity: number };
    weather: Array<{ description: string }>;
    wind: { speed: number };
    name: string;
  };

  return {
    city: data.name,
    temperature: data.main.temp,
    humidity: data.main.humidity,
    conditions: data.weather[0]?.description ?? 'unknown',
    windSpeed: data.wind.speed,
    units,
  };
});
```

Usage in a manifest:

```yaml
tools:
  - name: weather
    parameters:
      city:
        type: string
        maxLength: 100
      units:
        type: string
        allowedValues:
          - metric
          - imperial

egress:
  allowedDomains:
    - api.openweathermap.org
```

## Credential Injection

Tools never receive credentials from the agent. Credentials are injected by the Tool Execution Layer as environment variables:

1. Store the credential: `honorclaw secrets set tools/weather/credentials '{"api_key":"..."}'`
2. The TEL reads the secret and sets it as an env var when running the tool
3. Your tool reads it from `process.env.WEATHER_CREDENTIALS`

**Convention**: The env var name is derived from the tool name: `my-tool` → `MY_TOOL_CREDENTIALS`

## Error Handling

The Tool SDK handles errors automatically. Just throw:

```typescript
createTool(InputSchema, async (input) => {
  // Validation errors (from Zod) → code: "validation_error"
  // Thrown errors → code: "execution_error"
  // Timeout → code: "timeout"

  if (!input.query) {
    throw new Error('Query is required');  // → execution_error
  }

  // Zod validation is automatic — invalid input never reaches your handler
});
```

## Timeout Configuration

Default timeout is 30 seconds. Override per-tool via environment variable:

```bash
HONORCLAW_TOOL_TIMEOUT=60  # 60 seconds
```

For long-running tools (data queries, file processing), increase the timeout in the tool's container configuration.

## Logging

Write logs to **stderr only**. Stdout is reserved for the JSON result.

```typescript
createTool(InputSchema, async (input) => {
  console.error('Processing query:', input.query);  // → stderr (logs)

  const result = await doWork(input);
  return result;  // → stdout (JSON result)
});
```

## Testing Tools

Write unit tests with Vitest:

```typescript
// src/index.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('weather tool', () => {
  it('returns weather data for a valid city', async () => {
    // Mock fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        main: { temp: 22, humidity: 65 },
        weather: [{ description: 'clear sky' }],
        wind: { speed: 3.5 },
        name: 'London',
      }),
    }));

    // Set env vars
    process.env.WEATHER_CREDENTIALS = JSON.stringify({ api_key: 'test' });
    process.env.HONORCLAW_TOOL_INPUT = JSON.stringify({ city: 'London' });

    // Import and test (tool auto-runs on import)
    // ...
  });
});
```

## Next Steps

- [Creating Custom Agents](creating-agents.md) — Use your tools in agent manifests
- [Creating Custom Skills](creating-skills.md) — Bundle tools into reusable skills
- [Manifest Reference](manifest-reference.md) — Tool parameter constraint reference
