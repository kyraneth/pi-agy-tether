#!/usr/bin/env node
// Offline ACP fixture for the external installed-Pi loading boundary.
const { readFileSync, readdirSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
if (args[0] !== 'acp') process.exit(1);
const arg = name => args.includes(name) ? args[args.indexOf(name)+1] : undefined;
const agent = arg('--agent');
const recipe = agent ? readFileSync(join(arg('--gemini-dir'), 'config', 'agents', agent, 'agent.md'), 'utf8') : '';
const marker = recipe.match(/Tether session marker: (\w+)/)?.[1];
const sessionId = randomUUID();
const modelId = 'gemini-4-hydrogen';
let model = modelId, effort = 'high';
const opts = () => [
  { id: 'model', currentValue: model, options: [{ value: modelId, name: 'Gemini 4 Hydrogen' }] },
  { id: 'thought_level', currentValue: effort, options: ['minimal', 'low', 'medium', 'high'].map(value => ({ value, name: value })) },
];
const send = fields => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...fields })}\n`);
const update = value => send({method: 'session/update', params: {sessionId, update: value}});
createInterface({ input: process.stdin }).on('line', line => {
  const { method, id, params } = JSON.parse(line);
  const respond = result => send({ id, result });
  switch (method) {
    case 'initialize':
      respond({ agentInfo: { version: '1.5.16' }, agentCapabilities: {promptCapabilities: {image: true}} });
      break;
    case 'session/new':
      // The probe and conversation must not point agy's crawler at Pi's cwd.
      assert.equal(realpathSync(params.cwd), process.cwd());
      assert.notEqual(process.cwd(), process.env.SMOKE_PI_WORKSPACE);
      assert.deepEqual(readdirSync(process.cwd()), []);
      respond({ sessionId, configOptions: opts(), models: {availableModels: [{modelId, name: 'Gemini 4 Hydrogen'}]} });
      break;
    case 'session/set_config_option':
      if (params.configId === 'model') model = params.value;
      if (params.configId === 'thought_level') effort = params.value;
      respond({ configOptions: opts() });
      break;
    case 'session/prompt': {
      const markerPrompt = params.prompt.some(block => block.text === 'Reply with the tether session marker only.');
      if (!markerPrompt && /^tools: \[search_web\]$/m.test(recipe)) {
        update({sessionUpdate: 'tool_call', name: 'search_web', toolCallId: 'search-smoke', status: 'in_progress', rawInput: {query: 'smoke query'}});
        update({sessionUpdate: 'tool_call_update', toolCallId: 'search-smoke', status: 'completed', rawOutput: 'must not leak'});
      }
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: markerPrompt ? marker : 'ACP smoke OK'}});
      respond({stopReason: 'end_turn'});
      break;
    }
    default:
      send({id,error:{code:-32601,message:`Unexpected fixture method: ${method}`}});
  }
});
