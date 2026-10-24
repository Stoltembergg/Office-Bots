// Test-only entry: never built or imported by the shipped worker.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { PiBackend } from './sdk';
import { serve } from './host';
const backend = new PiBackend(process.argv[2], event => process.send?.({ version: 1, event }), async selection => {
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ provider: 'test', models: ['normal', 'slow', 'tool', 'error', 'crash'].map(id => ({ id })),
    tokensPerSecond: selection.modelId === 'slow' ? 10 : 100000 });
  models.registerNativeProvider(faux.provider);
  faux.setResponses([
    context => {
      if (selection.modelId === 'crash') process.exit(17);
      if (JSON.stringify(context).includes('UNTRUSTED_CONTEXT_MARKER')) throw new Error('project context loaded');
      if (selection.modelId === 'error') return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'PRIVATE_API_KEY' });
      if (selection.modelId === 'tool') return fauxAssistantMessage(fauxToolCall('write', { path: 'tool-ran', content: 'bad' }), { stopReason: 'toolUse' });
      return fauxAssistantMessage(selection.modelId === 'slow' ? 'Resposta longa. '.repeat(100) : 'Resposta do teste.');
    },
    fauxAssistantMessage('Resposta do teste.'),
  ]);
  return { models, authorize: async () => selection.accountId === 'chosen-account' };
});
serve(backend);
