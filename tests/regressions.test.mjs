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
    const code = functions(['classifySseData', 'unwrapCompletion', 'extractNonStreamContent', 'streamDirect', 'callDirect']);
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

// 五种预设的固定样例在 640f601 上冻结；日常测试不读取 Git。
const presetModes = ['Lorebook', 'Fix', 'Advisor', 'Diagnose', 'Builder'];
const textItem = (content, role) => ({ kind: 'text', content, role });
const historyItem = { kind: 'marker', identifier: 'chatHistory' };
const presetShapes = [
    [textItem('前 {{user}}'), textItem('后', 'assistant')],
    [textItem('前'), historyItem, textItem('后', 'assistant')],
    [historyItem, textItem('中'), historyItem, textItem('尾')],
    ['personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoBefore',
        'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'unknown'].map((identifier) => ({ kind: 'marker', identifier })),
    [textItem(''), textItem(' \n'), textItem(null), textItem('{{user}}', 'user')],
    [], null,
];
function presetFixture(mode, shape, directive, over, blank, guard = true) {
    let fixCalls = 0;
    const ctx = {
        ENABLE_OFFSTAGE_GUARD: guard && !blank,
        getCtx: () => ({ substituteParams: (s) => s.replaceAll('{{user}}', '小明'),
            getCharacterCardFields: () => ({ persona: '人格', description: '角色', personality: '性格', scenario: '场景', mesExamples: '示例' }) }),
        getCuratedSnapshot: () => presetShapes[shape] == null ? null : { items: presetShapes[shape] },
        convoForPrompt: () => blank ? [] : [{ role: 'user', content: '问 {{user}}' }, { role: 'assistant', content: '答' }],
        buildLorebookPrompt: () => blank ? '' : '世界书',
        buildFixPrompt: () => { fixCalls++; return blank ? '' : '校正'; },
        buildAdvisorPrompt: () => blank ? '' : '参谋', buildBuilderPrompt: () => blank ? '' : '工坊',
        lbSnapshotMsg: () => ({ role: 'system', content: blank ? '' : '快照 {{user}}' }),
        P: () => '参谋身份', wiBefore: '世界前', wiAfter: '世界后',
    };
    const names = ['subst', 'pushMsg', 'expandMarker', ...presetModes.map((m) => `build${m}PresetMessages`)];
    if (/function walkPresetItems\(/.test(source)) names.push('walkPresetItems');
    vm.runInNewContext(functions(names), ctx);
    const s = { sysPromptPresetName: 'test' };
    const d = [undefined, '', 'x', null][directive];
    const override = over ? { block: blank ? '' : '覆盖参谋', tail: blank ? [] : [{ role: 'user', content: '覆盖尾 {{user}}' }] } : undefined;
    const result = mode === 'Diagnose' ? ctx.buildDiagnosePresetMessages(s, blank ? '' : '诊断', d)
        : mode === 'Advisor' ? ctx.buildAdvisorPresetMessages(s, override)
        : ctx[`build${mode}PresetMessages`](s, d);
    return [JSON.stringify(result), fixCalls];
}

const PRESET_EXPECTED = [
    [["Lorebook",0,0,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",0,0,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Lorebook",1,0,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",1,0,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Lorebook",2,0,false,false],"[{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",2,0,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"},{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Lorebook",3,0,false,false],"[{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",3,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Lorebook",4,0,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",4,0,false,true],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Lorebook",5,0,false,false],"[{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",5,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Lorebook",6,0,false,false],"[{\"role\":\"system\",\"content\":\"世界书\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"快照 {{user}}\"}]",0],
    [["Lorebook",6,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Fix",0,0,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",0,1,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"校正\"}]",1],
    [["Fix",0,2,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",0,3,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",0,0,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",0,1,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",0,2,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",0,3,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,0,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,1,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,2,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,3,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,0,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,1,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,2,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",1,3,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",1],
    [["Fix",2,0,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,1,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,2,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,3,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,0,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,1,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",2,3,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",1],
    [["Fix",3,0,false,false],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",3,1,false,false],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"},{\"role\":\"system\",\"content\":\"校正\"}]",1],
    [["Fix",3,2,false,false],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",3,3,false,false],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",3,0,false,true],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"}]",1],
    [["Fix",3,1,false,true],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"}]",1],
    [["Fix",3,2,false,true],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",3,3,false,true],"[{\"role\":\"system\",\"content\":\"人格\"},{\"role\":\"system\",\"content\":\"角色\"},{\"role\":\"system\",\"content\":\"性格\"},{\"role\":\"system\",\"content\":\"场景\"},{\"role\":\"system\",\"content\":\"世界前\"},{\"role\":\"system\",\"content\":\"世界后\"},{\"role\":\"system\",\"content\":\"示例\"}]",1],
    [["Fix",4,0,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",4,1,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"校正\"}]",1],
    [["Fix",4,2,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",4,3,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",4,0,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",1],
    [["Fix",4,1,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",1],
    [["Fix",4,2,false,true],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",4,3,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",1],
    [["Fix",5,0,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",5,1,false,false],"[{\"role\":\"system\",\"content\":\"校正\"}]",1],
    [["Fix",5,2,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",5,3,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",5,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",2],
    [["Fix",5,1,false,true],"[{\"role\":\"system\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"\"}]",2],
    [["Fix",5,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",5,3,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",2],
    [["Fix",6,0,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",6,1,false,false],"[{\"role\":\"system\",\"content\":\"校正\"}]",1],
    [["Fix",6,2,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",6,3,false,false],"[{\"role\":\"system\",\"content\":\"校正\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",1],
    [["Fix",6,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",2],
    [["Fix",6,1,false,true],"[{\"role\":\"system\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"\"}]",2],
    [["Fix",6,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"}]",1],
    [["Fix",6,3,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",2],
    [["Advisor",0,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",0,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",0,0,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",0,0,true,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",1,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",1,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",1,0,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",1,0,true,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",2,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Advisor",2,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Advisor",2,0,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Advisor",2,0,true,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Advisor",3,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",3,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",3,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Advisor",3,0,true,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Advisor",4,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",4,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",4,0,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",0],
    [["Advisor",4,0,true,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",0],
    [["Advisor",5,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",5,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",5,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Advisor",5,0,true,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Advisor",6,0,false,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",6,0,true,false],"[{\"role\":\"system\",\"content\":\"参谋身份\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",6,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Advisor",6,0,true,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Diagnose",0,0,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",0,1,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"诊断\"}]",0],
    [["Diagnose",0,2,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",0,3,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",0,0,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",0,1,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",0,2,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",0,3,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,0,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,1,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,2,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,3,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,0,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,1,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,2,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",1,3,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Diagnose",2,0,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,1,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,2,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,3,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,0,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,1,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",2,3,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Diagnose",3,0,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",3,1,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"}]",0],
    [["Diagnose",3,2,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",3,3,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",3,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Diagnose",3,1,false,true],"[{\"role\":\"system\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"\"}]",0],
    [["Diagnose",3,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",3,3,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Diagnose",4,0,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",4,1,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"诊断\"}]",0],
    [["Diagnose",4,2,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",4,3,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",4,0,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",0],
    [["Diagnose",4,1,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",0],
    [["Diagnose",4,2,false,true],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",4,3,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",0],
    [["Diagnose",5,0,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",5,1,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"}]",0],
    [["Diagnose",5,2,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",5,3,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",5,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Diagnose",5,1,false,true],"[{\"role\":\"system\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"\"}]",0],
    [["Diagnose",5,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",5,3,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Diagnose",6,0,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",6,1,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"}]",0],
    [["Diagnose",6,2,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",6,3,false,false],"[{\"role\":\"system\",\"content\":\"诊断\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Diagnose",6,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Diagnose",6,1,false,true],"[{\"role\":\"system\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"\"}]",0],
    [["Diagnose",6,2,false,true],"[{\"role\":\"user\",\"content\":\"x\"}]",0],
    [["Diagnose",6,3,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Builder",0,0,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Builder",0,0,false,true],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Builder",1,0,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Builder",1,0,false,true],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Builder",2,0,false,false],"[{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Builder",2,0,false,true],"[{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Builder",3,0,false,false],"[{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Builder",3,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Builder",4,0,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Builder",4,0,false,true],"[{\"role\":\"user\",\"content\":\"小明\"}]",0],
    [["Builder",5,0,false,false],"[{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Builder",5,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Builder",6,0,false,false],"[{\"role\":\"system\",\"content\":\"工坊\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Builder",6,0,false,true],"[{\"role\":\"system\",\"content\":\"\"}]",0],
    [["Advisor",0,0,false,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",0,0,true,false,false],"[{\"role\":\"system\",\"content\":\"前 小明\"},{\"role\":\"assistant\",\"content\":\"后\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",1,0,false,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",1,0,true,false,false],"[{\"role\":\"system\",\"content\":\"前\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"},{\"role\":\"assistant\",\"content\":\"后\"}]",0],
    [["Advisor",2,0,false,false,false],"[{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Advisor",2,0,true,false,false],"[{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"},{\"role\":\"system\",\"content\":\"中\"},{\"role\":\"system\",\"content\":\"尾\"}]",0],
    [["Advisor",3,0,false,false,false],"[{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",3,0,true,false,false],"[{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",4,0,false,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",4,0,true,false,false],"[{\"role\":\"user\",\"content\":\"小明\"},{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",5,0,false,false,false],"[{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",5,0,true,false,false],"[{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
    [["Advisor",6,0,false,false,false],"[{\"role\":\"system\",\"content\":\"参谋\"},{\"role\":\"user\",\"content\":\"问 {{user}}\"},{\"role\":\"assistant\",\"content\":\"答\"}]",0],
    [["Advisor",6,0,true,false,false],"[{\"role\":\"system\",\"content\":\"覆盖参谋\"},{\"role\":\"user\",\"content\":\"覆盖尾 {{user}}\"}]",0],
];

test('五种预设逐字节固定期望：结构、空值、覆盖尾、身份头与校正求值次数', () => {
    for (const [args, expected, calls] of PRESET_EXPECTED) {
        assert.deepEqual(presetFixture(...args), [expected, calls], JSON.stringify(args));
    }
    assert.equal(PRESET_EXPECTED.length, 182, '固定期望矩阵不可缺项');
});

// 入口用真实函数；只替换模型、上下文和 DOM，计时器由测试显式触发。
function sendHarness(settings, options = {}) {
    const calls = [], paints = [], errors = [], timers = [], activeTimers = new Map();
    let timerId = 0, rendered = '';
    const ui = { textContent: '', isConnected: true, style: {},
        classList: { add() {}, remove() {}, toggle() {} } };
    const el = { isConnected: true, querySelector: () => ui };
    const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: '问题' }];
    const context = { chat: [{ mes: '故事', is_user: false }] };
    const builder = { brief: { raw: '汇总' }, draft: { target: 'npc-new', content: '原稿' } };
    const noop = () => {};
    const ctx = {
        AbortController, console: { error: (...a) => errors.push(a), debug: noop },
        setTimeout(fn, ms) { const id = ++timerId; timers.push(ms); activeTimers.set(id, fn); return id; },
        clearTimeout(id) { activeTimers.delete(id); },
        getSettings: () => settings, getCtx: () => context,
        isGenerating: false, abortCtl: null, postReplyAbortCtl: null, postReplyCancelled: false,
        POST_REPLY_CALL_TIMEOUT_MS: Number(source.match(/const POST_REPLY_CALL_TIMEOUT_MS = (\d+)/)[1]),
        fixTargetProse: '原文', fixTargetIdx: 0, fixCaptured: { chatId: 'chat' },
        fixScopeDecision: null, fixPieceDecision: null, fixPieceTable: null, ENABLE_FIX_PIECEWISE: false,
        captureFixContext: async () => ({}), isFixSwipe: () => false,
        getFixCfg: () => ({}), getEffectiveFixCfg: () => ({}), resolveFixModeCfg: () => ({ targets: {} }),
        compileFixTargets: () => '目标', fixTargetOverrides: () => ({}), fixUsePresetFor: () => false,
        presetCurationActive: () => false, maybeWrapJb: (m) => m,
        buildFixPrompt: () => '校正', fixLandAutoDecisions: () => ({ stop: false }),
        fixPreFilter: () => true, clampFixAutoMinChars: () => 0,
        showAutoFixGenerating: noop, showAutoDiagGenerating: noop, dismissToast: noop,
        parseFixedReply: () => null, fixFailureReason: () => ({ kind: 'ok' }),
        replyExpectsMvu: () => false, addAutoFixNote: noop, fixOriginalReply: '原文',
        cidSeq: 0, addMessage: () => el, showTyping: () => noop,
        setGenerating(on) { ctx.isGenerating = on; }, scrollToBottom: noop, soFollowStream: true,
        addSystemNote: noop, modeEntryNote: noop, win: null,
        renderFixCard(_el, _ui, _entry, text) { rendered = text; return 'ok'; },
        isUserAbort: (e) => e.name === 'AbortError',
        diagnoseMode: false, lorebookMode: false, advisorMode: false, fixMode: false, builderMode: false,
        warmLwbSummaryIfCold: async () => {}, buildWorldInfo: async () => '', sideChatScanBlob: async () => '',
        ENABLE_WI_EJS_RENDER: false, assembleExternalWorld: () => '', buildMessages: () => messages,
        soLastFinishReason: 'previous', stripMechanismBlocks: (s) => s, stripReasoningTags: (s) => s,
        renderMarkdownOnly: () => null, convo: [], persistConvo: noop, addRetryControl: noop,
        errChainMessage: (e) => e.message, explainProviderError: (s) => s,
        getBuilderState: () => builder, buildBuilderContext: async () => {}, buildForgeMessages: () => messages,
        convoStreamKey: 'room', liveForge: null, liveCondense: null,
        paintForge(run) { paints.push(run.text); }, routeForgeReply: noop,
        renderBuilderReplyHtml: () => null, parseCharDraft: () => ({ draft: null }),
        ENABLE_DRAFT_CONDENSE: true, ENABLE_LIGHT_CONDENSE: false,
        condenseStyleFlagged: () => true,
        condenseSplitSections: () => ['甲', '乙', '丙'].map((text) => ({ names: [text], text })),
        P: (id, vars) => id + (vars ? ':' + JSON.stringify(vars) : ''),
        parseCondenseReply: () => ({ content: '分节' }), condenseAssemble: () => ({ content: '合稿' }),
        parseCondenseOps: () => ({ ops: [] }), applyCondenseOps: () => ({ content: '精简', applied: 0, vetoed: [] }),
        condenseGuards: () => ({ pass: true, ratio: 0.5 }), setBuilderState: noop, refreshDraftCard: noop,
        getMvu: async () => ({ getMvuData: () => ({}) }), getMvuStatData: async () => ({}),
        awaitMvuIdle: async () => {}, postReplyShouldStop: () => false,
        ENABLE_SCHEMA_DIAG: !!options.diagRetry, ENABLE_DIAG_FLOOR_SEED: false,
        maybeRunSaveHealth: async () => {}, diagPickerActive: () => false, wiContextMode: () => 'off',
        collectMvuUpdateRules: async () => [], diagStatKey: () => 'stat', chatIdentityKey: () => 'chat',
        resolveAutoTargetMessage: () => ({ idx: 0, text: '故事' }), extractUpdateBlock: () => '',
        diagGateProbe: () => ({ executed: false, deadBlock: false }), buildDiagnosePromptFrom: () => '诊断',
        diagParseFailReason: () => ({ code: 'unparsed', detail: '' }),
        diagSchemaRetryRound: async (_text, _md, _s, msgs, retry) => ({
            finalText: await retry([...msgs, { role: 'user', content: '重试' }]), schemaRetried: true,
        }),
        diagShownPatch: (_r, patch) => patch, AUTO_DIAGNOSE_WRITE_BACK: false,
        notifyAutoDiagnose: noop, mvuMsgOpts: () => ({}),
    };
    for (const [kind, stream] of [['direct', false], ['directStream', true], ['profile', false], ['profileStream', true]]) {
        const name = { direct: 'callDirect', directStream: 'streamDirect', profile: 'callProfile', profileStream: 'callProfileStream' }[kind];
        ctx[name] = async (...args) => {
            const direct = kind.startsWith('direct');
            const signal = args[direct ? 3 : 4];
            const body = direct ? args[2] : { messages: args[1], max_tokens: args[2], ...args[3] };
            const call = { kind, args, body, signal, stream, updates: [] };
            calls.push(call);
            options.onCall?.(ctx, call);
            if (options.hold) return new Promise((_resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
                if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            });
            if (stream) for (const text of direct ? ['A', 'B'] : ['A', 'AB']) {
                args.at(-1)(text);
                call.updates.push(ui.textContent);
            }
            if (options.failure) throw options.failure;
            return 'AB';
        };
    }
    vm.runInNewContext(functions(['soCallModel', 'fixEffMaxTokens', 'fixCallTransport', 'resolveEndpointUrl', 'normalizeUrl',
        'runFixByTargets', 'runAutoFix', 'beginPostReplyCall', 'cancelPostReply', 'stopGeneration',
        'generateReply', 'gemini3MaxTokensFloor', 'runForge', 'runCondenseDepth', 'runAutoDiagnose']), ctx);
    return { ctx, calls, messages, paints, errors, timers, activeTimers, ui, rendered: () => rendered };
}

const sendSettings = (mode, stream, sendTemperature) => ({
    mode, stream, sendTemperature, endpoint: 'https://mock/v1', model: 'gemini-3-test',
    apiKey: 'test-key', profileId: 'profile', maxTokens: 1024, fixMaxTokens: 8192, bldMaxTokens: 20000, temperature: 0.4,
});

function checkCaptured(h, s, expectedMessages, tokens, stream) {
    assert.equal(h.calls.length, expectedMessages.length);
    h.calls.forEach((call, i) => {
        assert.equal(call.kind, s.mode + (stream ? 'Stream' : ''));
        assert.equal(call.stream, stream);
        assert.deepEqual(structuredClone(call.body), {
            ...(s.mode === 'direct' ? { model: s.model } : {}), messages: expectedMessages[i], max_tokens: tokens,
            ...(s.sendTemperature ? { temperature: 0.4 } : {}),
        });
        assert.equal(call.signal instanceof AbortSignal, true);
        assert.equal(call.signal.aborted, false);
        if (s.mode === 'direct') assert.deepEqual(call.args.slice(0, 2), ['https://mock/v1/chat/completions', 'test-key']);
        else assert.equal(call.args[0], 'profile');
    });
    assert.deepEqual(h.errors, []);
    assert.equal(h.activeTimers.size, 0);
    assert.equal(h.ctx.abortCtl, null);
    assert.equal(h.ctx.postReplyAbortCtl, null);
}

test('发送入口参数矩阵：主回复、按目标校正、自动校正、锻造、深度精简、自动诊断及重写', async () => {
    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const temperature of [false, true]) {
        const s = sendSettings(mode, stream, temperature);
        for (const entry of ['generateReply', 'runFixByTargets', 'runAutoFix', 'runForge', 'runCondenseDepth', 'runAutoDiagnose', 'diagRetry']) {
            const h = sendHarness(s, { diagRetry: entry === 'diagRetry', onCall(ctx, call) {
                assert.equal(call.signal, entry.startsWith('runAuto') || entry === 'diagRetry' ? ctx.postReplyAbortCtl.signal : ctx.abortCtl.signal);
            } });
            const auto = entry === 'runAutoDiagnose' || entry === 'diagRetry';
            const method = entry === 'diagRetry' ? 'runAutoDiagnose' : entry;
            await h.ctx[method](h.ctx.getCtx(), s, 0, 'chat');
            const fixed = [{ role: 'system', content: '校正' }, { role: 'user', content: '目标' }];
            const diag = [{ role: 'system', content: '诊断' }, { role: 'user', content: 'diag.askDerive' }];
            const depth = ['甲', '乙', '丙'].map((text) => [
                { role: 'system', content: 'bld.condenseSect' },
                { role: 'user', content: 'bld.condenseSectAsk:' + JSON.stringify({ full: '原稿', names: text, text }) },
            ]);
            depth.push([{ role: 'system', content: 'bld.condenseOps' }, { role: 'user', content: 'bld.condenseOpsAsk:{"draft":"合稿"}' }]);
            const expected = entry === 'runCondenseDepth' ? depth : auto ? (entry === 'diagRetry'
                ? [diag, [...diag, { role: 'user', content: '重试' }]] : [diag])
                : entry.includes('Fix') ? [fixed] : [h.messages];
            const tokens = entry === 'generateReply' ? (mode === 'direct' ? 4096 : 1024)
                : entry.includes('Fix') ? 8192 : auto ? 4096 : 20000;
            const useStream = entry === 'runCondenseDepth' || (!auto && entry !== 'runAutoFix' && stream);
            checkCaptured(h, s, expected, tokens, useStream);
            if (useStream && ['generateReply', 'runFixByTargets'].includes(entry)) assert.deepEqual(h.calls[0].updates, ['A', 'AB']);
            if (useStream && ['runForge', 'runCondenseDepth'].includes(entry)) {
                const texts = h.paints.filter((t) => t === 'A' || t === 'AB' || /：\n\n(?:A|AB)$/.test(t));
                assert.equal(texts.length, h.calls.length * 2);
                assert.ok(texts.every((t, i) => t.endsWith(i % 2 ? 'AB' : 'A')));
            }
            if (entry === 'runFixByTargets') assert.equal(h.rendered(), 'AB');
            if (entry === 'runCondenseDepth') assert.equal(new Set(h.calls.map((c) => c.signal)).size, 1);
            if (entry !== 'generateReply') assert.equal(h.ctx.soLastFinishReason, 'previous');
            if (auto || entry === 'runAutoFix' || entry === 'runFixByTargets') assert.deepEqual(h.timers, Array(expected.length).fill(240000));
            if (entry === 'runForge') assert.deepEqual(h.timers, stream ? [180000, 180000, 180000] : [600000]);
            if (entry === 'runCondenseDepth') assert.deepEqual(h.timers, Array(13).fill(600000));
        }
    }
});

test('soCallModel 保留显式 null、无回调仍流式、token 原值及吞回调异常', async () => {
    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const temperature of [false, true])
        for (const choice of [undefined, null, false, true]) for (const callback of ['none', 'collect', 'throw']) {
            const s = sendSettings(mode, stream, temperature), h = sendHarness(s), updates = [];
            const signal = new AbortController().signal;
            const opts = { signal, stream: choice, maxTokens: 512 };
            if (callback !== 'none') opts.onDelta = (text) => { updates.push(text); if (callback === 'throw') throw new Error('callback'); };
            assert.equal(await h.ctx.soCallModel(h.messages, opts), 'AB');
            const useStream = choice === undefined ? stream : !!choice;
            checkCaptured(h, s, [h.messages], 512, useStream);
            assert.equal(h.calls[0].signal, signal);
            assert.deepEqual(updates, useStream && callback !== 'none' ? ['A', 'AB'] : []);
            assert.equal(h.ctx.soLastFinishReason, 'previous');
        }
});

test('校正传输保留回调异常的拒绝语义', async () => {
    for (const mode of ['direct', 'profile']) {
        const s = sendSettings(mode, true, false), h = sendHarness(s), updates = [];
        await assert.rejects(h.ctx.fixCallTransport(s, h.messages, new AbortController().signal, (text) => {
            updates.push(text); throw new Error('callback');
        }), /callback/);
        assert.deepEqual(updates, ['A']);
        assert.equal(h.calls.length, 1);
    }
});

test('校正入口假计时器：240 秒超时、停止键、后台中断和异常均释放控制器', async () => {
    for (const mode of ['direct', 'profile']) for (const entry of ['runFixByTargets', 'runAutoFix'])
        for (const action of ['timeout', 'cancel', 'failure']) {
            const s = sendSettings(mode, true, true);
            const h = sendHarness(s, { hold: action !== 'failure', failure: action === 'failure' ? new Error('transport failed') : undefined });
            const pending = h.ctx[entry](h.ctx.getCtx(), s, 0);
            // 等待函数走到假传输；每轮有上界，漏发请求时直接失败。
            for (let i = 0; i < 40 && !h.calls.length; i++) await Promise.resolve();
            assert.equal(h.calls.length, 1);
            const signal = h.calls[0].signal;
            assert.deepEqual(h.timers, [240000]);
            if (action === 'timeout') [...h.activeTimers.values()][0]();
            if (action === 'cancel') h.ctx[entry === 'runAutoFix' ? 'cancelPostReply' : 'stopGeneration']();
            if (entry === 'runAutoFix') await assert.rejects(pending, action === 'failure' ? /transport failed/ : { name: 'AbortError' });
            else { await pending; assert.equal(h.ui.textContent, action === 'failure' ? '校正失败：transport failed' : '(已停止)'); }
            assert.equal(signal.aborted, action !== 'failure');
            assert.equal(h.activeTimers.size, 0);
            assert.equal(h.ctx.abortCtl, null);
            assert.equal(h.ctx.postReplyAbortCtl, null);
            assert.equal(h.ctx.isGenerating, false);
            if (entry === 'runAutoFix') assert.equal(h.ctx.postReplyCancelled, action === 'cancel');
        }
});

test('条目序列化固定值：null、空 Set、乱序、字符串 uid；诊断另做数字过滤', () => {
    const names = ['serializeBldEntrySel', 'serializeLbEntrySel', 'serializeDiagSel'].filter((name) => source.includes(`function ${name}(`));
    if (/function serializeEntrySel\(/.test(source)) names.push('serializeEntrySel');
    const ctx = { Set };
    assert.ok(names.some((name) => name !== 'serializeDiagSel'), '应包含工坊 / 世界书的序列化函数');
    vm.runInNewContext(functions(names), ctx);
    const input = { all: null, empty: new Set(), mixed: new Set([8, '3', 1]), invalid: ['9'] };
    for (const name of names.filter((n) => n !== 'serializeDiagSel')) {
        assert.deepEqual(structuredClone(ctx[name](null)), {});
        assert.deepEqual(structuredClone(ctx[name](input)), { empty: [], mixed: [1, '3', 8] });
    }
    assert.deepEqual(structuredClone(ctx.serializeDiagSel({ ...input, numbers: new Set(['5', 'bad', 2, Infinity]) })), {
        empty: [], mixed: [1, 3, 8], numbers: [2, 5],
    });
});

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

// —— 剧情脉络（2.5.0）——
function pathCtx(settings = {}) {
    const speeds = source.match(/const ADVISOR_SPEEDS = \{[\s\S]*?\n\};/)?.[0];
    assert.ok(speeds, '找不到 ADVISOR_SPEEDS');
    const ctx = { getSettings: () => settings, getCtx: () => ({ substituteParams: (x) => x }) };
    const varRe = source.match(/const PROMPT_VAR_RE = .*;/)?.[0];
    assert.ok(varRe, '找不到 PROMPT_VAR_RE');
    vm.runInNewContext(speeds + '\n' + varRe + '\n' + functions([
        'renderPromptTemplate', 'pathSpeedKey', 'speedPaceLine', 'pathIsMulti', 'pathActiveNode', 'pathProgressLabel',
        'pathNodeNeedsDetail', 'nodeTargetText', 'pathInjectionText', 'pathNodeFrom', 'buildPath', 'pathAdvance',
        'pathSkipNode', 'pathSpliceTail', 'pathHasUnplayed', 'parseStoryPlanBlock', 'parseStoryPlans',
    ]) + '\nglobalThis.ADVISOR_SPEEDS = ADVISOR_SPEEDS;', ctx);
    // 注入用的几条提示词按注册表里的内置文本渲染
    const defs = {};
    for (const id of ['inject.path', 'inject.current', 'inject.paceLine', 'inject.speed.slow', 'inject.speed.normal', 'inject.speed.fast']) {
        const at = source.indexOf(`{ id: '${id}'`);
        assert.ok(at >= 0, '找不到提示词 ' + id);
        const rest = source.slice(at);
        const end = Math.min(...["\n    { id: '", '\n\n'].map((m) => { const i = rest.indexOf(m, 1); return i < 0 ? Infinity : i; }));
        defs[id] = vm.runInNewContext('(' + rest.slice(0, end).replace(/,\s*$/, '') + ')', ctx);
    }
    ctx.P = (id, vars) => (vars ? ctx.renderPromptTemplate(defs[id].builtin, vars) : defs[id].builtin);
    return ctx;
}
const PATH_BLOCK = `讨论到这里，排一下：
<StoryPlan>
标题：出城
整体目标：苏哲和薇拉离开王都，在城外落脚
1. 薇拉请缨：主动、收拾行囊、同行
   详细：薇拉默默收拾行囊。
   到这个节点结束时，两人已经决定同行。
2. 城门盘查：卫兵、盘查、蒙混过关
   详细：两人在北门被拦下。
3. 林中扎营：天黑、扎营、守夜
</StoryPlan>`;

test('剧情脉络：解析多节点 / 单节点 / 截断尾块，旧序列格式不再认', () => {
    const ctx = pathCtx();
    const [multi] = ctx.parseStoryPlans(PATH_BLOCK);
    assert.deepEqual(structuredClone(multi), {
        title: '出城', overall: '苏哲和薇拉离开王都，在城外落脚',
        nodes: [
            { name: '薇拉请缨', keywords: '主动、收拾行囊、同行', detail: '薇拉默默收拾行囊。\n到这个节点结束时，两人已经决定同行。' },
            { name: '城门盘查', keywords: '卫兵、盘查、蒙混过关', detail: '两人在北门被拦下。' },
            { name: '林中扎营', keywords: '天黑、扎营、守夜', detail: '' },
        ],
    });
    const singles = ctx.parseStoryPlans('两个方向：\n<StoryPlan>\n标题：匿名信\n目标：门缝里塞进一封信。\n信里写着交接时间。\n</StoryPlan>\n<story_plan>\ntitle: 旧识来访\ngoal: 老管家深夜登门。\n</story_plan>');
    assert.deepEqual(structuredClone(singles), [
        { title: '匿名信', overall: '', nodes: [{ name: '匿名信', keywords: '', detail: '门缝里塞进一封信。\n信里写着交接时间。' }] },
        { title: '旧识来访', overall: '', nodes: [{ name: '旧识来访', keywords: '', detail: '老管家深夜登门。' }] },
    ]);
    const cut = ctx.parseStoryPlans('<StoryPlan>\n标题：出城\n1. 请缨：同行\n   详细：她收拾行囊\n2. 盘查');
    assert.equal(cut.length, 1);
    assert.deepEqual(structuredClone(cut[0].nodes.map((n) => n.name)), ['请缨', '盘查']);
    assert.equal(ctx.parseStoryPlans('<StorySequence>\ntitle: 旧\nbeat: 第一拍\ngoal: x\n</StorySequence>').length, 0);
    assert.equal(ctx.parseStoryPlans('<StoryPlan>\n只是一段话\n</StoryPlan>').length, 0);
});

test('剧情脉络：完成推进、跳过、用新卡替换剩下的部分', () => {
    const ctx = pathCtx();
    const [plan] = ctx.parseStoryPlans(PATH_BLOCK);
    const path = ctx.buildPath(plan, 'fast', 10);
    assert.equal(path.speed, 'fast');
    assert.deepEqual(structuredClone(path.nodes.map((n) => n.status)), ['active', 'pending', 'pending']);
    const r = ctx.pathAdvance(path, 15);
    assert.equal(r.ended, false);
    assert.equal(r.node.name, '城门盘查');
    assert.equal(path.cursor, 1);
    assert.equal(path.nodeStartAt, 15);
    assert.equal(ctx.pathSkipNode(path, 2), false, '当前节点不能跳过');
    assert.equal(ctx.pathSkipNode(path, 3), true);
    // 替换剩下的部分：已完成的留着，id 续号
    ctx.pathSpliceTail(path, { title: '', overall: '换个走法', nodes: [{ name: '翻墙', keywords: '夜里', detail: '' }, { name: '出海', keywords: '', detail: '' }] }, 20);
    assert.deepEqual(structuredClone(path.nodes.map((n) => `${n.id}:${n.name}:${n.status}`)),['1:薇拉请缨:done', '4:翻墙:active', '5:出海:pending']);
    assert.equal(path.title, '出城');
    assert.equal(path.overall, '换个走法');
    assert.equal(ctx.pathAdvance(path, 30).node.name, '出海');
    assert.equal(ctx.pathAdvance(path, 40).ended, true);
    assert.equal(ctx.pathHasUnplayed(path), false);
});

test('剧情脉络：注入按 整体目标 / 已完成 / 当前目标 / 后续 排列；单节点只有目标', () => {
    const ctx = pathCtx();
    const [plan] = ctx.parseStoryPlans(PATH_BLOCK);
    const path = ctx.buildPath(plan, 'normal', 0);
    ctx.pathAdvance(path, 5);
    const lines = ctx.pathInjectionText(path).split('\n');
    assert.equal(lines[0], '<剧情导向>');
    assert.doesNotMatch(lines[1], /user|希望/);
    assert.deepEqual(lines.slice(2), [
        '整体目标：苏哲和薇拉离开王都，在城外落脚',
        '已完成：薇拉请缨',
        '当前目标（节点 2/3 · 城门盘查）：',
        '两人在北门被拦下。',
        '后续节点（只用来把握方向；当前目标达成之前，严禁写到这些情节）：林中扎营——天黑、扎营、守夜',
        '节奏：' + ctx.ADVISOR_SPEEDS.normal.directive,
        '</剧情导向>',
    ]);
    // 走到最后一个节点：它没写详细，先按节点名 + 关键词；没有后续那一行
    ctx.pathAdvance(path, 9);
    const last = ctx.pathInjectionText(path);
    assert.match(last, /当前目标（节点 3\/3 · 林中扎营）：\n林中扎营——天黑、扎营、守夜\n节奏：/);
    assert.doesNotMatch(last, /后续/);
    assert.match(last, /已完成：薇拉请缨、城门盘查/);
    // 单节点：只有「目标：」，没有整体目标 / 已完成 / 后续
    const [single] = ctx.parseStoryPlans('<StoryPlan>\n标题：匿名信\n目标：门缝里塞进一封信。\n</StoryPlan>');
    const one = ctx.pathInjectionText(ctx.buildPath(single, 'slow', 0)).split('\n');
    assert.deepEqual(one.slice(2), ['目标：', '门缝里塞进一封信。', '节奏：' + ctx.ADVISOR_SPEEDS.slow.directive, '</剧情导向>']);
    // 暂停不在这里判断（applyPlanInjection 负责），没有当前节点时为空
    path.nodes[path.cursor].status = 'done';
    assert.equal(ctx.pathInjectionText(path), '');
});

test('非流式回复外面多包一层 data 时也能取到正文（cline 中转实测）', async () => {
    const wrapped = { data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '<NodeDetail>\n写好了\n</NodeDetail>' } }] } };
    const ctx = transport(new Response(JSON.stringify(wrapped), { headers: { 'content-type': 'application/json' } }));
    assert.equal(await ctx.callDirect('mock', '', {}, undefined), '<NodeDetail>\n写好了\n</NodeDetail>');
    assert.equal(ctx.soLastFinishReason, 'stop');
    // 流式请求却回了普通 JSON（同样包一层）
    const ctx2 = transport(new Response(JSON.stringify(wrapped)));
    assert.equal((await read(ctx2)).text, '<NodeDetail>\n写好了\n</NodeDetail>');
    // 正常的不包一层照旧
    const ctx3 = transport(new Response(JSON.stringify(wrapped.data)));
    assert.equal(await ctx3.callDirect('mock', '', {}, undefined), '<NodeDetail>\n写好了\n</NodeDetail>');
});
