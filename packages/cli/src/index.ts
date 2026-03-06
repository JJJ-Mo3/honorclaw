// CLI entry point — see cli.ts for the commander program
export { cliApi, CliApiError, clearToken } from './api.js';
export { runDoctor } from './commands/doctor.js';
export { runInit } from './commands/init.js';
export { registerToolsCommand } from './commands/tools.js';
export { registerModelsCommand } from './commands/models.js';
