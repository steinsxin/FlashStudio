import { readFileSync } from 'node:fs';

if (process.platform !== 'linux') throw new Error('Run package:windows on Windows.');
const distribution = readFileSync('/etc/os-release', 'utf8').match(/^ID=["']?([^\s"']+)/m)?.[1];
if (distribution === 'arch') await import('./arch/build.mjs');
else if (distribution === 'ubuntu') await import('./ubuntu/build.mjs');
else throw new Error('Native Linux packages currently support Arch and Ubuntu.');
