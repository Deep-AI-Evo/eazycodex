/**
 * easyCodex Proxy Server
 *
 * Translates Codex's OpenAI Responses API calls into DeepSeek Chat Completions.
 *
 * SSE event lifecycle modeled on cc-switch's codex_responses_sse.rs.
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';
const PROXY_PORT = 18731;
const UPSTREAM_TIMEOUT_MS = 600000;

const MODEL_CATALOG = {
  models: [
    {
      slug: 'deepseek-v4-flash',
      name: 'DeepSeek-V4 Flash',
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balanced speed and reasoning' },
        { effort: 'high', description: 'Greater reasoning depth' }
      ],
      apply_patch_tool_type: 'freeform',
      shell_type: 'shell_command',
      support_verbosity: true,
      priority: 1000
    },
    {
      slug: 'deepseek-v4-pro',
      name: 'DeepSeek-V4 Pro',
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: 'high', description: 'Maximum reasoning depth' }
      ],
      apply_patch_tool_type: 'freeform',
      shell_type: 'shell_command',
      support_verbosity: false,
      priority: 900
    }
  ]
};

function modelContextWindow(slug) {
  if (slug === 'deepseek-v4-flash') return 1000000;
  if (slug === 'deepseek-v4-pro') return 128000;
  return 128000;
}

let apiKey = '';
let server = null;
let logCallback = null;

function setApiKey(key) { apiKey = key || ''; }
let configuredModel = '';
function setModel(model) { configuredModel = model || ''; }
function setLogCallback(cb) { logCallback = cb; }
function log(msg) { if (logCallback) logCallback(msg); }
function genId(prefix) { return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }

// --- SSE helpers (match cc-switch codex_responses_sse.rs exactly) ---

function sseEvent(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

// --- Usage conversion (match cc-switch chat_usage_to_responses_usage) ---

function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } };
  }
  var inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  var outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  var totalTokens = usage.total_tokens || (inputTokens + outputTokens);
  var result = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };

  var cached = 0, cacheWrite = 0;
  if (usage.prompt_tokens_details) cached = usage.prompt_tokens_details.cached_tokens || 0;
  if (usage.input_tokens_details) { cached = usage.input_tokens_details.cached_tokens || 0; cacheWrite = usage.input_tokens_details.cache_write_tokens || 0; }
  if (usage.cache_creation_input_tokens) cacheWrite = usage.cache_creation_input_tokens;
  if (cached > 0 || cacheWrite > 0) {
    result.input_tokens_details = { cached_tokens: cached, cache_write_tokens: cacheWrite };
  }

  if (usage.completion_tokens_details) {
    var details = Object.assign({}, usage.completion_tokens_details);
    if (details.reasoning_tokens === undefined) details.reasoning_tokens = 0;
    result.output_tokens_details = details;
  } else {
    result.output_tokens_details = { reasoning_tokens: 0 };
  }

  if (usage.cache_read_input_tokens) result.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (cacheWrite > 0) result.cache_creation_input_tokens = cacheWrite;
  return result;
}

function responseIdFromChatId(id) {
  if (!id) return genId('resp_');
  return id.startsWith('resp_') ? id : 'resp_' + id;
}

function responseStatusFromFinishReason(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

// Normalize upstream Chat Completions error into Responses API error format
// (match cc-switch chat_error_to_response_error)
function normalizeErrorResponse(statusCode, errBody) {
  var message = 'Upstream error';
  var errorType = 'upstream_error';
  var code = null;
  var param = null;
  try {
    var parsed = typeof errBody === 'string' ? JSON.parse(errBody) : errBody;
    var source = parsed.error || parsed;
    // Try message, then detail, then base_resp/status_msg
    if (typeof source === 'string') {
      message = source;
    } else if (typeof source.message === 'string') {
      message = source.message;
    } else if (typeof source.detail === 'string') {
      message = source.detail;
    } else if (source.base_resp && typeof source.base_resp.status_msg === 'string') {
      message = source.base_resp.status_msg;
    } else if (typeof source === 'object') {
      message = JSON.stringify(source);
    }
    if (source.type) errorType = source.type;
    if (source.code !== undefined) code = source.code;
    else if (source.base_resp && source.base_resp.status_code !== undefined) code = source.base_resp.status_code;
    if (source.param !== undefined) param = source.param;
  } catch (e) {
    if (errBody) message = String(errBody).substring(0, 500);
  }
  return { error: { message: message, type: errorType, code: code, param: param } };
}

function baseResponse(id, status, model, output, createdAt, usage) {
  var resp = {
    id: id,
    object: 'response',
    created_at: createdAt || 0,
    status: status,
    model: model || 'deepseek-v4-pro',
    output: output || [],
    usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } }
  };
  return resp;
}

// --- Request conversion ---

// Registry of custom tool names for current request (match cc-switch CodexToolKind::Custom)
var customToolNames = {};

// Build correct tool call item: custom_tool_call for custom tools, function_call otherwise
// (match cc-switch response_tool_call_item_from_chat_name)
function buildToolCallItem(itemId, status, callId, name, args, isInProgress, cn) {
  cn = cn || customToolNames;
  if (cn[name]) {
    var inputVal = '';
    if (args && args.trim()) {
      try {
        var parsed = JSON.parse(args);
        inputVal = (parsed && typeof parsed === 'object' && parsed.input !== undefined) ? String(parsed.input) : args;
      } catch (e) { inputVal = args; }
    }
    return { id: itemId, type: 'custom_tool_call', status: status, call_id: callId, name: name, input: inputVal };
  }
  return { id: itemId, type: 'function_call', status: status, call_id: callId, name: name, arguments: args };
}

// SSE event name for tool arg delta/done, varies by custom vs function tool
function toolArgEventName(name, suffix, cn) {
  cn = cn || customToolNames;
  return cn[name] ? 'response.custom_tool_call_input.' + suffix : 'response.function_call_arguments.' + suffix;
}


// Map Responses API roles to Chat Completions roles (match cc-switch responses_role_to_chat_role)
function mapRole(role) {
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  return 'user';
}

// Collapse multiple system messages to head (match cc-switch collapse_system_messages_to_head)
function collapseSystemMessages(messages) {
  var systemChunks = [];
  var rest = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'system') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        systemChunks.push(msg.content);
      }
    } else {
      rest.push(msg);
    }
  }
  var out = [];
  if (systemChunks.length > 0) {
    out.push({ role: 'system', content: systemChunks.join('\n\n') });
  }
  return out.concat(rest);
}

function responsesInputToMessages(body) {
  var messages = [];
  if (body.instructions) {
    var instrText = instructionText(body.instructions);
    if (instrText) messages.push({ role: 'system', content: instrText });
  }
  var input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (var i = 0; i < input.length; i++) {
      var item = input[i];
      if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
      if (item.type === 'message' || item.role) {
        var role = mapRole(item.role || 'user');
        var content = extractTextFromContent(item.content);
        if (content) messages.push({ role: role, content: content });
        continue;
      }
      if (item.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
        continue;
      }
      if (item.type === 'custom_tool_call_output') {
        // Custom tool results (e.g. apply_patch output) - same as function_call_output
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
        continue;
      }
      if (item.type === 'custom_tool_call') {
        // Previous custom tool call in input history (e.g. apply_patch)
       var ctcLast = messages[messages.length - 1];
       if (ctcLast && (ctcLast.role === 'assistant' || ctcLast.role === 'system')) {
         if (!ctcLast.tool_calls) ctcLast.tool_calls = [];
          ctcLast.tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.input || '' } });
        } else {
          messages.push({ role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.input || '' } }] });
        }
        continue;
      }
      // Standalone input items (match cc-switch input_text/input_image handling)
      if (item.type === 'input_text' || item.type === 'input_image' || item.type === 'input_file' || item.type === 'input_audio') {
        var inputRole = mapRole(item.role || 'user');
        var inputContent = item.text || '';
        if (inputContent) messages.push({ role: inputRole, content: inputContent });
        continue;
      }
      if (item.type === 'reasoning') continue;
      if (item.type === 'function_call') {
        var last = messages[messages.length - 1];
        if (last && (last.role === 'assistant' || last.role === 'system')) {
          if (!last.tool_calls) last.tool_calls = [];
          last.tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '' } });
        } else {
          messages.push({ role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '' } }] });
        }
        continue;
      }
    }
  }
  return collapseSystemMessages(messages);
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(function(p) { return typeof p === 'string' ? p : (p.text || ''); }).join('');
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  customToolNames = {};
  var converted = [];
  for (var i = 0; i < tools.length; i++) {
    var tool = tools[i];
    if (tool.type === 'function') {
      var name = tool.name;
      // cc-switch also checks nested tool.function.name
      if (!name && tool.function && tool.function.name) name = tool.function.name;
      if (!name) continue;
      var fn;
      if (tool.function && typeof tool.function === 'object') {
        // Nested function object format
        fn = Object.assign({}, tool.function, { name: name });
        if (tool.strict !== undefined && fn.strict === undefined) fn.strict = tool.strict;
      } else {
        // Top-level fields format (Responses API)
        fn = { name: name, description: tool.description, parameters: tool.parameters || { type: 'object', properties: {} } };
        if (tool.strict !== undefined) fn.strict = tool.strict;
      }
      converted.push({ type: 'function', function: fn });
    } else if (tool.type === 'custom') {
      // Custom tools (e.g. apply_patch): wrap as function tool with 'input' parameter
      // (match cc-switch add_custom_tool)
      var customName = tool.name;
      if (!customName && tool.function && tool.function.name) customName = tool.function.name;
      if (!customName) continue;
      customToolNames[customName] = true;
      var customDesc = 'Original tool definition:\n```json\n' + JSON.stringify(tool) + '\n```';
      converted.push({ type: 'function', function: {
        name: customName,
        description: customDesc,
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: 'Raw string input for the original custom tool.' } },
          required: ['input']
        }
      } });
    }
  }
  return converted.length > 0 ? converted : undefined;
}

// Convert Responses tool_choice to Chat Completions format
function convertToolChoice(tc, hasTools) {
  if (!hasTools) return undefined; // Drop tool_choice when no tools
  if (typeof tc === 'string') return tc;
  if (tc && typeof tc === 'object') {
    if (tc.type === 'auto') return 'auto';
    if (tc.type === 'none') return 'none';
    if (tc.type === 'required') return 'required';
    if (tc.type === 'function') {
      return { type: 'function', function: { name: tc.name } };
    }
  }
  return undefined;
}

// Extract reasoning text from various delta/message shapes (match cc-switch extract_reasoning_field_text)
function extractReasoningText(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.reasoning_content === 'string' && value.reasoning_content) return value.reasoning_content;
  if (typeof value.reasoning === 'string' && value.reasoning) return value.reasoning;
  if (value.reasoning && typeof value.reasoning === 'object') {
    var rkeys = ['content', 'text', 'summary'];
    for (var ki = 0; ki < rkeys.length; ki++) {
      if (typeof value.reasoning[rkeys[ki]] === 'string' && value.reasoning[rkeys[ki]]) return value.reasoning[rkeys[ki]];
    }
  }
  if (Array.isArray(value.reasoning_details)) {
    var parts = [];
    var dkeys = ['text', 'content', 'summary'];
    for (var ri = 0; ri < value.reasoning_details.length; ri++) {
      var detail = value.reasoning_details[ri];
      for (var dk = 0; dk < dkeys.length; dk++) {
        if (detail && typeof detail[dkeys[dk]] === 'string' && detail[dkeys[dk]]) { parts.push(detail[dkeys[dk]]); break; }
      }
    }
    if (parts.length) return parts.join('\n\n');
  }
  return '';
}

// Flatten instructions that may be string or array of parts (match cc-switch instruction_text)
function instructionText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(function(p) {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      return '';
    }).filter(function(s) { return s.length > 0; }).join('\n\n');
  }
  return '';
}

// Extra fields to pass through from Responses to Chat Completions (match cc-switch EXTRA_CHAT_PASSTHROUGH_FIELDS)
var EXTRA_PASSTHROUGH_FIELDS = [
  'parallel_tool_calls', 'frequency_penalty', 'logit_bias', 'logprobs', 'metadata',
  'n', 'presence_penalty', 'response_format', 'seed', 'service_tier', 'stop',
  'top_logprobs', 'user'
];

function responsesToChatCompletions(body) {
  var chatBody = {
   // Force the configured model (match cc-switch apply_codex_upstream_model:
   // always override the request's model with the provider's configured model)
   model: configuredModel || body.model || 'deepseek-v4-pro',
   messages: responsesInputToMessages(body),
   stream: body.stream !== undefined ? body.stream : false
 };
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
 if (body.max_output_tokens !== undefined) chatBody.max_tokens = body.max_output_tokens;

  // DeepSeek reasoning: send thinking:{type:enabled} + reasoning_effort with deepseek effort mapping
  // (cc-switch DeepSeek config: thinking_param="thinking", effort_param="reasoning_effort",
  // effort_value_mode="deepseek" which maps max/xhigh->max, else->high)
  if (body.reasoning) {
    var dsEffort = body.reasoning.effort ? String(body.reasoning.effort).trim().toLowerCase() : '';
    var reasoningOn = !(dsEffort === 'none' || dsEffort === 'off' || dsEffort === 'disabled');
    chatBody.thinking = { type: reasoningOn ? 'enabled' : 'disabled' };
    if (reasoningOn && dsEffort) {
      chatBody.reasoning_effort = (dsEffort === 'max' || dsEffort === 'xhigh') ? 'max' : 'high';
    }
  }

  // Pass through extra Chat Completions fields (match cc-switch EXTRA_CHAT_PASSTHROUGH_FIELDS)
  for (var ei = 0; ei < EXTRA_PASSTHROUGH_FIELDS.length; ei++) {
    var pfKey = EXTRA_PASSTHROUGH_FIELDS[ei];
    if (body[pfKey] !== undefined) chatBody[pfKey] = body[pfKey];
  }

var tools = convertTools(body.tools);
if (tools) chatBody.tools = tools;
 var hasTools = !!tools;
 var convertedChoice = convertToolChoice(body.tool_choice, hasTools);
 if (convertedChoice !== undefined) chatBody.tool_choice = convertedChoice;
 // Drop parallel_tool_calls when no tools (match cc-switch: strict upstreams
 // like DeepSeek reject parallel_tool_calls without a non-empty tools array)
 if (!hasTools && chatBody.parallel_tool_calls !== undefined) {
   delete chatBody.parallel_tool_calls;
 }
if (chatBody.stream) chatBody.stream_options = { include_usage: true };
return chatBody;
}

// --- Main request proxy ---

function proxyResponsesRequest(req, res, requestBody) {
  var chatBody;
 try {
   var parsed = JSON.parse(requestBody.toString('utf8'));
   chatBody = responsesToChatCompletions(parsed);
   var reqCustom = Object.assign({}, customToolNames);
   log('Proxy: req model="' + (parsed.model || 'none') + '" -> upstream model="' + chatBody.model + '" | ' + chatBody.messages.length + ' msgs | stream=' + chatBody.stream + ' | tools=' + (chatBody.tools ? chatBody.tools.length : 0));
 } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid request body: ' + e.message } }));
    return;
  }

  var postData = JSON.stringify(chatBody);
  var targetUrl = new URL('/v1/chat/completions', DEEPSEEK_API_BASE);
 var options = {
   hostname: targetUrl.hostname, port: 443, path: targetUrl.pathname, method: 'POST',
   headers: {
     'Content-Type': 'application/json',
     'Authorization': 'Bearer ' + apiKey,
     'Content-Length': Buffer.byteLength(postData),
     'Accept': chatBody.stream ? 'text/event-stream' : 'application/json'
   },
   timeout: UPSTREAM_TIMEOUT_MS,
   family: 4
 };

  var proxyReq = https.request(options, function(proxyRes) {
   if (proxyRes.statusCode !== 200) {
     var errBody = '';
     proxyRes.on('data', function(c) { errBody += c; });
     proxyRes.on('end', function() {
       log('Proxy: DeepSeek returned ' + proxyRes.statusCode + ': ' + errBody.substring(0, 300));
       if (!res.headersSent) {
          var normalized = normalizeErrorResponse(proxyRes.statusCode, errBody);
          if (chatBody.stream) {
            // For streaming requests, send SSE response.failed event
            var respId = genId('resp_');
            var failResp = baseResponse(respId, 'failed', chatBody.model, [], 0, null);
            failResp.error = normalized.error;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
            res.write(sseEvent('response.failed', { type: 'response.failed', response: failResp }));
            res.end();
          } else {
            // For non-streaming, send Responses-format JSON error
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(normalized));
          }
       }
     });
     return;
   }

    if (chatBody.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      log('Proxy: upstream connected, starting stream translation...');
      streamTranslate(proxyRes, res, chatBody.model, reqCustom);
    } else {
      var data = '';
      proxyRes.on('data', function(c) { data += c; });
     proxyRes.on('end', function() {
       try {
         var chatResp = JSON.parse(data);
          // Check for error in response body even with 200 status
          if (chatResp.error) {
            var normalized = normalizeErrorResponse(200, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(normalized));
            return;
          }
         var responsesResp = chatCompletionToResponse(chatResp, chatBody.model, reqCustom);
         res.writeHead(200, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify(responsesResp));
        } catch (e) {
          log('Proxy: Failed to parse response: ' + e.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Failed to parse upstream response' } }));
          }
        }
      });
    }
  });

  proxyReq.on('timeout', function() {
    log('Proxy: Upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'DeepSeek API timeout' } }));
    }
  });

  proxyReq.on('error', function(e) {
    log('Proxy: Request error: ' + e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Failed to connect to DeepSeek API: ' + e.message } }));
    }
  });

  proxyReq.write(postData);
  proxyReq.end();
}

/**
 * Stream translator: Chat Completions SSE -> Responses SSE.
 * Matches cc-switch streaming_codex_chat.rs exactly.
 */
function streamTranslate(proxyRes, clientRes, model, reqCustom) {
  reqCustom = reqCustom || {};
  var buffer = '';
  var utf8Remainder = null;
  var responseId = genId('resp_');
  var createdAt = 0;
  var responseStarted = false;
  var completed = false;
  var streamFailed = false;
  var latestUsage = null;
  var finishReason = null;
  var nextOutputIndex = 0;

  // Completed output items (sorted by output_index)
  var outputItems = [];

  // Reasoning state
  var reasoningState = { added: false, done: false, outputIndex: -1, itemId: '', text: '' };

  // Message/text state
  var textState = { added: false, done: false, outputIndex: -1, itemId: '', text: '' };

  // Tool call state
  var tools = {};

  function write(data) {
    if (!clientRes.writableEnded) clientRes.write(data);
  }

  function nextIndex() { return nextOutputIndex++; }

  function makeResp(status, output) {
    return baseResponse(responseId, status, model, output || [], createdAt, latestUsage);
  }

  function ensureResponseStarted() {
    if (responseStarted) return;
    responseStarted = true;
    var resp = makeResp('in_progress', []);
    write(sseEvent('response.created', { type: 'response.created', response: resp }));
    write(sseEvent('response.in_progress', { type: 'response.in_progress', response: resp }));
  }

  function failedEvent(message, errorType) {
    completed = true;
    var error = { message: message };
    if (errorType) error.type = errorType;
    var resp = makeResp('failed', []);
    resp.error = error;
    write(sseEvent('response.failed', { type: 'response.failed', response: resp }));
    if (!clientRes.writableEnded) clientRes.end();
  }

  function pushReasoningDelta(delta) {
    if (!reasoningState.added) {
      reasoningState.added = true;
      reasoningState.outputIndex = nextIndex();
      reasoningState.itemId = 'rs_' + responseId;
      write(sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: reasoningState.outputIndex,
        item: { id: reasoningState.itemId, type: 'reasoning', status: 'in_progress', summary: [] }
      }));
      write(sseEvent('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        item_id: reasoningState.itemId,
        output_index: reasoningState.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' }
      }));
    }
    reasoningState.text += delta;
    write(sseEvent('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningState.itemId,
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      delta: delta
    }));
  }

  function finalizeReasoning() {
    if (!reasoningState.added || reasoningState.done) return;
    reasoningState.done = true;
    var text = reasoningState.text;
    var item = { id: reasoningState.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: text }] };
    outputItems.push({ index: reasoningState.outputIndex, item: item });
    write(sseEvent('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      item_id: reasoningState.itemId,
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      text: text
    }));
    write(sseEvent('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done',
      item_id: reasoningState.itemId,
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: text }
    }));
    write(sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: reasoningState.outputIndex,
      item: item
    }));
  }

  function pushTextDelta(delta) {
    if (!textState.added) {
      textState.added = true;
      textState.outputIndex = nextIndex();
      textState.itemId = responseId + '_msg';
      write(sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: textState.outputIndex,
        item: { id: textState.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
      }));
      write(sseEvent('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: textState.itemId,
        output_index: textState.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      }));
    }
    textState.text += delta;
    write(sseEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: textState.itemId,
      output_index: textState.outputIndex,
      content_index: 0,
      delta: delta
    }));
  }

  function finalizeText() {
    if (!textState.added || textState.done) return;
    textState.done = true;
    var text = textState.text;
    var item = { id: textState.itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: text, annotations: [] }] };
    outputItems.push({ index: textState.outputIndex, item: item });
    write(sseEvent('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: textState.itemId,
      output_index: textState.outputIndex,
      content_index: 0,
      text: text
    }));
    write(sseEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: textState.itemId,
      output_index: textState.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: text, annotations: [] }
    }));
    write(sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: textState.outputIndex,
      item: item
    }));
  }

  function finalizeTools() {
    var keys = Object.keys(tools).sort(function(a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) {
      var state = tools[keys[i]];
      if (state.done) continue;
      if (!state.name) { state.done = true; continue; }
      state.done = true;
      if (!state.added) {
        state.added = true;
        state.outputIndex = nextIndex();
        if (!state.callId) state.callId = 'call_' + keys[i];
        state.itemId = (reqCustom[state.name] ? 'ctc_' : 'fc_') + state.callId;
        write(sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: state.outputIndex,
          item: buildToolCallItem(state.itemId, 'in_progress', state.callId, state.name, '', true, reqCustom)
        }));
      }
      var item = buildToolCallItem(state.itemId, 'completed', state.callId, state.name, state.arguments, false, reqCustom);
      outputItems.push({ index: state.outputIndex, item: item });
      var doneEvt = toolArgEventName(state.name, 'done', reqCustom);
      var doneObj = { type: doneEvt, item_id: state.itemId, output_index: state.outputIndex };
      if (reqCustom[state.name]) doneObj.input = item.input; else doneObj.arguments = state.arguments;
      write(sseEvent(doneEvt, doneObj));
      write(sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item: item
      }));
    }
  }

  function hasSubstantiveOutput() {
    return !!(textState.text.trim() || reasoningState.text.trim() ||
           outputItems.length > 0 ||
           Object.keys(tools).some(function(k) { return tools[k].added || tools[k].callId || tools[k].name || tools[k].arguments; }));
  }

  function getCompletedOutputItems() {
    return outputItems.slice().sort(function(a, b) { return a.index - b.index; }).map(function(e) { return e.item; });
  }

  function finalize() {
    if (completed) return;
    ensureResponseStarted();
    finalizeReasoning();
    finalizeText();
    finalizeTools();

    var status = responseStatusFromFinishReason(finishReason);
    var resp = makeResp(status, getCompletedOutputItems());
    if (status === 'incomplete') {
      resp.incomplete_details = { reason: 'max_output_tokens' };
    }
    write(sseEvent('response.completed', { type: 'response.completed', response: resp }));
    completed = true;
    if (!clientRes.writableEnded) clientRes.end();
  }

  // --- Process upstream chunks ---

  proxyRes.on('data', function(chunk) {
    if (streamFailed) return;
    // Safe UTF-8 append: hold back incomplete trailing bytes to avoid corrupting
    // multi-byte characters split across TCP chunk boundaries.
    // Walk backwards from end to find the last lead byte and check if its full
    // sequence is present. Correctly handles 2/3/4-byte sequences (CJK, emoji).
    var chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (utf8Remainder) {
      chunkBuf = Buffer.concat([utf8Remainder, chunkBuf]);
      utf8Remainder = null;
    }
    var safeEnd = chunkBuf.length;
    if (safeEnd > 0) {
      for (var bi = safeEnd - 1; bi >= Math.max(0, safeEnd - 4); bi--) {
        var b = chunkBuf[bi];
        if (b < 0x80) break; // ASCII byte - all preceding bytes are complete
        if (b >= 0xC0) {
          // Lead byte found: determine expected sequence length
          var expectedBytes = b < 0xE0 ? 2 : (b < 0xF0 ? 3 : 4);
          if (safeEnd - bi < expectedBytes) {
            utf8Remainder = chunkBuf.slice(bi);
            safeEnd = bi;
          }
          break;
        }
        // Continuation byte (0x80-0xBF), keep walking back
      }
    }
    buffer += chunkBuf.slice(0, safeEnd).toString('utf8');
    var lines = buffer.split('\n');
    buffer = lines.pop();

    for (var li = 0; li < lines.length; li++) {
      var trimmed = lines[li].trim();
      if (!trimmed) continue;
      var dataStr = '';
      if (trimmed.indexOf('data: ') === 0) dataStr = trimmed.slice(6);
      else if (trimmed.indexOf('data:') === 0) dataStr = trimmed.slice(5);
      else continue;
      if (dataStr === '[DONE]') { finalize(); return; }

      var chatChunk;
      try { chatChunk = JSON.parse(dataStr); } catch (e) { continue; }

      // Track metadata from upstream
      if (chatChunk.id) responseId = responseIdFromChatId(chatChunk.id);
      if (chatChunk.model) model = chatChunk.model;
      if (chatChunk.created) createdAt = chatChunk.created;
      if (chatChunk.usage) latestUsage = chatUsageToResponsesUsage(chatChunk.usage);

     // Check for error in stream
     if (chatChunk.error) {
        var normalized = normalizeErrorResponse(200, chatChunk);
        var errMsg = normalized.error.message;
        var errType = normalized.error.type || normalized.error.code;
       failedEvent(errMsg, errType);
       streamFailed = true;
       return;
     }

      var choice = chatChunk.choices && chatChunk.choices[0];
      if (!choice) continue;
      var delta = choice.delta || {};

      ensureResponseStarted();

      // Track finish reason
      if (choice.finish_reason) finishReason = choice.finish_reason;

     // Reasoning content
      var reasoningText = extractReasoningText(delta);
      if (reasoningText) {
        pushReasoningDelta(reasoningText);
      }

     // Text content
      if (delta.content) {
        finalizeReasoning();
        pushTextDelta(delta.content);
      }

     // Tool calls
     if (delta.tool_calls) {
       finalizeReasoning();
       finalizeText();
       for (var tci = 0; tci < delta.tool_calls.length; tci++) {
         var tc = delta.tool_calls[tci];
         var idx = tc.index !== undefined ? tc.index : 0;
         if (!tools[idx]) tools[idx] = { added: false, done: false, outputIndex: -1, itemId: '', callId: '', name: '', arguments: '' };

         // Update state from delta (cc-switch accumulates before deciding to add)
         if (tc.id) tools[idx].callId = tc.id;
         if (!tools[idx].callId) tools[idx].callId = 'call_' + idx;
         if (tc.function && tc.function.name) tools[idx].name = tc.function.name;
         if (tc.function && tc.function.arguments) tools[idx].arguments += tc.function.arguments;

         // Only add the output item once we have both call_id AND name
         // (match cc-switch: !state.added && !state.call_id.is_empty() && !state.name.is_empty())
         if (!tools[idx].added && tools[idx].callId && tools[idx].name) {
           tools[idx].added = true;
           tools[idx].outputIndex = nextIndex();
           tools[idx].itemId = (reqCustom[tools[idx].name] ? 'ctc_' : 'fc_') + tools[idx].callId;
           write(sseEvent('response.output_item.added', {
             type: 'response.output_item.added',
             output_index: tools[idx].outputIndex,
             item: buildToolCallItem(tools[idx].itemId, 'in_progress', tools[idx].callId, tools[idx].name, '', true, reqCustom)
           }));
         }

         // Send argument deltas only after the item has been added
         if (tools[idx].added && tc.function && tc.function.arguments) {
           var deltaEvtName = toolArgEventName(tools[idx].name, 'delta', reqCustom);
           write(sseEvent(deltaEvtName, {
             type: deltaEvtName,
             item_id: tools[idx].itemId,
             output_index: tools[idx].outputIndex,
             delta: tc.function.arguments
           }));
         }
       }
     }
    }
  });

  proxyRes.on('end', function() {
    if (streamFailed) return;
    if (completed || finishReason) {
      finalize();
    } else if (hasSubstantiveOutput()) {
      finishReason = 'length';
      finalize();
    } else {
      failedEvent('Upstream stream ended before sending finish_reason', 'stream_truncated');
    }
  });

  proxyRes.on('error', function(e) {
    log('Proxy: Stream error: ' + e.message);
    if (!completed && !streamFailed) {
      failedEvent('Stream error: ' + e.message, 'stream_error');
    }
  });
}

// --- Non-streaming response conversion ---

function chatCompletionToResponse(chatResp, model, reqCustom) {
  reqCustom = reqCustom || customToolNames;
  var choice = chatResp.choices && chatResp.choices[0];
  if (!choice) return { id: genId('resp_'), object: 'response', created_at: 0, status: 'failed', model: model, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } } };

 var message = choice.message || {};
 var output = [];

  var nsReasoning = extractReasoningText(message);
  if (nsReasoning) {
    output.push({ id: genId('rs_'), type: 'reasoning', summary: [{ type: 'summary_text', text: nsReasoning }] });
 }
 if (message.content) {
    output.push({ id: genId('msg_'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  }
  if (message.tool_calls) {
    for (var i = 0; i < message.tool_calls.length; i++) {
      var tc = message.tool_calls[i];
      var toolIdPrefix = (reqCustom[tc.function.name] ? 'ctc_' : 'fc_');
      output.push(buildToolCallItem(genId(toolIdPrefix), 'completed', tc.id, tc.function.name, tc.function.arguments || '', false, reqCustom));
    }
  }

  var status = responseStatusFromFinishReason(choice.finish_reason);
  var resp = {
    id: responseIdFromChatId(chatResp.id),
    object: 'response',
    created_at: chatResp.created || 0,
    status: status,
    model: chatResp.model || model,
    output: output,
    usage: chatUsageToResponsesUsage(chatResp.usage)
  };
  if (status === 'incomplete') {
    resp.incomplete_details = { reason: 'max_output_tokens' };
  }
  return resp;
}

// --- Passthrough proxy ---

function proxyPassthrough(req, res, requestBody) {
  var targetUrl = new URL(req.url, DEEPSEEK_API_BASE);
  var options = {
    hostname: targetUrl.hostname, port: 443,
    path: targetUrl.pathname + targetUrl.search, method: req.method,
    headers: Object.assign({}, req.headers, { host: targetUrl.hostname, Authorization: 'Bearer ' + apiKey })
  };
  delete options.headers['content-length'];
  var proxyReq = https.request(options, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', function(e) {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); }
  });
  if (requestBody && requestBody.length > 0) proxyReq.write(requestBody);
  proxyReq.end();
}

// --- Server ---

function start() {
  return new Promise(function(resolve, reject) {
    server = http.createServer(function(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', provider: 'deepseek', hasKey: !!apiKey }));
        return;
      }
     if (req.url === '/v1/models' || req.url === '/models') {
       res.writeHead(200, { 'Content-Type': 'application/json' });
        var modelsWithCtx = MODEL_CATALOG.models.map(function(m) {
          m.context_window = modelContextWindow(m.slug);
          m.max_context_window = modelContextWindow(m.slug);
          m.truncation_policy = { limit: 10000, mode: 'tokens' };
          return m;
        });
        res.end(JSON.stringify({ models: modelsWithCtx }));
        return;
     }

      var bodyChunks = [];
      req.on('data', function(c) { bodyChunks.push(c); });
      req.on('end', function() {
        var requestBody = Buffer.concat(bodyChunks);
        if (req.url === '/v1/responses' || req.url === '/responses') {
          if (!apiKey) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'DeepSeek API key not configured.' } })); return; }
          proxyResponsesRequest(req, res, requestBody); return;
        }
        if (req.url === '/v1/chat/completions' || req.url === '/chat/completions') {
          if (!apiKey) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'DeepSeek API key not configured.' } })); return; }
          proxyPassthrough(req, res, requestBody); return;
        }
        proxyPassthrough(req, res, requestBody);
      });
      req.on('error', function() { if (!res.headersSent) { res.writeHead(400); res.end(); } });
    });
    server.on('error', function(e) { log('Proxy: Server error: ' + e.message); reject(e); });
    server.listen(PROXY_PORT, '127.0.0.1', function() { log('Proxy: Listening on http://127.0.0.1:' + PROXY_PORT); resolve(PROXY_PORT); });
  });
}

function stop() {
  return new Promise(function(resolve) {
    if (server) { server.close(function() { server = null; resolve(); }); }
    else resolve();
  });
}

function isRunning() { return server !== null && server.listening; }

module.exports = { start: start, stop: stop, isRunning: isRunning, setApiKey: setApiKey, setModel: setModel, setLogCallback: setLogCallback, PROXY_PORT: PROXY_PORT };
