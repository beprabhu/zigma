// Launcher: boots the Next.js app (zepto-internal) on port 3000.
// The original zero-dependency server is preserved as server-legacy.js.
const { spawn } = require('child_process');
const path = require('path');

const child = spawn('npm', ['run', 'dev', '--', '--port', '3000'], {
  cwd: path.join(__dirname, 'zepto-internal'),
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
