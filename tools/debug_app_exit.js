const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const exe = 'C:\\Users\\datan\\AppData\\Local\\Programs\\WhatsApp\\WhatsApp.exe';
const logFile = path.join(__dirname, '..', 'whatsapp_launch_debug.log');

const child = spawn(exe, ['--enable-logging'], {
  cwd: path.dirname(exe),
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', d => {
  out += '[STDOUT] ' + d;
  fs.appendFileSync(logFile, '[STDOUT] ' + d);
});

child.stderr.on('data', d => {
  out += '[STDERR] ' + d;
  fs.appendFileSync(logFile, '[STDERR] ' + d);
});

child.on('error', err => {
  fs.appendFileSync(logFile, '[ERROR] ' + err.stack);
});

child.on('exit', (code, signal) => {
  fs.appendFileSync(logFile, `[EXIT] code=${code} signal=${signal}\n`);
  console.log(`Exited with code ${code}, signal ${signal}`);
  process.exit(0);
});

setTimeout(() => {
  console.log('Still running after 10s!');
  process.exit(0);
}, 10000);
