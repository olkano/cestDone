// test-cli-spawn.cjs — Run from PowerShell: node test-cli-spawn.cjs [1|2|3|4]
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cliJs = path.join('C:', 'ProgramData', 'npm', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
const cmdPath = path.join('C:', 'ProgramData', 'npm', 'npm', 'claude.cmd');

const test = process.argv[2] || '1';

console.log(`=== Test ${test} ===`);
console.log('Node:', process.execPath);
console.log('cli.js exists:', fs.existsSync(cliJs));

if (test === '1') {
  // Test 1: stdio inherit — claude output goes directly to terminal
  console.log('Mode: node cli.js + stdio=inherit (TTY preserved)');
  console.log('---');
  const child = spawn(process.execPath, [
    cliJs, '-p', 'Say: hello',
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
  ], { stdio: 'inherit' });
  child.on('close', code => console.log('\n--- EXIT code=' + code));
  child.on('error', err => console.log('ERROR:', err.message));
  setTimeout(() => { console.log('\nTIMEOUT 120s'); child.kill(); }, 120000);

} else if (test === '2') {
  // Test 2: pipe but close stdin immediately
  console.log('Mode: node cli.js + pipe + close stdin');
  const child = spawn(process.execPath, [
    cliJs, '-p', 'Say: hello',
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const start = Date.now();
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] OUT ${d.length}B`); });
  child.stderr.on('data', d => console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] ERR: ${d.toString().trim().slice(0,200)}`));
  child.on('close', code => {
    console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] EXIT code=${code}`);
    if (stdout) { try { const p = JSON.parse(stdout); console.log('OK:', p.subtype, p.result?.slice(0,100)); } catch(e) { console.log('parse:', stdout.slice(0,200)); } }
    else console.log('No stdout');
  });
  setTimeout(() => { console.log('TIMEOUT 120s'); child.kill(); }, 120000);

} else if (test === '3') {
  // Test 3: .cmd wrapper + shell:true + stdio inherit
  console.log('Mode: claude.cmd + shell:true + stdio=inherit');
  console.log('---');
  const child = spawn(cmdPath, [
    '-p', 'Say: hello',
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
  ], { shell: true, stdio: 'inherit' });
  child.on('close', code => console.log('\n--- EXIT code=' + code));
  child.on('error', err => console.log('ERROR:', err.message));
  setTimeout(() => { console.log('\nTIMEOUT 120s'); child.kill(); }, 120000);

} else if (test === '4') {
  // Test 4: .cmd wrapper + shell:true + pipe
  console.log('Mode: claude.cmd + shell:true + pipe');
  const child = spawn(cmdPath, [
    '-p', 'Say: hello',
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
  ], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const start = Date.now();
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] OUT ${d.length}B`); });
  child.stderr.on('data', d => console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] ERR: ${d.toString().trim().slice(0,200)}`));
  child.on('close', code => {
    console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] EXIT code=${code}`);
    if (stdout) { try { const p = JSON.parse(stdout); console.log('OK:', p.subtype, p.result?.slice(0,100)); } catch(e) { console.log('parse:', stdout.slice(0,200)); } }
    else console.log('No stdout');
  });
  setTimeout(() => { console.log('TIMEOUT 120s'); child.kill(); }, 120000);

} else if (test === '5') {
  // Test 5: add --dangerously-skip-permissions
  console.log('Mode: pipe + --dangerously-skip-permissions');
  const child = spawn(process.execPath, [
    cliJs, '-p', 'Say: hello',
    '--output-format', 'json', '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
    '--dangerously-skip-permissions',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const start = Date.now();
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] OUT ${d.length}B`); });
  child.stderr.on('data', d => console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] ERR: ${d.toString().trim().slice(0,200)}`));
  child.on('close', code => {
    console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] EXIT code=${code}`);
    if (stdout) { try { const p = JSON.parse(stdout); console.log('OK:', p.subtype, p.result?.slice(0,100)); } catch(e) { console.log('parse:', stdout.slice(0,200)); } }
    else console.log('No stdout');
  });
  setTimeout(() => { console.log('TIMEOUT 60s'); child.kill(); }, 60000);

} else if (test === '6') {
  // Test 6: add --append-system-prompt (multiline)
  const sysPrompt = 'You are a Director AI.\n\nYou MUST respond with valid JSON matching this schema:\n{"type":"object","properties":{"action":{"type":"string"},"message":{"type":"string"}},"required":["action","message"]}';
  console.log('Mode: pipe + --dangerously-skip-permissions + --append-system-prompt');
  const child = spawn(process.execPath, [
    cliJs, '-p', 'Say: hello',
    '--output-format', 'json', '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
    '--dangerously-skip-permissions',
    '--append-system-prompt', sysPrompt,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const start = Date.now();
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] OUT ${d.length}B`); });
  child.stderr.on('data', d => console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] ERR: ${d.toString().trim().slice(0,200)}`));
  child.on('close', code => {
    console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] EXIT code=${code}`);
    if (stdout) { try { const p = JSON.parse(stdout); console.log('OK:', p.subtype, p.result?.slice(0,100)); } catch(e) { console.log('parse:', stdout.slice(0,200)); } }
    else console.log('No stdout');
  });
  setTimeout(() => { console.log('TIMEOUT 60s'); child.kill(); }, 60000);

} else if (test === '7') {
  // Test 7: add --disallowedTools
  console.log('Mode: pipe + --dangerously-skip-permissions + --disallowedTools');
  const child = spawn(process.execPath, [
    cliJs, '-p', 'Say: hello',
    '--output-format', 'json', '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
    '--dangerously-skip-permissions',
    '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'Bash',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const start = Date.now();
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] OUT ${d.length}B`); });
  child.stderr.on('data', d => console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] ERR: ${d.toString().trim().slice(0,200)}`));
  child.on('close', code => {
    console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] EXIT code=${code}`);
    if (stdout) { try { const p = JSON.parse(stdout); console.log('OK:', p.subtype, p.result?.slice(0,100)); } catch(e) { console.log('parse:', stdout.slice(0,200)); } }
    else console.log('No stdout');
  });
  setTimeout(() => { console.log('TIMEOUT 60s'); child.kill(); }, 60000);

} else if (test === '8') {
  // Test 8: add --strict-mcp-config + --mcp-config (empty file)
  const os = require('os');
  const mcpPath = path.join(os.tmpdir(), 'cestdone-test-mcp.json');
  fs.writeFileSync(mcpPath, '{"mcpServers":{}}');
  console.log('Mode: pipe + --dangerously-skip-permissions + --strict-mcp-config + --mcp-config');
  console.log('MCP config:', mcpPath);
  const child = spawn(process.execPath, [
    cliJs, '-p', 'Say: hello',
    '--output-format', 'json', '--max-turns', '1',
    '--model', 'claude-haiku-4-5-20251001',
    '--dangerously-skip-permissions',
    '--strict-mcp-config', '--mcp-config', mcpPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const start = Date.now();
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] OUT ${d.length}B`); });
  child.stderr.on('data', d => console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] ERR: ${d.toString().trim().slice(0,200)}`));
  child.on('close', code => {
    console.log(`[${((Date.now()-start)/1000).toFixed(1)}s] EXIT code=${code}`);
    if (stdout) { try { const p = JSON.parse(stdout); console.log('OK:', p.subtype, p.result?.slice(0,100)); } catch(e) { console.log('parse:', stdout.slice(0,200)); } }
    else console.log('No stdout');
  });
  setTimeout(() => { console.log('TIMEOUT 60s'); child.kill(); }, 60000);
}
