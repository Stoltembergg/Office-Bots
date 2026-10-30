import path from 'node:path';
import { PiBackend } from './sdk';
import { serve } from './host';
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) process.exit(1);
serve(new PiBackend(directory, event => process.send?.({ version: 1, event })));
