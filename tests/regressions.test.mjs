// node --test tests/regressions.test.mjs；SILLYTAVERN_ROOT 可指定本地酒馆源码目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const stRoot = process.env.SILLYTAVERN_ROOT || 'F:/SillyTavern/Luker';
const sseSource = fs.readFileSync(path.join(stRoot, 'public/scripts/sse-stream.js'), 'utf8');
// 运行酒馆实际的基础解析器，省去只供平滑流式 UI 使用的浏览器模块依赖。
const parserSource = sseSource.match(/class EventSourceStream\s*\{[\s\S]*?\r?\n\}/)?.[0];
assert.ok(parserSource, '酒馆源码应包含 EventSourceStream');
const EventSourceStream = vm.runInNewContext(parserSource + '\nEventSourceStream', {
    TextDecoderStream, TransformStream, MessageEvent,
});

function functions(names) {
    return names.map((name) => {
        const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\r?\\n\\}`));
        assert.ok(match, `找不到函数 ${name}`);
        return match[0];
    }).join('\n');
}

function transport(response, settings = {}) {
    const ctx = {
        TextDecoder, TextEncoder, TransformStream, EventSourceStream, soLastFinishReason: '',
        getSettings: () => settings,
        yzmShieldBody: (b) => b, normalizeOutgoingBody: (b) => b,
        resolveExtraParams: () => ({}), directHeaders: () => ({}),
        applyExtraHeaders: (h) => h, applyExtraBody: (b) => b,
        fetch: async () => response,
    };
    const code = functions(['classifySseData', 'extractNonStreamContent', 'streamDirect']);
    vm.runInNewContext(code.replace("import('/scripts/sse-stream.js')", 'Promise.resolve({ default: globalThis.EventSourceStream })'), ctx);
    return ctx;
}

function chunked(text, size = 1) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
        },
    }));
}

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const content = (text) => event({ choices: [{ delta: { content: text } }] });
const done = 'data: [DONE]\n\n';
async function read(ctx, signal) {
    const deltas = [];
    const text = await ctx.streamDirect('mock', '', {}, signal, (d) => deltas.push(d));
    return { text, deltas };
}

test('多行 data、中文跨字节、三种换行及 finish_reason', async () => {
    const wire = ': keepalive\n\ndata: {"choices":[\ndata: {"delta":{"content":"你好🌙"}}]}\n\n'
        + 'data: invalid-json\n\n' + content('！')
        + event({ choices: [{ delta: {}, finish_reason: 'length' }] }) + done;
    for (const newline of ['\n', '\r\n', '\r']) {
        const ctx = transport(chunked(wire.replaceAll('\n', newline)));
        assert.deepEqual(await read(ctx), { text: '你好🌙！', deltas: ['你好🌙', '！'] });
        assert.equal(ctx.soLastFinishReason, 'length');
    }
});

test('单块多个事件、无 DONE 的正常结束，以及普通 JSON 回退', async () => {
    assert.deepEqual(await read(transport(chunked(content('A') + content('B') + done, 65536))), {
        text: 'AB', deltas: ['A', 'B'],
    });
    assert.deepEqual(await read(transport(chunked(content('结束')))), { text: '结束', deltas: ['结束'] });
    const json = JSON.stringify({ choices: [{ message: { content: '普通回复🌙' } }] });
    assert.deepEqual(await read(transport(chunked(json))), { text: '普通回复🌙', deltas: ['普通回复🌙'] });
    assert.deepEqual(await read(transport(chunked(''))), { text: '', deltas: [] });
});

test('最后一个事件后面不带空行、事件之间只用单个换行（不规范中转）', async () => {
    const raw = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] });
    // 流在最后一个事件后直接结束：酒馆的解析器没有收尾处理，靠插件补的空行才不丢。
    assert.deepEqual(await read(transport(chunked(content('A') + raw('尾')))), { text: 'A尾', deltas: ['A', '尾'] });
    assert.deepEqual(await read(transport(chunked(content('A') + raw('尾') + '\n'))), { text: 'A尾', deltas: ['A', '尾'] });
    // 事件之间只有一个换行：按规范会被并成一个多行 data，整体解析不了时逐行再解析。
    for (const newline of ['\n', '\r\n']) {
        const wire = [raw('甲'), raw('乙'), 'data: [DONE]', ''].join(newline);
        assert.deepEqual(await read(transport(chunked(wire))), { text: '甲乙', deltas: ['甲', '乙'] });
    }
});

test('HTTP 错误与流中途错误仍然上报，已收到的内容照常回调', async () => {
    await assert.rejects(read(transport(new Response('bad gateway', { status: 502 }))), /HTTP 502.*bad gateway/);
    const deltas = [];
    const wire = content('半条回复') + event({ error: { message: 'provider failed' } }) + done;
    const ctx = transport(chunked(wire));
    await assert.rejects(ctx.streamDirect('mock', '', {}, undefined, (d) => deltas.push(d)), /回复可能不完整.*provider failed/);
    assert.deepEqual(deltas, ['半条回复']);
});

test('DONE 后取消仍打开的响应，忽略后续内容', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(content('完成') + done + content('不应出现'))); },
        cancel() { cancelled = true; },
    }));
    assert.deepEqual(await read(transport(response)), { text: '完成', deltas: ['完成'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
});

test('取消等待中的流式请求会结束读取并释放响应', async () => {
    const ctl = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const pending = read(transport(response), ctl.signal);
    setImmediate(() => ctl.abort());
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled, true);
});

test('后端转发仍直接使用原传输，不解析浏览器响应', async () => {
    const ctx = transport(null, { directViaBackend: true });
    ctx.streamBackendForward = async (url, key, body, signal, onDelta) => { onDelta('后端'); return '后端'; };
    ctx.fetch = () => { throw new Error('不应 fetch'); };
    assert.deepEqual(await read(ctx), { text: '后端', deltas: ['后端'] });
});

test('缺失 chatHistory 时完整补上下文；有占位时只插入一次并保留原顺序', () => {
    const ctx = {
        ENABLE_OFFSTAGE_GUARD: true,
        getCtx: () => ({ substituteParams: (s) => s, getCharacterCardFields: () => ({}) }),
        P: (id) => id, buildPersonaBlock: () => '',
        buildChatStatSection: () => '变量状态', buildChatWorldSection: () => '外部世界',
        getSummary: () => '概要', buildSummarySection: (s) => s,
        getBbsHistoryText: () => '柏宝书', buildBbsHistorySection: (s) => s,
        getLwbSummaryText: () => '小白X', buildLwbHistorySection: (s) => s,
        buildTranscriptTurns: () => [{ role: 'assistant', text: '故事记录' }],
        convoForPrompt: () => [{ role: 'user', content: '用户问题' }],
    };
    vm.runInNewContext(functions(['subst', 'pushMsg', 'expandMarker', 'getCuratedSnapshot', 'buildPresetMessages']), ctx);
    const text = (s) => ({ kind: 'text', role: 'system', content: s });
    const build = (items) => Array.from(ctx.buildPresetMessages({
        sysPromptPresetName: 'test', curatedPresets: { test: { items } },
    }), (m) => m.content);
    const history = ['变量状态', '外部世界', '概要', '柏宝书', '小白X', '故事记录', 'chat.tail', '用户问题'];
    assert.deepEqual(build([text('预设')]), ['chat.presetHeader', '预设', ...history]);
    assert.deepEqual(build([text('前'), { kind: 'marker', identifier: 'chatHistory' }, text('后')]), [
        'chat.presetHeader', '前', ...history, '后',
    ]);
    ctx.buildChatStatSection = () => '无变量时拒答';
    ctx.buildChatWorldSection = () => '';
    ctx.buildTranscriptTurns = () => [];
    assert.deepEqual(build([text('预设')]), [
        'chat.presetHeader', '预设', '无变量时拒答', '概要', '柏宝书', '小白X', '用户问题',
    ]);
});

test('四个条目列表共用筛选，保持分组显隐且不改选择状态', () => {
    const selectors = ['#so-bld-entry-list', '#so-lb-entries-list', '#so-diag-entries-list', '#so-wic-entries-list'];
    const lists = Object.fromEntries(selectors.map((selector) => {
        const rows = [
            { dataset: { book: 'A', hay: 'alice 12' }, style: {}, checked: true },
            { dataset: { book: 'B', hay: 'bob 24' }, style: {}, checked: false },
        ];
        const heads = ['A', 'B', 'Empty'].map((book) => ({ dataset: { book, hay: book.toLowerCase() }, style: {} }));
        return [selector, { rows, heads, querySelectorAll: (q) => q === '.so-lb-ent' ? rows : heads }];
    }));
    const ctx = { win: { querySelector: (selector) => lists[selector] } };
    vm.runInNewContext(functions(['filterBookEntries']), ctx);
    for (const selector of selectors) {
        const { rows, heads } = lists[selector];
        let refreshed = 0;
        const filter = (q) => ctx.filterBookEntries(selector, q, () => refreshed++);
        filter(' ALICE ');
        assert.deepEqual(rows.map((r) => r.style.display), ['', 'none']);
        assert.deepEqual(heads.map((h) => h.style.display), ['', 'none', 'none']);
        filter('empty');
        assert.deepEqual(rows.map((r) => r.style.display), ['none', 'none']);
        assert.deepEqual(heads.map((h) => h.style.display), ['none', 'none', '']);
        filter('不存在');
        assert.ok([...rows, ...heads].every((el) => el.style.display === 'none'));
        filter('');
        assert.ok([...rows, ...heads].every((el) => el.style.display === ''));
        assert.deepEqual(rows.map((r) => r.checked), [true, false]);
        assert.equal(refreshed, 4);
    }
    ctx.filterBookEntries('#missing', 'x', () => assert.fail('列表不存在时不刷新按钮'));
});

test('校正请求分派保留参数、取消信号和累计回调；无回调时强制非流式', async () => {
    for (const mode of ['direct', 'profile']) for (const stream of [false, true])
        for (const live of [false, true]) for (const sendTemperature of [false, true]) {
            const calls = [];
            const ctx = {
                fixEffMaxTokens: () => 8192, resolveEndpointUrl: () => 'https://mock/chat/completions',
                callDirect: async (...args) => { calls.push(['direct', args]); return 'AB'; },
                callProfile: async (...args) => { calls.push(['profile', args]); return 'AB'; },
                streamDirect: async (...args) => { calls.push(['directStream', args]); args.at(-1)('A'); args.at(-1)('B'); return 'AB'; },
                callProfileStream: async (...args) => { calls.push(['profileStream', args]); args.at(-1)('A'); args.at(-1)('AB'); return 'AB'; },
            };
            vm.runInNewContext(functions(['fixCallTransport']), ctx);
            const s = { mode, stream, sendTemperature, model: 'model', apiKey: 'test-key', profileId: 'profile', temperature: 0.4 };
            const messages = [{ role: 'user', content: '问题' }];
            const signal = new AbortController().signal;
            const updates = [];
            assert.equal(await ctx.fixCallTransport(s, messages, signal, live ? (t) => updates.push(t) : undefined), 'AB');
            assert.equal(calls.length, 1);
            const [kind, args] = calls[0];
            assert.equal(kind, mode + (stream && live ? 'Stream' : ''));
            assert.deepEqual(updates, stream && live ? ['A', 'AB'] : []);
            if (mode === 'direct') {
                assert.equal(args[0], 'https://mock/chat/completions');
                assert.equal(args[1], 'test-key');
                assert.equal(args[2].messages, messages);
                assert.deepEqual(structuredClone(args[2]), {
                    model: 'model', messages, max_tokens: 8192, ...(sendTemperature ? { temperature: 0.4 } : {}),
                });
                assert.equal(args[3], signal);
            } else {
                assert.equal(args[0], 'profile');
                assert.equal(args[1], messages);
                assert.equal(args[2], 8192);
                assert.deepEqual(structuredClone(args[3]), sendTemperature ? { temperature: 0.4 } : {});
                assert.equal(args[4], signal);
            }
        }
});

test('移除实验卡后仍显示应用和看改动按钮，并保留陈旧/截断保护', async () => {
    const element = () => ({
        children: [], listeners: {}, classList: { add() {}, remove() {} },
        appendChild(el) { this.children.push(el); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
    });
    for (const state of ['stale', 'truncated', 'ready', 'applied']) {
        const bubble = element();
        const writes = [];
        const ctx = {
            document: { createElement: element }, scrollToBottom() {},
            stripMechanismBlocks: (s) => s, fixNearCopyNote: () => '',
            fixTargetStale: () => ({ stale: state === 'stale', reason: 'changed' }),
            fixCurrentSnapshot: () => ({}), staleMsg: () => '目标已变',
            fixOutputTruncated: () => ({ truncated: state === 'truncated' }),
            composeFixedReply: (s) => s, wrapContentScope: (_, s) => s,
            applyFixAsSwipe: async (...args) => { writes.push(args); return true; },
        };
        vm.runInNewContext(functions(['addFixApplyControls']), ctx);
        ctx.addFixApplyControls({ querySelector: () => bubble }, { fixed: '新稿' }, '原稿', 4, [], {}, {}, undefined, { applied: state === 'applied' });
        const bar = bubble.children[0];
        assert.equal(bar.children.length, 3);
        const [apply, diff, status] = bar.children;
        assert.match(diff.innerHTML, /看改动/);
        assert.equal(typeof diff.listeners.click, 'function');
        await apply.listeners.click();
        assert.equal(writes.length, state === 'ready' ? 1 : 0);
        if (state === 'ready') assert.deepEqual(writes[0], [4, '新稿']);
        if (state === 'stale') assert.equal(status.textContent, '目标已变');
        if (state === 'truncated') assert.match(status.textContent, /截断/);
        if (state === 'applied') assert.equal(apply.disabled, true);
    }
});

test('连接存档带上高级选项与生成参数；旧存档只比对已有的项', () => {
    const keys = source.match(/const CONN_PRESET_KEYS = (\[[^\]]*\]);/)?.[1];
    assert.ok(keys, '找不到 CONN_PRESET_KEYS');
    const s = {
        mode: 'direct', endpoint: 'https://a/v1', apiKey: 'k', model: 'm', directRawUrl: false,
        directViaBackend: true, extraIncludeBody: 'a: 1', extraExcludeBody: '', extraIncludeHeaders: '',
        temperature: 1, maxTokens: 12288, stream: true, sendTemperature: false,
    };
    const ctx = { getSettings: () => s };
    vm.runInNewContext(`const CONN_PRESET_KEYS = ${keys};\n`
        + functions(['connPresetUpsert', 'connPresetSnapshot', 'connValSame', 'connPresetIsCurrent'])
        + '\nObject.assign(globalThis, { connPresetUpsert, connPresetSnapshot, connPresetIsCurrent });', ctx);
    const list = ctx.connPresetUpsert([], { ...ctx.connPresetSnapshot(s), name: 'A' });
    assert.deepEqual(structuredClone(list[0]), {
        name: 'A', endpoint: 'https://a/v1', apiKey: 'k', model: 'm', rawUrl: false,
        directViaBackend: true, extraIncludeBody: 'a: 1', extraExcludeBody: '', extraIncludeHeaders: '',
        temperature: 1, maxTokens: 12288, stream: true, sendTemperature: false,
    });
    assert.equal(ctx.connPresetIsCurrent(list[0], s), true);
    for (const [k, v] of [['temperature', 0.7], ['stream', false], ['directViaBackend', false], ['extraIncludeBody', '']]) {
        assert.equal(ctx.connPresetIsCurrent(list[0], { ...s, [k]: v }), false, k);
    }
    // 清空的数字框（NaN）和存盘读回的 null 算同一个值
    assert.equal(ctx.connPresetIsCurrent({ ...list[0], temperature: null }, { ...s, temperature: NaN }), true);
    // 旧存档只有四项：其余设置怎么改都不算「已修改」
    const old = { name: 'B', endpoint: 'https://a/v1', apiKey: 'k', model: 'm', rawUrl: false };
    assert.equal(ctx.connPresetIsCurrent(old, { ...s, temperature: 0.2, stream: false }), true);
    // upsert 不把没给的项写成 undefined
    assert.equal('temperature' in ctx.connPresetUpsert([], old)[0], false);
});
