import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createScheduler, DEFAULT_POLL_INTERVAL_MS} from './lib/core/scheduler.js';
import {createThresholdNotifier} from './lib/core/notifications.js';
import {createClaudeProvider} from './lib/providers/claude.js';
import {createCodexProvider} from './lib/providers/codex.js';
import {readTextFile} from './lib/runtime/fs.js';
import {createFetch} from './lib/runtime/fetch.js';
import {buildUsageViewModel, PANEL_LABEL_MODES} from './lib/ui/render.js';

const FILL_CLASSES = {
    green: 'usage-fill-green',
    yellow: 'usage-fill-yellow',
    red: 'usage-fill-red',
};

function createWindowWidgets() {
    const box = new St.BoxLayout({
        vertical: true,
        style_class: 'usage-window-row',
    });

    const label = new St.Label({style_class: 'usage-window-label'});

    const track = new St.BoxLayout({style_class: 'usage-progress-track'});
    track.set_x_expand(true);
    const fill = new St.Widget({style_class: 'usage-fill-green'});
    fill._remainingPct = 0;
    track.add_child(fill);

    track.connect('notify::allocation', () => {
        const node = track.get_theme_node();
        if (!node) return;
        const contentBox = node.get_content_box(track.get_allocation_box());
        const contentWidth = contentBox.x2 - contentBox.x1;
        if (contentWidth > 0)
            fill.set_width(Math.round(contentWidth * fill._remainingPct / 100));
    });

    const infoRow = new St.BoxLayout({style_class: 'usage-info-row'});
    infoRow.set_x_expand(true);
    const remainingLabel = new St.Label({text: '-- left'});
    const resetsLabel = new St.Label({text: '--'});
    const spacer = new St.Widget();
    spacer.set_x_expand(true);
    infoRow.add_child(remainingLabel);
    infoRow.add_child(spacer);
    infoRow.add_child(resetsLabel);

    box.add_child(label);
    box.add_child(track);
    box.add_child(infoRow);

    return {box, label, track, fill, remainingLabel, resetsLabel};
}

function createServiceSection() {
    const container = new St.BoxLayout({vertical: true, style_class: 'usage-service-card'});

    const header = new St.BoxLayout({style_class: 'usage-service-header'});
    const nameLabel = new St.Label({style_class: 'usage-service-name'});
    header.add_child(nameLabel);

    const window0 = createWindowWidgets();
    const window1 = createWindowWidgets();

    const warningLabel = new St.Label({style_class: 'usage-warning'});
    warningLabel.hide();

    container.add_child(header);
    container.add_child(window0.box);
    container.add_child(window1.box);
    container.add_child(warningLabel);

    return {container, nameLabel, windows: [window0, window1], warningLabel};
}

const MODE_LABELS = {
    'min': 'All (minimum)',
    'claude-session': 'Claude Session',
    'claude-weekly': 'Claude Weekly',
    'codex-session': 'Codex Session',
    'codex-weekly': 'Codex Weekly',
};

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(scheduler, settings) {
        super._init(0.0, 'Usage Indicator');

        this._scheduler = scheduler;
        this._settings = settings;
        this._lastSummary = null;
        this._timerSourceId = 0;
        this._modeItems = [];

        this._label = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._buildPopup();
        this._startRelativeTimeTimer();

        this._settingsChangedId = this._settings.connect('changed::panel-label-mode', () => {
            this._updateOrnaments();
            this._refreshRelativeTimes();
        });
    }

    _buildPopup() {
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._popupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'usage-popup-box',
        });

        this._codexSection = createServiceSection();
        this._codexSection.nameLabel.text = 'Codex';

        this._claudeSection = createServiceSection();
        this._claudeSection.nameLabel.text = 'Claude';

        const separator = new St.Widget({style_class: 'usage-separator'});
        separator.set_x_expand(true);

        const footerRow = new St.BoxLayout({style_class: 'usage-footer-row'});
        footerRow.set_x_expand(true);
        this._versionLabel = new St.Label({text: 'brainusage 0.0.1'});
        this._nextUpdateLabel = new St.Label({text: 'Next update in --'});
        const footerSpacer = new St.Widget();
        footerSpacer.set_x_expand(true);
        footerRow.add_child(this._versionLabel);
        footerRow.add_child(footerSpacer);
        footerRow.add_child(this._nextUpdateLabel);

        this._popupBox.add_child(this._codexSection.container);
        this._popupBox.add_child(this._claudeSection.container);
        this._popupBox.add_child(separator);
        this._popupBox.add_child(footerRow);

        menuItem.add_child(this._popupBox);
        this.menu.addMenuItem(menuItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshSignalId = refreshItem.connect('activate', () => {
            void this._scheduler?.refresh();
        });
        this._refreshItem = refreshItem;
        this.menu.addMenuItem(refreshItem);

        this._buildDisplaySubmenu();
    }

    _buildDisplaySubmenu() {
        this._displaySubmenu = new PopupMenu.PopupSubMenuMenuItem('Panel display');
        this._modeItems = [];

        for (const mode of PANEL_LABEL_MODES) {
            const item = new PopupMenu.PopupMenuItem(MODE_LABELS[mode] ?? mode);
            item._modeKey = mode;
            item.connect('activate', () => {
                this._settings.set_string('panel-label-mode', mode);
            });
            this._modeItems.push(item);
            this._displaySubmenu.menu.addMenuItem(item);
        }

        this._updateOrnaments();
        this.menu.addMenuItem(this._displaySubmenu);
    }

    _updateOrnaments() {
        const current = this._settings.get_string('panel-label-mode');
        for (const item of this._modeItems) {
            item.setOrnament(
                item._modeKey === current
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE,
            );
        }
    }

    _startRelativeTimeTimer() {
        this._timerSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this._refreshRelativeTimes();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _refreshRelativeTimes() {
        if (!this._lastSummary)
            return;

        this._applyViewModel(buildUsageViewModel(this._lastSummary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            panelLabelMode: this._settings.get_string('panel-label-mode'),
        }));
    }

    render(summary) {
        this._lastSummary = summary;
        this._applyViewModel(buildUsageViewModel(summary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            panelLabelMode: this._settings.get_string('panel-label-mode'),
        }));
    }

    _applyViewModel(vm) {
        this._label.text = vm.panelLabel;

        const sections = [this._codexSection, this._claudeSection];

        for (let i = 0; i < vm.services.length; i++) {
            const svc = vm.services[i];
            const section = sections[i];

            section.nameLabel.text = svc.name;

            for (let j = 0; j < svc.windows.length; j++) {
                const w = svc.windows[j];
                const widgets = section.windows[j];

                widgets.label.text = w.label;
                widgets.fill.style_class = FILL_CLASSES[w.dotColor] ?? 'usage-fill-red';
                widgets.fill._remainingPct = w.remainingPct;
                widgets.remainingLabel.text = w.remainingText;
                widgets.resetsLabel.text = w.resetsInText;

                const node = widgets.track.get_theme_node();
                if (node) {
                    const contentBox = node.get_content_box(widgets.track.get_allocation_box());
                    const contentWidth = contentBox.x2 - contentBox.x1;
                    if (contentWidth > 0)
                        widgets.fill.set_width(Math.round(contentWidth * w.remainingPct / 100));
                }
            }

            if (svc.warning) {
                section.warningLabel.text = svc.warning;
                section.warningLabel.show();
            } else {
                section.warningLabel.hide();
            }
        }

        this._versionLabel.text = vm.version;
        this._nextUpdateLabel.text = vm.lastUpdate;
    }

    destroy() {
        if (this._timerSourceId) {
            GLib.source_remove(this._timerSourceId);
            this._timerSourceId = 0;
        }

        if (this._refreshSignalId && this._refreshItem) {
            this._refreshItem.disconnect(this._refreshSignalId);
            this._refreshSignalId = null;
        }

        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._settings = null;
        super.destroy();
    }
});

export default class UsageLimitsExtension extends Extension {
    enable() {
        this._fetchRuntime = createFetch();
        const fetchImpl = this._fetchRuntime.fetch;
        const fileReader = readTextFile;

        const claude = createClaudeProvider({
            fetch: fetchImpl,
            readTextFile: fileReader,
        });
        const codex = createCodexProvider({
            fetch: fetchImpl,
            readTextFile: fileReader,
        });
        this._thresholdNotifier = createThresholdNotifier({
            notifyFn: (title, body) => {
                Main.notify(title, body);
            },
        });

        this._scheduler = createScheduler({
            providers: {claude, codex},
            onUpdate: (summary) => {
                this._indicator?.render(summary);
                this._thresholdNotifier?.evaluate(summary);
            },
        });

        this._settings = this.getSettings();
        this._indicator = new UsageIndicator(this._scheduler, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._scheduler.start();
    }

    disable() {
        this._scheduler?.stop();
        this._scheduler = null;
        this._thresholdNotifier = null;

        this._fetchRuntime?.dispose();
        this._fetchRuntime = null;

        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
