/**
 * Fish Audio TTS —— 把 Fish Audio 接成 SillyTavern 的配音渠道。
 *
 * 为什么不能直接用官方的 "OpenAI Compatible"：Fish Audio 走的是
 * /v1/tts（字段 text + reference_id），而且免费额度必须把模型名
 * 放在**请求头** model 里，放 body 会 402 余额不足。
 *
 * 另外 Fish Audio 不返回 CORS 头，所以统一走 SillyTavern 的 /proxy/。
 * 前提：config.yaml 里 enableCorsProxy: true。
 */

import { event_types, eventSource, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { getPreviewString, getCharacters, initVoiceMap, registerTtsProvider } from '../../tts/index.js';

const DEFAULT_VOICE_MARKER = '[Default Voice]';
const DISABLED_VOICE_MARKER = 'disabled';

const PROVIDER_NAME = 'Fish Audio';
const MODULE_NAME = 'fish-audio-tts';
const FOLDER_NAME = 'st-fishaudio-tts';

const ENDPOINT = 'https://api.fish.audio/v1/tts';
const DEFAULT_VOICE = '6ce7ea8ada884bf3889fa7c7fb206691';

// 面板上的自检计数，用来证明"没有多余请求"。
const runtimeStats = { requests: 0, skipped: 0, lastTexts: [] };

const QUOTE_SUFFIX = '("Quotes")';
const ACTION_SUFFIX = '(*Text inside asterisks*)';
const OTHER_SUFFIX = '(Other text)';

/**
 * 一段 120ms 的静音 WAV。
 *
 * ST 在"这个角色的这段不该念"时本来会自己跳过，但不同版本/配置下未必走到那一步。
 * 这里在真正发 HTTP 之前再挡一道：不该念的段落返回静音，
 * 保证一个字节的请求都不会发出去，也不占 Fish Audio 的额度。
 */
function silentWav(durationMs = 120) {
    const rate = 24000;
    const samples = Math.floor((rate * durationMs) / 1000);
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples * 2, true);
    return new Blob([buffer], { type: 'audio/wav' });
}

/** 这个段落在当前设置下该不该念。 */
function shouldSkipSegment(voiceMapKey) {
    if (!voiceMapKey) {
        return false;
    }
    const map = extension_settings.tts?.[PROVIDER_NAME]?.voiceMap;
    if (!map) {
        return false;
    }
    if (!voiceMapKey.endsWith(QUOTE_SUFFIX) && !voiceMapKey.endsWith(ACTION_SUFFIX) && !voiceMapKey.endsWith(OTHER_SUFFIX)) {
        return false;
    }
    return map[voiceMapKey] === DISABLED_VOICE_MARKER;
}

const defaultSettings = {
    apiKey: '',
    model: 's2.1-pro-free',
    referenceId: DEFAULT_VOICE,
    format: 'mp3',
    latency: 'normal',
    useProxy: true,
    available_voices: [],
};

/** 面板与 provider 共用同一份设置，避免两处各存一份对不上。 */
function moduleSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const store = extension_settings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (store[key] === undefined) {
            store[key] = defaultSettings[key];
        }
    }
    return store;
}

export class FishAudioTtsProvider {
    settings = {};
    voices = [];
    separator = ' . ';

    audioElement = new Audio();

    constructor() {
        this.handler = () => this.renderVoiceState();
        eventSource.on(event_types.SECRET_WRITTEN, this.handler);
        eventSource.on(event_types.SECRET_DELETED, this.handler);
    }

    get apiKey() {
        return String(this.settings.apiKey || '').trim();
    }

    get settingsHtml() {
        return `
        <div class="fish-tts-settings">
            <p class="fish-tts-hint">
                完整设置已放在「扩展」→ <b>Fish Audio TTS（配音）</b> 面板里，
                这里只是同一份设置的镜像。建议统一在那个面板里改。
            </p>

            <label for="fish_tts_api_key">Fish Audio 密钥</label>
            <input id="fish_tts_api_key" type="password" class="text_pole" placeholder="粘贴 API Key" />

            <label for="fish_tts_model">模型</label>
            <input id="fish_tts_model" type="text" class="text_pole" placeholder="s2.1-pro-free" />

            <label for="fish_tts_reference">默认声音 ID（reference_id）</label>
            <input id="fish_tts_reference" type="text" class="text_pole" placeholder="${DEFAULT_VOICE}" />

            <label class="checkbox_label" for="fish_tts_proxy">
                <input id="fish_tts_proxy" type="checkbox" />
                <span>走 SillyTavern 代理（不勾选会因跨域失败）</span>
            </label>

            <div class="flex-container">
                <div id="fish_tts_load_voices" class="menu_button">读取我的声音列表</div>
                <div id="fish_tts_state" class="fish-tts-state"></div>
            </div>

            <p class="fish-tts-hint">
                免费额度对应的模型是 <code>s2.1-pro-free</code>；它必须放在请求头里，本扩展已处理。
            </p>
        </div>`;
    }

    dispose() {
        eventSource.removeListener(event_types.SECRET_WRITTEN, this.handler);
        eventSource.removeListener(event_types.SECRET_DELETED, this.handler);
        this.audioElement.pause();
    }

    async loadSettings(settings) {
        // 以面板里的设置为准，TTS 扩展传进来的只用来兜底。
        this.settings = { ...defaultSettings, ...moduleSettings() };
        for (const key in settings) {
            if (key in defaultSettings && this.settings[key] === undefined) {
                this.settings[key] = settings[key];
            }
        }

        $('#fish_tts_api_key').val(this.apiKey);
        $('#fish_tts_api_key').on('input', () => this.onSettingsChange());
        $('#fish_tts_model').val(this.settings.model);
        $('#fish_tts_model').on('input', () => this.onSettingsChange());
        $('#fish_tts_reference').val(this.settings.referenceId);
        $('#fish_tts_reference').on('input', () => this.onSettingsChange());
        $('#fish_tts_proxy').prop('checked', this.settings.useProxy);
        $('#fish_tts_proxy').on('change', () => this.onSettingsChange());
        $('#fish_tts_load_voices').on('click', () => this.onRefreshClick());

        this.renderVoiceState();
        await this.checkReady();
    }

    onSettingsChange() {
        const store = moduleSettings();
        store.apiKey = String($('#fish_tts_api_key').val() || '').trim();
        store.model = String($('#fish_tts_model').val() || '').trim();
        store.referenceId = String($('#fish_tts_reference').val() || '').trim();
        store.useProxy = Boolean($('#fish_tts_proxy').prop('checked'));
        Object.assign(this.settings, {
            apiKey: store.apiKey,
            model: store.model,
            referenceId: store.referenceId,
            useProxy: store.useProxy,
        });
        this.renderVoiceState();
        saveSettingsDebounced();
        syncPanelFromStore();
    }

    renderVoiceState() {
        const ok = Boolean(this.apiKey);
        $('#fish_tts_state')
            .text(ok ? '已填密钥' : '未填密钥')
            .css('color', ok ? 'inherit' : 'red');
    }

    async checkReady() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        try {
            const mine = await this.fetchMyVoices();
            this.voices = mine.length ? mine : await this.fetchTtsVoiceObjects();
            toastr.success(`读取到 ${mine.length} 个声音`, PROVIDER_NAME);
        } catch (error) {
            console.error('[Fish Audio]', error);
            toastr.error(String(error.message || error), PROVIDER_NAME);
        }
    }

    /** 内置一个默认声音，保证即使没联网也有可选项。 */
    async fetchTtsVoiceObjects() {
        const configured = String(this.settings.referenceId || '').trim();
        const voices = [];
        if (configured) {
            voices.push({ name: configured, voice_id: configured, lang: 'zh-CN' });
        }
        for (const entry of this.settings.available_voices || []) {
            if (entry.voice_id !== configured) {
                voices.push(entry);
            }
        }
        return voices;
    }

    /** 拉取账号下的声音（如果该 key 有权限）。 */
    async fetchMyVoices() {
        const url = this.settings.useProxy
            ? '/proxy/https://api.fish.audio/model?page_size=50'
            : 'https://api.fish.audio/model?page_size=50';
        const response = await fetch(url, {
            method: 'GET',
            headers: { ...getRequestHeaders(), Authorization: `Bearer ${this.apiKey}` },
        });
        if (!response.ok) {
            throw new Error(`读取声音列表失败：HTTP ${response.status}`);
        }
        const data = await response.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        const voices = items.map(item => ({
            name: item.title || item._id,
            voice_id: item._id,
            lang: 'zh-CN',
        }));
        moduleSettings().available_voices = voices;
        this.settings.available_voices = voices;
        saveSettingsDebounced();
        return voices;
    }

    async getVoice(voiceName) {
        if (!this.voices.length) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName || v.voice_id === voiceName);
        if (!match) {
            throw new Error(`找不到声音：${voiceName}`);
        }
        return match;
    }

    async generateTts(text, voiceId, voiceMapKey) {
        // 不在"该念"名单里的段落，一个请求都不发，直接给静音。
        const silent = shouldSkipSegment(voiceMapKey);
        runtimeStats.requests += silent ? 0 : 1;
        runtimeStats.skipped += silent ? 1 : 0;
        runtimeStats.lastTexts.unshift({ text: String(text || '').slice(0, 40), skipped: silent, key: String(voiceMapKey || '').slice(0, 60) });
        runtimeStats.lastTexts = runtimeStats.lastTexts.slice(0, 8);

        if (silent) {
            console.log('[Fish Audio] 跳过不该念的段落：' + String(text || '').slice(0, 40));
            return silentWav();
        }
        return this.fetchTtsGeneration(text, voiceId);
    }

    async previewTtsVoice(voiceId) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
        const response = await this.fetchTtsGeneration(getPreviewString('zh-CN'), voiceId);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        this.audioElement.src = url;
        this.audioElement.play();
        this.audioElement.onended = () => URL.revokeObjectURL(url);
    }

    async fetchTtsGeneration(text, voiceId) {
        if (!this.apiKey) {
            throw new Error('还没填 Fish Audio 密钥');
        }

        const reference = String(voiceId || this.settings.referenceId || '').trim();
        if (!reference) {
            throw new Error('没有指定声音 ID');
        }

        const endpoint = this.settings.useProxy ? `/proxy/${ENDPOINT}` : ENDPOINT;
        const headers = {
            ...getRequestHeaders(),
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
        };
        // 免费模型必须走请求头，放 body 会 402。
        const model = String(this.settings.model || '').trim();
        if (model) {
            headers['model'] = model;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                text: String(text || ''),
                reference_id: reference,
                format: this.settings.format || 'mp3',
                latency: this.settings.latency || 'normal',
            }),
        });

        if (!response.ok) {
            const detail = await response.text();
            toastr.error(`HTTP ${response.status}`, 'TTS 生成失败');
            throw new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`);
        }

        // SillyTavern 的 /proxy/ 不会转发上游的 Content-Type，
        // 而 TTS 扩展要求 blob.type 以 audio/ 开头，否则直接抛错。
        // 所以这里重新包一层，把类型显式补上。
        const audio = await response.arrayBuffer();
        const format = String(this.settings.format || 'mp3').toLowerCase();
        const mime = format === 'wav' ? 'audio/wav' : format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
        return new Response(audio, {
            status: 200,
            headers: { 'Content-Type': mime },
        });
    }
}

// 独立面板 -------------------------------------------------------------
// 之前只有一个挂在 TTS 里的 provider 设置，装完在扩展列表里看不到任何东西，
// 所以这里补一个真正的扩展面板，把配置和自检都放进来。

/**
 * TTS 扩展会给每个新渠道把 [Default Voice] 默认设成 disabled（防止装完就乱念），
 * 所以装好后点朗读一声不响 —— 而面板里的「测试配音」是直连接口，照样出声，
 * 看起来像"面板好使、真朗读不行"。这里在启用时把声音接回去。
 *
 * 同时把逐句朗读需要的三个分轨键补上：
 * ST 的 multi_voice 会把一句话拆成 对话 / 动作 / 旁白 三类，
 * 分别用 `${角色} ("Quotes")`、`${角色} (*Text inside asterisks*)`、`${角色} (Other text)` 查声音，
 * 缺键就直接抛 "not in voicemap"。这和 dsh 那边的「beats」是同一种切法。
 */
const SEGMENT_SUFFIXES = ['("Quotes")', '(*Text inside asterisks*)', '(Other text)'];

async function ensureVoiceMapReady() {
    const tts = extension_settings.tts;
    if (!tts) {
        return;
    }
    const store = tts[PROVIDER_NAME] = tts[PROVIDER_NAME] || {};
    if (typeof store.voiceMap !== 'object' || !store.voiceMap) {
        store.voiceMap = {};
    }
    const map = store.voiceMap;
    const voice = String(moduleSettings().referenceId || DEFAULT_VOICE);
    let changed = false;

    if (!map[DEFAULT_VOICE_MARKER] || map[DEFAULT_VOICE_MARKER] === DISABLED_VOICE_MARKER) {
        map[DEFAULT_VOICE_MARKER] = voice;
        changed = true;
    }

    // 要补键的名字来源有三个：人物卡列表、当前对话双方、聊天里实际出现过的说话人。
    // 少一个就会在朗读时抛 "not in voicemap"，所以要尽量全覆盖。
    const context = getContext();
    const names = new Set();
    for (const name of getCharacters(true) || []) {
        names.add(name);
    }
    for (const name of [context.name1, context.name2]) {
        if (name) {
            names.add(name);
        }
    }
    for (const message of context.chat || []) {
        if (message?.name) {
            names.add(message.name);
        }
    }
    names.delete(DEFAULT_VOICE_MARKER);
    names.delete('SillyTavern System');

    for (const name of names) {
        for (const suffix of SEGMENT_SUFFIXES) {
            const key = `${name} ${suffix}`;
            if (!map[key]) {
                map[key] = DEFAULT_VOICE_MARKER;
                changed = true;
            }
        }
    }

    // 分段朗读这条路是直接拿消息名查表的，不像整段朗读那样把
    // "SillyTavern System" 归一到 [Default Voice]，所以它也要有自己的键。
    for (const suffix of SEGMENT_SUFFIXES) {
        const key = `SillyTavern System ${suffix}`;
        if (!map[key]) {
            map[key] = DEFAULT_VOICE_MARKER;
            changed = true;
        }
    }

    if (changed) {
        saveSettingsDebounced();
    }
    try {
        // 必须用 initVoiceMap(false)：它会按 multi_voice 把每个角色展开成
        // 对话 / 动作 / 旁白 三个键。用 true 只建平名的键，
        // 反而会把运行时的分段键冲掉，朗读时依旧报 "not in voicemap"。
        await initVoiceMap(false);
    } catch (error) {
        console.warn('[Fish Audio] 重建声音映射失败', error);
    }
    if (changed) {
        console.log('[Fish Audio] 已补齐声音映射');
    }
    return changed;
}

/** 打开逐句朗读：每行一段 + 对话/动作/旁白分开念。 */
function enableSentenceMode(on) {
    const tts = extension_settings.tts;
    if (!tts) {
        return;
    }
    tts.multi_voice_enabled = on;
    tts.narrate_by_paragraphs = on;
    $('#tts_multi_voice_enabled').prop('checked', on);
    $('#tts_narrate_by_paragraphs').prop('checked', on);
    saveSettingsDebounced();
}

function isSentenceMode() {
    const tts = extension_settings.tts || {};
    return Boolean(tts.multi_voice_enabled && tts.narrate_by_paragraphs);
}

// 逐角色朗读模式 -------------------------------------------------------
// 每个角色在 ST 里有三个映射键：引号对话 / 星号动作 / 其他文字。
// 把后两个设成 disabled，就只念这个角色的引号句子。

const CHAR_MODES = {
    all: '全部朗读',
    quotes: '只念引号句',
    off: '不朗读',
};

function quoteKey(name) {
    return `${name} ("Quotes")`;
}

function actionKey(name) {
    return `${name} (*Text inside asterisks*)`;
}

function otherKey(name) {
    return `${name} (Other text)`;
}

/** 当前聊天里需要出现在列表中的角色名。 */
function chatCharacterNames() {
    const context = getContext();
    const names = [];
    if (context.groupId !== null && context.groups) {
        const group = context.groups.find(item => item.id == context.groupId);
        for (const member of group?.members || []) {
            const character = (context.characters || []).find(item => item.avatar === member);
            if (character) {
                names.push(character.name);
            }
        }
    } else if (context.name2) {
        names.push(context.name2);
    }
    for (const message of context.chat || []) {
        if (message?.name && !message.is_user) {
            names.push(message.name);
        }
    }
    return [...new Set(names)].filter(name => name && name !== 'SillyTavern System' && name !== DEFAULT_VOICE_MARKER);
}

function characterMode(name) {
    const map = extension_settings.tts?.[PROVIDER_NAME]?.voiceMap || {};
    const quote = map[quoteKey(name)];
    const action = map[actionKey(name)];
    const other = map[otherKey(name)];
    const silent = value => !value || value === DISABLED_VOICE_MARKER;
    if (silent(quote) && silent(action) && silent(other)) {
        return 'off';
    }
    if (!silent(quote) && silent(action) && silent(other)) {
        return 'quotes';
    }
    return 'all';
}

/** 把某个角色设成 全部朗读 / 只念引号句 / 不朗读。 */
async function setCharacterMode(name, mode) {
    const store = extension_settings.tts[PROVIDER_NAME] = extension_settings.tts[PROVIDER_NAME] || {};
    store.voiceMap = store.voiceMap || {};
    const map = store.voiceMap;
    const on = DEFAULT_VOICE_MARKER;
    const off = DISABLED_VOICE_MARKER;

    if (mode === 'off') {
        map[quoteKey(name)] = off;
        map[actionKey(name)] = off;
        map[otherKey(name)] = off;
    } else if (mode === 'quotes') {
        map[quoteKey(name)] = on;
        map[actionKey(name)] = off;
        map[otherKey(name)] = off;
    } else {
        map[quoteKey(name)] = on;
        map[actionKey(name)] = on;
        map[otherKey(name)] = on;
        if (!map[name]) {
            map[name] = on;
        }
    }

    // 没开逐句朗读的话，上面这些分轨键根本不会被查，等于白设。
    if (mode !== 'all') {
        enableSentenceMode(true);
        $('#fish_panel_sentences').prop('checked', true);
    }

    saveSettingsDebounced();
    // 必须重建运行时表：ST 的朗读查的是模块内部的 voiceMap，
    // 只改 extension_settings 要等下次刷新才生效。
    // initVoiceMap(false) 会用上面写好的值重建它，且不会丢 disabled。
    try {
        await initVoiceMap(false);
    } catch (error) {
        console.warn('[Fish Audio] 重建声音映射失败', error);
    }
    renderCharacterModes();
    renderPanelStatus();
}

function renderCharacterModes() {
    const host = $('#fish_panel_char_modes');
    if (!host.length) {
        return;
    }
    const names = chatCharacterNames();
    if (!names.length) {
        host.html('<div class="fish-tts-hint">当前聊天里还没有角色。先选一张人物卡或打开一个对话。</div>');
        return;
    }
    host.empty();
    for (const name of names) {
        const current = characterMode(name);
        const options = Object.entries(CHAR_MODES)
            .map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`)
            .join('');
        const row = $(`<div class="fish-tts-char-row"><span class="fish-tts-char-name"></span><select class="text_pole fish-tts-char-select">${options}</select></div>`);
        row.find('.fish-tts-char-name').text(name);
        row.find('select').on('change', async (event) => {
            await setCharacterMode(name, event.currentTarget.value);
        });
        host.append(row);
    }
}

function syncPanelFromStore() {
    const s = moduleSettings();
    $('#fish_panel_api_key').val(s.apiKey || '');
    $('#fish_panel_model').val(s.model || defaultSettings.model);
    $('#fish_panel_reference').val(s.referenceId || '');
    $('#fish_panel_proxy').prop('checked', s.useProxy !== false);
    $('#fish_panel_sentences').prop('checked', isSentenceMode());
    renderPanelStatus();
    renderCharacterModes();
}

function renderPanelStatus() {
    const s = moduleSettings();
    const hasKey = Boolean(String(s.apiKey || '').trim());
    const ttsReady = typeof registerTtsProvider === 'function';
    const currentProvider = $('#tts_provider').val();
    const ttsEnabled = $('#tts_enabled').prop('checked');
    const sentence = isSentenceMode();

    $('#fish_panel_status').html([
        `密钥：<b style="color:${hasKey ? 'inherit' : 'red'}">${hasKey ? '已填' : '未填'}</b>`,
        `TTS 扩展：<b style="color:${ttsReady ? 'inherit' : 'red'}">${ttsReady ? '已启用' : '未启用'}</b>`,
        `当前渠道：<b>${currentProvider || '未选'}</b>`,
        `TTS 总开关：<b>${ttsEnabled ? '已开' : '关'}</b>`,
        `逐句朗读：<b style="color:${sentence ? 'inherit' : 'red'}">${sentence ? '已开' : '关（整段念）'}</b>`,
    ].join(' ｜ '));

    $('#fish_panel_counter').html(
        `本次会话：发出 <b>${runtimeStats.requests}</b> 次合成请求，`
        + `在本地挡掉 <b>${runtimeStats.skipped}</b> 段不该念的内容`
        + (runtimeStats.lastTexts.length ? '<br><span style="opacity:.7">最近：</span>'
            + runtimeStats.lastTexts.map(item => `${item.skipped ? '🚫' : '🔊'} ${escapeHtml(item.text)}`).join(' ｜ ')
            : ''),
    );
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

function bindPanel() {
    $('#fish_panel_api_key').on('input', () => {
        moduleSettings().apiKey = String($('#fish_panel_api_key').val() || '').trim();
        saveSettingsDebounced();
        renderPanelStatus();
    });
    $('#fish_panel_model').on('input', () => {
        moduleSettings().model = String($('#fish_panel_model').val() || '').trim();
        saveSettingsDebounced();
    });
    $('#fish_panel_reference').on('input', () => {
        moduleSettings().referenceId = String($('#fish_panel_reference').val() || '').trim();
        saveSettingsDebounced();
    });
    $('#fish_panel_proxy').on('change', () => {
        moduleSettings().useProxy = Boolean($('#fish_panel_proxy').prop('checked'));
        saveSettingsDebounced();
    });

    // 一键选中渠道 + 打开总开关 + 打开逐句朗读 + 补齐声音映射
    $('#fish_panel_activate').on('click', async () => {
        const select = $('#tts_provider');
        const exists = select.find('option').filter((_, o) => o.value === PROVIDER_NAME).length > 0;
        if (!exists) {
            toastr.error('TTS 扩展里找不到 Fish Audio 渠道，请确认官方 TTS 扩展已启用后刷新页面', PROVIDER_NAME);
            return;
        }
        select.val(PROVIDER_NAME).trigger('change');
        const enabled = $('#tts_enabled');
        if (enabled.length && !enabled.prop('checked')) {
            enabled.trigger('click');
        }
        enableSentenceMode(true);
        await ensureVoiceMapReady();
        syncPanelFromStore();
        toastr.success('已切到 Fish Audio、打开总开关和逐句朗读', PROVIDER_NAME);
    });

    // 只修声音映射：用户自己配过角色的声音，不想被上面那个按钮覆盖时用
    $('#fish_panel_fix_voices').on('click', async () => {
        const changed = await ensureVoiceMapReady();
        syncPanelFromStore();
        toastr[changed ? 'success' : 'info'](changed ? '已补齐缺的声音映射' : '声音映射本来就完整', PROVIDER_NAME);
    });

    $('#fish_panel_sentences').on('change', () => {
        enableSentenceMode(Boolean($('#fish_panel_sentences').prop('checked')));
        renderPanelStatus();
    });

    $('#fish_panel_load_voices').on('click', async () => {
        const provider = new FishAudioTtsProvider();
        provider.settings = { ...defaultSettings, ...moduleSettings() };
        try {
            const voices = await provider.fetchMyVoices();
            $('#fish_panel_voice_count').text(`已读取 ${voices.length} 个声音`);
            toastr.success(`读取到 ${voices.length} 个声音`, PROVIDER_NAME);
        } catch (error) {
            toastr.error(String(error.message || error), PROVIDER_NAME);
        }
    });

    $('#fish_panel_test').on('click', async () => {
        const provider = new FishAudioTtsProvider();
        provider.settings = { ...defaultSettings, ...moduleSettings() };
        const toast = toastr.info('正在合成测试语音…', PROVIDER_NAME, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
        try {
            const response = await provider.fetchTtsGeneration('这是一句 Fish Audio 配音测试。', provider.settings.referenceId);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const audio = document.getElementById('fish_panel_audio');
            audio.src = url;
            await audio.play().catch(() => { /* 浏览器可能拦自动播放，不影响链路验证 */ });
            $('#fish_panel_result').text(`合成成功：${Math.round(blob.size / 1024)} KB`);
            toastr.success('配音链路正常', PROVIDER_NAME);
        } catch (error) {
            $('#fish_panel_result').text(`失败：${error.message || error}`);
            toastr.error(String(error.message || error), PROVIDER_NAME, { timeOut: 10000 });
        } finally {
            if (toast?.length) toastr.clear(toast);
        }
    });
}

/**
 * TTS 扩展是在页面加载早期就读 `extension_settings.tts.currentProvider` 的。
 * 如果那时我们的渠道还没注册，它会找不到这个渠道、把下拉框回落到第一个选项，
 * 于是存好的选择看起来"丢了"。注册完成后要主动把它接回去。
 */
function restoreProviderSelection() {
    const tts = extension_settings.tts;
    if (!tts || tts.currentProvider !== PROVIDER_NAME) {
        return;
    }
    const select = $('#tts_provider');
    const exists = select.find('option').filter((_, o) => o.value === PROVIDER_NAME).length > 0;
    if (!exists || select.val() === PROVIDER_NAME) {
        return;
    }
    select.val(PROVIDER_NAME).trigger('change');
    console.log('[Fish Audio] 已恢复上次选中的渠道');
}

jQuery(async () => {
    const store = moduleSettings();

    try {
        registerTtsProvider(PROVIDER_NAME, FishAudioTtsProvider);
        console.log('[Fish Audio] provider registered');
    } catch (error) {
        // 官方 TTS 扩展没启用，或已经注册过（重复导入），不阻断面板显示。
        console.warn('[Fish Audio] provider 注册跳过', error?.message || error);
    }

    try {
        const html = await renderExtensionTemplateAsync('third-party/' + FOLDER_NAME, 'settings');
        $('#extensions_settings2').append(html);
        syncPanelFromStore();
        bindPanel();

        // TTS 面板可能比扩展晚渲染，稍后刷新一次状态
        setTimeout(() => { restoreProviderSelection(); renderPanelStatus(); }, 800);
        setTimeout(() => { restoreProviderSelection(); renderPanelStatus(); }, 2500);
        eventSource.on(event_types.APP_READY, () => {
            setTimeout(() => { restoreProviderSelection(); renderPanelStatus(); }, 500);
        });
        // 换人物卡 / 换聊天后要重建角色列表，否则列表还停在旧会话上
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(() => { renderCharacterModes(); renderPanelStatus(); }, 800);
        });
        // 每念一段就刷新计数，方便当场确认有没有多余请求
        eventSource.on(event_types.TTS_JOB_STARTED, () => {
            setTimeout(renderPanelStatus, 0);
        });
    } catch (error) {
        console.error('[Fish Audio] 面板渲染失败', error);
        toastr.error(String(error.message || error), 'Fish Audio');
    }

    console.log('[Fish Audio] loaded', store.model);
});
