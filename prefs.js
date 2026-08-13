import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/shell/extensions/prefs.js';

export default class AIUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings();

        // --- Providers Page ---
        let provPage = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'view-list-symbolic',
        });
        window.add(provPage);

        // Claude
        let claudeGroup = new Adw.PreferencesGroup({
            title: 'Claude (Anthropic)',
            description: 'Usage is pulled live from api.anthropic.com/api/oauth/usage using your Claude Code OAuth token.',
        });
        provPage.add(claudeGroup);

        let claudeToggle = new Adw.SwitchRow({
            title: 'Show Claude usage',
        });
        settings.bind('enable-claude', claudeToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        claudeGroup.add(claudeToggle);

        let claudeStatus = this._checkClaude();
        let claudeStatusRow = new Adw.ActionRow({
            title: 'Token auto-detect',
            subtitle: claudeStatus.found
                ? `Found token (${claudeStatus.prefix}…)`
                : 'No ~/.claude/.credentials.json token found — set one below',
        });
        claudeStatusRow.add_suffix(new Gtk.Image({
            icon_name: claudeStatus.found ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        claudeGroup.add(claudeStatusRow);

        let tokenRow = new Adw.EntryRow({
            title: 'Manual Claude token (optional)',
            show_apply_button: true,
        });
        tokenRow.set_text(settings.get_string('session-key'));
        tokenRow.connect('apply', () => {
            settings.set_string('session-key', tokenRow.get_text());
        });
        claudeGroup.add(tokenRow);

        // Codex
        let codexGroup = new Adw.PreferencesGroup({
            title: 'Codex (OpenAI / ChatGPT)',
            description: 'OpenAI exposes no live usage endpoint, so this reads the rate_limits snapshot from your newest ~/.codex/sessions rollout. It costs no quota and needs no token, but is only as fresh as your last Codex turn (staleness is shown when > 5 min old).',
        });
        provPage.add(codexGroup);

        let codexToggle = new Adw.SwitchRow({
            title: 'Show Codex usage',
        });
        settings.bind('enable-codex', codexToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        codexGroup.add(codexToggle);

        let codexStatus = this._checkCodex();
        let codexStatusRow = new Adw.ActionRow({
            title: 'Rollout auto-detect',
            subtitle: codexStatus.found
                ? `Found ${codexStatus.count} rollout file(s) under ~/.codex/sessions`
                : 'No ~/.codex/sessions rollouts found — run Codex at least once',
        });
        codexStatusRow.add_suffix(new Gtk.Image({
            icon_name: codexStatus.found ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        codexGroup.add(codexStatusRow);

        // --- Settings Page ---
        let settingsPage = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(settingsPage);

        let displayGroup = new Adw.PreferencesGroup({ title: 'Display' });
        settingsPage.add(displayGroup);

        let refreshRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'How often to refresh usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 600,
                step_increment: 30,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(refreshRow);

        let positionModel = new Gtk.StringList();
        positionModel.append('left');
        positionModel.append('center');
        positionModel.append('right');
        let positionRow = new Adw.ComboRow({
            title: 'Position in panel',
            subtitle: 'Where to show the indicator',
            model: positionModel,
        });
        let currentPos = settings.get_string('position-in-panel');
        positionRow.set_selected(currentPos === 'left' ? 0 : (currentPos === 'center' ? 1 : 2));
        positionRow.connect('notify::selected', () => {
            let positions = ['left', 'center', 'right'];
            settings.set_string('position-in-panel', positions[positionRow.get_selected()]);
        });
        displayGroup.add(positionRow);
    }

    _checkClaude() {
        try {
            let path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
            let [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
            if (ok) {
                let json = JSON.parse(new TextDecoder().decode(contents));
                let token = json?.claudeAiOauth?.accessToken;
                if (token) return { found: true, prefix: token.substring(0, 15) };
            }
        } catch (e) {
            // not found
        }
        return { found: false };
    }

    _checkCodex() {
        try {
            let base = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'sessions']);
            let count = this._countRollouts(Gio.File.new_for_path(base), 0);
            return { found: count > 0, count };
        } catch (e) {
            return { found: false, count: 0 };
        }
    }

    // Shallow recursive count of rollout-*.jsonl (depth-limited to year/month/day).
    _countRollouts(dir, depth) {
        let total = 0;
        let en;
        try {
            en = dir.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return 0;
        }
        let info;
        while ((info = en.next_file(null)) !== null) {
            let name = info.get_name();
            if (info.get_file_type() === Gio.FileType.DIRECTORY && depth < 3) {
                total += this._countRollouts(dir.get_child(name), depth + 1);
            } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
                total += 1;
            }
            if (total > 999) break;
        }
        en.close(null);
        return total;
    }
}
