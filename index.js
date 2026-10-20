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
import { extension_settings } from '../../../extensions.js';
import { getPreviewString, registerTtsProvider } from '../../tts/index.js';

const PROVIDER_NAME = 'Fish Audio';
const MODULE_NAME = 'fish-audio-tts';

const ENDPOINT = 'https://api.fish.audio/v1/tts';
const DEFAULT_VOICE = '6ce7ea8ada884bf3889fa7c7fb206691';

const defaultSettings = {
    apiKey: '',
    model: 's2.1-pro-free',
    referenceId: DEFAULT_VOICE,
    format: 'mp3',
    latency: 'normal',
    useProxy: true,
    available_voices: [],
};

export class FishAudioTtsProvider {
    settings = {};
    voices = [];
    separator = ' . ';

    audioElement = new Audio();

    constructor() {
        this.handler = (key) => {
            if (key !== 'api_key_fish_audio_tts') {
                return;
            }
            this.renderVoiceState();
        };
        eventSource.on(event_types.SECRET_WRITTEN, this.handler);
        eventSource.on(event_types.SECRET_DELETED, this.handler);
    }

    get apiKey() {
        return String(this.settings.apiKey || '').trim();
    }

    get settingsHtml() {
        return `
        <div class="fish-tts-settings">
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
        this.settings = { ...defaultSettings };
        for (const key in settings) {
            if (key in this.settings) {
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
        this.settings.apiKey = String($('#fish_tts_api_key').val() || '').trim();
        this.settings.model = String($('#fish_tts_model').val() || '').trim();
        this.settings.referenceId = String($('#fish_tts_reference').val() || '').trim();
        this.settings.useProxy = Boolean($('#fish_tts_proxy').prop('checked'));
        this.renderVoiceState();
        saveSettingsDebounced();
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

    async generateTts(text, voiceId) {
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

jQuery(async () => {
    // 官方 TTS 扩展没启用时，registerTtsProvider 不可用，这里只报一次提示，不抛错。
    try {
        registerTtsProvider(PROVIDER_NAME, FishAudioTtsProvider);
        extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
        console.log('[Fish Audio] provider registered');
    } catch (error) {
        console.error('[Fish Audio] 注册失败，请确认 TTS 扩展已启用', error);
    }
});
