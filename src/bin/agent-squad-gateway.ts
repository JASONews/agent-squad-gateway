#!/usr/bin/env node
import { Command, Option } from 'commander';
import { fileURLToPath } from 'node:url';
import type { GatewayWebUiAuthMode } from '../config/config.js';
import {
  doctorGateway,
  openGateway,
  startGateway,
  statusGateway,
  stopGateway,
} from '../lifecycle/daemon.js';

interface GatewayEndpointCliOptions {
  address?: string;
  port?: number;
}

export interface GatewayCliActions {
  start: (options: GatewayEndpointCliOptions & {
    foreground?: boolean;
    webUiAuth?: GatewayWebUiAuthMode;
  }) => Promise<void>;
  stop: () => Promise<void>;
  status: (options?: GatewayEndpointCliOptions) => Promise<unknown>;
  open: (options?: GatewayEndpointCliOptions) => Promise<void>;
  doctor: () => Promise<unknown>;
}

const defaultActions: GatewayCliActions = {
  start: startGateway,
  stop: stopGateway,
  status: statusGateway,
  open: openGateway,
  doctor: doctorGateway,
};

export function createGatewayProgram(actions: GatewayCliActions = defaultActions): Command {
  const program = new Command();
  program
    .name('agent-squad-gateway')
    .description('Local Agent Squad Gateway')
    .version('0.1.0');

  addEndpointOptions(program.command('start')
    .option('--foreground', 'run in the foreground'))
    .addOption(new Option('--web-ui-auth <mode>', 'Web UI authentication mode')
      .choices(['disabled', 'token'])
      .env('AGENT_SQUAD_GATEWAY_WEB_UI_AUTH'))
    .action(async (options: {
      foreground?: boolean;
      address?: string;
      port?: number;
      webUiAuth?: GatewayWebUiAuthMode;
    }) => {
      await actions.start({
        foreground: options.foreground,
        address: options.address,
        port: options.port,
        webUiAuth: options.webUiAuth,
      });
    });
  program.command('stop').action(async () => { await actions.stop(); });
  addEndpointOptions(program.command('status')).action(async (options: GatewayEndpointCliOptions) => {
    await actions.status(options);
  });
  addEndpointOptions(program.command('open')).action(async (options: GatewayEndpointCliOptions) => {
    await actions.open(options);
  });
  program.command('doctor').action(async () => { await actions.doctor(); });
  return program;
}

function addEndpointOptions(command: Command): Command {
  return command
    .addOption(new Option('--address <address>', 'Gateway bind address')
      .env('AGENT_SQUAD_GATEWAY_ADDRESS'))
    .addOption(new Option('--port <port>', 'Gateway bind port')
      .env('AGENT_SQUAD_GATEWAY_PORT')
      .argParser(Number));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void createGatewayProgram().parseAsync(process.argv).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
