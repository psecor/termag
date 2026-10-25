// Stand-in for Bedrock runtime (E2E_FAKE_BEDROCK=1), plain HTTP on loopback.
// Serves InvokeModel and InvokeModelWithResponseStream for Anthropic models,
// the latter as AWS event-stream frames the way Bedrock sends them. It checks
// that each call carries a SigV4 signature for service "bedrock" and no bearer
// token, logs each call (model, region and access key id from the signature,
// never the signature itself), and writes Bedrock-style invocation log lines
// (request id, model, token counts) to E2E_BEDROCK_INVOCATION_LOG, as Bedrock's
// model-invocation logging does. GET /_e2e/calls returns the call log.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const port = Number(process.env.E2E_BEDROCK_PORT);
const invocationLog = process.env.E2E_BEDROCK_INVOCATION_LOG;
const calls = [];
const record = (line) => { calls.push(line); console.log(new Date().toISOString(), line); };

function header(name, value) {
  const n = Buffer.from(name); const v = Buffer.from(value);
  const b = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
  let o = 0;
  b.writeUInt8(n.length, o); o += 1; n.copy(b, o); o += n.length;
  b.writeUInt8(7, o); o += 1; b.writeUInt16BE(v.length, o); o += 2; v.copy(b, o);
  return b;
}

// One event-stream message: prelude (total, headers length, prelude CRC),
// headers, payload, message CRC.
function frame(payload) {
  const headers = Buffer.concat([
    header(':event-type', 'chunk'), header(':content-type', 'application/json'), header(':message-type', 'event'),
  ]);
  const body = Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(payload)).toString('base64') }));
  const total = 12 + headers.length + body.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4); preludeCrc.writeUInt32BE(crc32(prelude) >>> 0);
  const msg = Buffer.concat([prelude, preludeCrc, headers, body]);
  const msgCrc = Buffer.alloc(4); msgCrc.writeUInt32BE(crc32(msg) >>> 0);
  return Buffer.concat([msg, msgCrc]);
}

function sigv4(auth) {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/.exec(auth ?? '');
  return m ? { accessKeyId: m[1], region: m[2], service: m[3] } : null;
}

// A scripted tool turn, so a real Claude Code session can be driven through a
// tool it was given (an MCP server's, say). A user line `call <tool> <text>`
// gets a ToolSearch `select:<tool>` while the tool is deferred, then a
// tool_use with {text}, then a reply quoting the tool's result.
const blocksOf = c => (typeof c === 'string' ? [{ type: 'text', text: c }] : c ?? []);
function textOf(content) {
  return blocksOf(content).map(b => (b.type === 'text' ? b.text : b.content !== undefined ? textOf(b.content) : '')).join('\n');
}
function scriptedTurn(request) {
  const msgs = (request.messages ?? []).filter(x => x.role !== 'system');
  let ask = null; let askAt = -1;
  msgs.forEach((x, i) => {
    if (x.role !== 'user') return;
    for (const b of blocksOf(x.content)) {
      const m = b.type === 'text' && !b.text.startsWith('<system-reminder>') && /^call ([\w-]+)[ \t]*(.*)/m.exec(b.text);
      if (m) { ask = m; askAt = i; }
    }
  });
  const last = msgs.at(-1);
  if (!ask || last?.role !== 'user') return null;
  const [, name, arg] = ask;
  const ours = msgs.slice(askAt + 1).filter(x => x.role === 'assistant').flatMap(x => blocksOf(x.content))
    .filter(b => b.type === 'tool_use' && String(b.id).startsWith('toolu_e2e'));
  const called = ours.find(b => b.name === name);
  if (called) {
    const result = blocksOf(last.content).find(b => b.type === 'tool_result' && b.tool_use_id === called.id);
    return result ? { text: `(fake Bedrock) ${name} answered: ${textOf(result.content).slice(0, 200)}` } : null;
  }
  const use = (tool, input) => ({ toolUse: { type: 'tool_use', id: `toolu_e2e${randomUUID().slice(0, 8)}`, name: tool, input } });
  const tools = (request.tools ?? []).map(t => t.name);
  if (tools.includes(name) || ours.some(b => b.name === 'ToolSearch')) return use(name, { text: arg.trim() });
  if (tools.includes('ToolSearch')) return use('ToolSearch', { query: `select:${name}`, max_results: 1 });
  return null;
}

createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    if (req.method === 'GET' && path === '/_e2e/calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(calls));
    }
    const m = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/.exec(path);
    const sig = sigv4(req.headers.authorization);
    if (!m || req.method !== 'POST') {
      record(`${req.method} ${path} -> 404`);
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"message":"UnknownOperationException"}');
    }
    const [, model, op] = m;
    if (!sig || sig.service !== 'bedrock') {
      record(`${op} ${model} -> 403 (no SigV4 for bedrock)`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end('{"message":"Missing Authentication Token"}');
    }
    let request = {};
    try { request = JSON.parse(body); } catch { /* reported below */ }
    const prompt = (request.messages ?? []).map(x => (typeof x.content === 'string' ? x.content : JSON.stringify(x.content))).join(' ');
    const scripted = scriptedTurn(request);
    const toolUse = scripted?.toolUse;
    const text = scripted?.text ?? (toolUse ? JSON.stringify(toolUse.input) : `(fake Bedrock) ${model} says hello; you said: ${prompt.slice(0, 80)}`);
    const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
    const outputTokens = Math.max(1, Math.ceil(text.length / 4));
    const requestId = randomUUID();
    record(`${op} ${model} -> 200 sigv4=${sig.accessKeyId}/${sig.region}/${sig.service} bearer=${/bearer/i.test(req.headers.authorization ?? '') ? 'present' : 'absent'} termag-headers=${Object.keys(req.headers).some(h => h.startsWith('x-termag-')) ? 'present' : 'absent'} requestId=${requestId}`);
    if (invocationLog) {
      appendFileSync(invocationLog, JSON.stringify({
        timestamp: new Date().toISOString(), requestId, operation: op === 'invoke' ? 'InvokeModel' : 'InvokeModelWithResponseStream',
        modelId: model, region: sig.region, input: { inputTokenCount: inputTokens }, output: { outputTokenCount: outputTokens },
      }) + '\n');
    }
    const message = {
      id: `msg_${requestId.slice(0, 8)}`, type: 'message', role: 'assistant', model,
      content: [toolUse ?? { type: 'text', text }], stop_reason: toolUse ? 'tool_use' : 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
    if (op === 'invoke') {
      res.writeHead(200, {
        'content-type': 'application/json', 'x-amzn-requestid': requestId,
        'x-amzn-bedrock-input-token-count': String(inputTokens), 'x-amzn-bedrock-output-token-count': String(outputTokens),
      });
      return res.end(JSON.stringify(message));
    }
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': requestId });
    res.write(frame({ type: 'message_start', message: { ...message, content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } }));
    if (toolUse) {
      res.write(frame({ type: 'content_block_start', index: 0, content_block: { ...toolUse, input: {} } }));
      res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } }));
    } else {
      res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      for (const piece of text.match(/.{1,24}/gs)) {
        res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
      }
    }
    res.write(frame({ type: 'content_block_stop', index: 0 }));
    res.write(frame({ type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: outputTokens } }));
    res.end(frame({
      type: 'message_stop',
      'amazon-bedrock-invocationMetrics': { inputTokenCount: inputTokens, outputTokenCount: outputTokens },
    }));
  });
}).listen(port, '127.0.0.1', () => console.log(`bedrock stub on 127.0.0.1:${port}`));
