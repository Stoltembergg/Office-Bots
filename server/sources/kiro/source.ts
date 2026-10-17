// Fonte de agentes do Kiro (AgentSource 'kiro', ver sources/source.ts)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectKiroAccount, discoverKiroDir } from './accounts';
import { KiroTerminalParser } from './terminal';
import { KiroWatcher } from './watcher';

export interface KiroSourceOptions {
  accounts: AccountsService;
  office: Office;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  inDocker?: boolean;
  checkPid?: boolean;
  pollMs?: number;
}

export class KiroSource implements AgentSource {
  readonly provider: Provider = 'kiro';
  private readonly accounts: AccountsService;
  private readonly office: Office;
  private readonly dir: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly watcher: KiroWatcher;

  constructor(opts: KiroSourceOptions) {
    this.accounts = opts.accounts;
    this.office = opts.office;
    this.env = opts.env;
    const baseDir = opts.dir ?? discoverKiroDir(opts.env, opts.home) ?? join(process.env.HOME || '', '.kiro');
    this.dir = baseDir;

    const sessionsDir = join(baseDir, 'sessions', 'cli');
    this.watcher = new KiroWatcher({
      office: this.office,
      sessionsDir,
      inDocker: opts.inDocker,
      checkPid: opts.checkPid,
      pollMs: opts.pollMs,
    });
  }

  start(): void {
    if (existsSync(this.dir)) {
      this.accounts.setProviderAccounts('kiro', [
        {
          dir: this.dir,
          detected: detectKiroAccount(this.dir, this.env),
        },
      ]);
    }

    this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  accountEntries(): readonly AccountEntry[] {
    return this.accounts.entriesOf('kiro');
  }

  sources(): SourceInfo[] {
    return [
      {
        label: '.kiro',
        provider: 'kiro',
        path: this.dir,
        sessions: this.watcher.sessionCount(),
        ok: existsSync(this.dir),
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    return this.watcher.transcriptPathOf(agentId);
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return new KiroTerminalParser();
  }
}
