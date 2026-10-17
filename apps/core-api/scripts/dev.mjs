import { spawn } from 'node:child_process';
import { once } from 'node:events';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  return spawn(npmCommand, args, { stdio: 'inherit' });
}

const initialBuild = run(['exec', 'tsc', '--', '-p', 'tsconfig.build.json']);
const [initialExitCode] = await once(initialBuild, 'exit');
if (initialExitCode !== 0) process.exitCode = initialExitCode ?? 1;
else {
  const compiler = run(['exec', 'tsc', '--', '-p', 'tsconfig.build.json', '--watch']);
  const server = spawn(process.execPath, ['--watch', 'dist/main.js'], { stdio: 'inherit' });
  const stop = () => {
    compiler.kill('SIGTERM');
    server.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const [serverExitCode] = await once(server, 'exit');
  stop();
  process.exitCode = serverExitCode ?? 0;
}
