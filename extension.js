import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

// Rollout fallback data can only understate usage. Match waybar-ai-usage and
// call it stale after six hours; live App Server readings always have age 0.
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

let aiUsageMenu;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms) {
    let totalSeconds = Math.max(0, Math.floor(ms / 1000));
    let days = Math.floor(totalSeconds / 86400);
    let hours = Math.floor((totalSeconds % 86400) / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Providers
//
// Each provider implements fetch(soupSession, callback). The callback receives
// a normalized object:
//   { ok, error?, rateLimited?, short, long, extra, staleMs }
// where short/long are { pct, resetMs, label } | null (short = shorter window,
// long = longer window), extra is an optional detail string, and staleMs is how
// old the underlying data is (0 for a live pull).
// ---------------------------------------------------------------------------

class ClaudeProvider {
    constructor(extPath, settings) {
        this.id = 'claude';
        this.name = 'Claude';
        this.icon = 'claude-symbolic.svg';
        this._extPath = extPath;
        this._settings = settings;
        this._lastGood = null;
        this._blockedUntil = 0;
    }

    _token() {
        let manual = this._settings.get_string('session-key');
        if (manual && manual.length > 0) return manual;
        try {
            let file = Gio.File.new_for_path(CLAUDE_CREDS);
            let [ok, contents] = file.load_contents(null);
            if (ok) {
                let json = JSON.parse(new TextDecoder().decode(contents));
                let token = json?.claudeAiOauth?.accessToken;
                if (token) return token;
            }
        } catch (e) {
            // missing / unreadable
        }
        return null;
    }

    fetch(soupSession, callback) {
        if (Date.now() < this._blockedUntil) {
            callback(this._lastGood
                ? { ...this._lastGood, cached: true }
                : { ok: false, error: 'Rate limited' });
            return;
        }

        let token = this._token();
        if (!token) {
            callback({ ok: false, error: 'No token' });
            return;
        }

        let message = Soup.Message.new('GET', USAGE_API);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let status = message.status_code;
                if (status === 429) {
                    let retry = 60;
                    let hdr = message.response_headers.get_one('Retry-After');
                    if (hdr) {
                        let parsed = parseInt(hdr, 10);
                        if (!isNaN(parsed) && parsed > 0) retry = Math.min(parsed, 600);
                    }
                    this._blockedUntil = Date.now() + retry * 1000;
                    callback(this._lastGood
                        ? { ...this._lastGood, cached: true }
                        : { ok: false, error: 'Rate limited' });
                    return;
                }
                if (status === 401 || status === 403) {
                    callback(this._lastGood
                        ? { ...this._lastGood, cached: true }
                        : { ok: false, error: 'Auth — re-login to Claude Code' });
                    return;
                }
                if (status !== 200) {
                    callback(this._lastGood
                        ? { ...this._lastGood, cached: true }
                        : { ok: false, error: `HTTP ${status}` });
                    return;
                }
                let data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._lastGood = this._normalize(data);
                this._blockedUntil = 0;
                callback(this._lastGood);
            } catch (e) {
                logError(e, '[AI Usage] Claude fetch');
                callback(this._lastGood
                    ? { ...this._lastGood, cached: true }
                    : { ok: false, error: 'Offline' });
            }
        });
    }

    _normalize(data) {
        let mk = (w, label) => (w && w.utilization != null)
            ? { pct: w.utilization, resetMs: w.resets_at ? Date.parse(w.resets_at) : 0, label }
            : null;
        let short = mk(data.five_hour, '5h');
        let long = mk(data.seven_day, '7d');
        let extras = [];
        if (data.seven_day_sonnet?.utilization != null)
            extras.push(`Sonnet 7d: ${Math.round(data.seven_day_sonnet.utilization)}%`);
        if (data.seven_day_opus?.utilization != null)
            extras.push(`Opus 7d: ${Math.round(data.seven_day_opus.utilization)}%`);
        return { ok: true, short, long, extras, staleMs: 0 };
    }
}

class CodexProvider {
    constructor(extPath, settings) {
        this.id = 'codex';
        this.name = 'Codex';
        this.icon = 'openai-symbolic.svg';
        this._extPath = extPath;
        this._settings = settings;
        this._lastGood = null;
    }

    // Query Codex App Server asynchronously so the Shell main loop never
    // blocks. The helper retains canonical local rollout parsing as a legacy
    // fallback and returns the same normalized structure as ClaudeProvider.
    fetch(soupSession, callback) {
        let helper = GLib.build_filenamev([this._extPath, 'codex-usage-helper.py']);
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['python3', helper],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            callback(this._lastGood
                ? { ...this._lastGood, cached: true }
                : { ok: false, error: 'Cannot start Codex helper' });
            return;
        }

        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                let [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!stdout || !stdout.trim()) {
                    throw new Error(stderr?.trim() || 'No helper output');
                }
                let normalized = JSON.parse(stdout.trim().split('\n').pop());
                if (normalized.ok) {
                    this._lastGood = normalized;
                    callback(normalized);
                    return;
                }
                callback(this._lastGood
                    ? { ...this._lastGood, cached: true }
                    : normalized);
            } catch (e) {
                logError(e, '[AI Usage] Codex parse');
                callback(this._lastGood
                    ? { ...this._lastGood, cached: true }
                    : { ok: false, error: 'Codex helper error' });
            }
        });
    }
}

// ---------------------------------------------------------------------------
// One panel + menu segment per provider.
// ---------------------------------------------------------------------------

class UsageSegment {
    constructor(provider, extPath, menu) {
        this.provider = provider;

        this.box = new St.BoxLayout({
            style_class: 'aiu-segment',
            y_align: Clutter.ActorAlign.CENTER,
        });

        let iconFile = Gio.File.new_for_path(
            GLib.build_filenamev([extPath, 'icons', provider.icon])
        );
        this.icon = new St.Icon({
            gicon: new Gio.FileIcon({ file: iconFile }),
            style_class: 'system-status-icon aiu-icon',
            icon_size: 16,
        });
        this.box.add_child(this.icon);

        this.shortLabel = this._mkLabel('…');
        this.box.add_child(this.shortLabel);
        this._sep1 = this._mkSep();
        this.box.add_child(this._sep1);
        this.longLabel = this._mkLabel('…');
        this.box.add_child(this.longLabel);
        this._sep2 = this._mkSep();
        this.box.add_child(this._sep2);
        this.resetLabel = this._mkLabel('…', 'claude-usage-reset');
        this.box.add_child(this.resetLabel);

        // Dropdown menu items for this provider.
        this.menuHeader = new PopupMenu.PopupMenuItem(provider.name);
        this.menuHeader.setSensitive(false);
        this.menuHeader.label.add_style_class_name('aiu-menu-header');
        menu.addMenuItem(this.menuHeader);

        this.menuSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this.menuSection);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _mkLabel(text, extra) {
        let cls = 'claude-usage-label' + (extra ? ` ${extra}` : '');
        return new St.Label({
            style_class: cls,
            text,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
    }

    _mkSep() {
        return new St.Label({
            style_class: 'claude-usage-separator',
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
    }

    _addMenuItem(text, styleClass = null) {
        let item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        this.menuSection.addMenuItem(item);
        return item;
    }

    _windowLine(win, indent = '') {
        if (!win) return null;
        let pct = Math.round(win.pct);
        let text = `${indent}${win.label || 'window'}: ${pct}% used · ${Math.max(0, 100 - pct)}% left`;
        if (win.resetMs)
            text += ` · resets in ${formatDuration(win.resetMs - Date.now())}`;
        return text;
    }

    _renderMenu(norm) {
        this.menuSection.removeAll();
        if (!norm?.ok) {
            this._addMenuItem(norm?.error || 'Error', 'aiu-menu-muted');
            return;
        }

        if (norm.short) this._addMenuItem(this._windowLine(norm.short));
        if (norm.long) this._addMenuItem(this._windowLine(norm.long));
        for (let extra of norm.extras || [])
            this._addMenuItem(extra);

        if ((norm.otherLimits || []).length > 0) {
            this._addMenuItem('Other model limits', 'aiu-menu-subheader');
            for (let limit of norm.otherLimits) {
                this._addMenuItem(limit.name || 'Unnamed limit', 'aiu-menu-muted');
                for (let win of limit.windows || [])
                    this._addMenuItem(this._windowLine(win, '  '));
            }
        }

        if (norm.resetCredits != null) {
            this._addMenuItem(`Available full resets: ${norm.resetCredits}`, 'aiu-menu-subheader');
            for (let expiry of norm.resetExpiries || [])
                this._addMenuItem(`  expires in ${formatDuration(expiry - Date.now())}`);
        }

        if (norm.liveSource)
            this._addMenuItem(`Source: ${norm.liveSource} (live)`, 'aiu-menu-muted');
        if (norm.staleMs > STALE_THRESHOLD_MS)
            this._addMenuItem(`Stale fallback data: ${formatDuration(norm.staleMs)} old`, 'aiu-menu-stale');
        if (norm.cached)
            this._addMenuItem('Cached — last refresh failed', 'aiu-menu-stale');
    }

    _setWindow(label, sep, win) {
        if (win && win.pct != null) {
            label.set_text(`${win.label ? win.label + ' ' : ''}${Math.round(win.pct)}%`);
            this._color(label, Math.round(win.pct));
            label.show();
            sep.show();
            return true;
        }
        label.hide();
        sep.hide();
        return false;
    }

    _color(label, pct) {
        label.remove_style_class_name('claude-usage-label-warning');
        label.remove_style_class_name('claude-usage-label-high');
        label.remove_style_class_name('claude-usage-label-critical');
        if (pct >= 90) label.add_style_class_name('claude-usage-label-critical');
        else if (pct >= 80) label.add_style_class_name('claude-usage-label-high');
        else if (pct >= 60) label.add_style_class_name('claude-usage-label-warning');
    }

    update(norm) {
        if (this._destroyed) return;
        this._renderMenu(norm);
        if (!norm || !norm.ok) {
            this.shortLabel.hide();
            this._sep1.hide();
            this.longLabel.set_text('--');
            this._color(this.longLabel, 0);
            this.longLabel.show();
            this._sep2.hide();
            this.resetLabel.set_text(norm?.error || 'error');
            this.resetLabel.show();

            return;
        }

        let hasShort = this._setWindow(this.shortLabel, this._sep1, norm.short);
        let hasLong = this._setWindow(this.longLabel, this._sep2, norm.long);
        if (hasShort && hasLong) this._sep1.show();
        else this._sep1.hide();
        if (hasShort || hasLong) this._sep2.show();
        else this._sep2.hide();

        // Reset timer: prefer the shorter window's reset, else the longer's.
        let resetMs = (norm.short && norm.short.resetMs) || (norm.long && norm.long.resetMs) || 0;
        let staleTag = norm.staleMs > STALE_THRESHOLD_MS ? ' ?' : '';
        let credits = norm.resetCredits != null ? ` · ↻${norm.resetCredits}` : '';
        if (resetMs) {
            let remaining = Math.max(0, resetMs - Date.now());
            this.resetLabel.set_text(`↻ ${formatDuration(remaining)}${credits}${staleTag}`);
        } else {
            this.resetLabel.set_text(`↻ --${credits}${staleTag}`);
        }
        this.resetLabel.show();
    }

    destroy() {
        this._destroyed = true;
        this.box.destroy();
    }
}

// ---------------------------------------------------------------------------
// Panel button hosting all enabled segments.
// ---------------------------------------------------------------------------

const AIUsageButton = GObject.registerClass({
    GTypeName: 'AIUsageButton',
}, class AIUsageButton extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.5, 'AI Usage');

        this._extensionObject = extensionObject;
        this._settings = extensionObject.getSettings();
        this._soupSession = new Soup.Session();
        this._refreshTimeoutId = null;
        this._segments = [];
        this._dividers = [];
        this._emptyLabel = null;

        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box claude-usage-panel aiu-panel',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._buildSegments();
        this._buildMenuFooter();

        this._fetchAll();
        this._initTimer();

        this.menu.connect('open-state-changed', (_self, isOpen) => {
            if (isOpen) this._fetchAll();
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._destroyTimer();
                this._initTimer();
            } else if (key === 'enable-claude' || key === 'enable-codex') {
                this._rebuild();
            }
        });
    }

    _providers() {
        let list = [];
        let path = this._extensionObject.path;
        if (this._settings.get_boolean('enable-claude'))
            list.push(new ClaudeProvider(path, this._settings));
        if (this._settings.get_boolean('enable-codex'))
            list.push(new CodexProvider(path, this._settings));
        return list;
    }

    _buildSegments() {
        let providers = this._providers();
        if (providers.length === 0) {
            this._emptyLabel = new St.Label({
                style_class: 'claude-usage-label',
                text: 'AI Usage: off',
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });
            this._panelBox.add_child(this._emptyLabel);
            return;
        }
        providers.forEach((provider, idx) => {
            if (idx > 0) {
                let div = new St.Label({
                    style_class: 'aiu-divider',
                    text: '|',
                    y_align: Clutter.ActorAlign.CENTER,
                    y_expand: true,
                });
                this._panelBox.add_child(div);
                this._dividers.push(div);
            }
            let seg = new UsageSegment(provider, this._extensionObject.path, this.menu);
            this._segments.push(seg);
            this._panelBox.add_child(seg.box);
        });
    }

    _buildMenuFooter() {
        let refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        refreshItem.connect('activate', () => this._fetchAll());
        this.menu.addMenuItem(refreshItem);

        let claudeLink = new PopupMenu.PopupMenuItem('Open claude.ai usage');
        claudeLink.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://claude.ai/settings/usage', null);
        });
        this.menu.addMenuItem(claudeLink);

        let openaiLink = new PopupMenu.PopupMenuItem('Open ChatGPT usage');
        openaiLink.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://chatgpt.com/#settings/Account', null);
        });
        this.menu.addMenuItem(openaiLink);

        let prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => this._extensionObject.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _rebuild() {
        this._segments.forEach(s => s.destroy());
        this._segments = [];
        this._dividers.forEach(d => d.destroy());
        this._dividers = [];
        if (this._emptyLabel) { this._emptyLabel.destroy(); this._emptyLabel = null; }
        this.menu.removeAll();
        this._buildSegments();
        this._buildMenuFooter();
        this._fetchAll();
    }

    _fetchAll() {
        for (let seg of this._segments)
            seg.provider.fetch(this._soupSession, (norm) => seg.update(norm));
    }

    _initTimer() {
        let interval = this._settings.get_int('refresh-interval');
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._fetchAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _destroyTimer() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
    }

    destroy() {
        this._destroyTimer();
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }
        super.destroy();
    }
});

export default class AIUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._addButton();
        this._positionChangedId = this._settings.connect('changed::position-in-panel', () => {
            this._removeButton();
            this._addButton();
        });
    }

    _addButton() {
        aiUsageMenu = new AIUsageButton(this);
        let position = this._settings.get_string('position-in-panel');
        let pos = position === 'left' ? -1 : (position === 'center' ? -1 : 0);
        let box = position === 'left' ? 'left' : (position === 'center' ? 'center' : 'right');
        Main.panel.addToStatusArea('ai-usage', aiUsageMenu, pos, box);
    }

    _removeButton() {
        if (aiUsageMenu) {
            aiUsageMenu.destroy();
            aiUsageMenu = null;
        }
    }

    disable() {
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        this._removeButton();
        this._settings = null;
    }
}
