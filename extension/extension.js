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
import {fetch} from './lib/runtime/fetch.js';
import {buildUsageViewModel} from './lib/ui/render.js';

const DOT_CLASSES = {
    green: 'usage-dot-green',
    yellow: 'usage-dot-yellow',
    red: 'usage-dot-red',
};

function createWindowWidgets() {
    const box = new St.BoxLayout({
        vertical: true,
        style_class: 'usage-window-row',
    });

    const labelRow = new St.BoxLayout({
        style_class: 'usage-window-label-row',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const label = new St.Label({style_class: 'usage-window-label'});
    const dot = new St.Widget({style_class: 'usage-dot-red'});
    dot.set_y_align(Clutter.ActorAlign.CENTER);
    labelRow.add_child(label);
    labelRow.add_child(dot);

    const track = new St.BoxLayout({style_class: 'usage-progress-track'});
    track.set_x_expand(true);
    const fill = new St.Widget({style_class: 'usage-progress-fill'});
    track.add_child(fill);

    const infoRow = new St.BoxLayout({style_class: 'usage-info-row'});
    infoRow.set_x_expand(true);
    const remainingLabel = new St.Label({text: '-- left'});
    const resetsLabel = new St.Label({text: '--'});
    const spacer = new St.Widget();
    spacer.set_x_expand(true);
    infoRow.add_child(remainingLabel);
    infoRow.add_child(spacer);
    infoRow.add_child(resetsLabel);

    box.add_child(labelRow);
    box.add_child(track);
    box.add_child(infoRow);

    return {box, label, dot, track, fill, remainingLabel, resetsLabel};
}

function createServiceSection() {
    const container = new St.BoxLayout({vertical: true});

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

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(scheduler) {
        super._init(0.0, 'Usage Indicator');

        this._scheduler = scheduler;
        this._lastSummary = null;
        this._timerSourceId = 0;

        this._label = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._buildPopup();
        this._startRelativeTimeTimer();
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

        const separator1 = new St.Widget({style_class: 'usage-separator'});
        separator1.set_x_expand(true);

        const separator2 = new St.Widget({style_class: 'usage-separator'});
        separator2.set_x_expand(true);

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
        this._popupBox.add_child(separator1);
        this._popupBox.add_child(this._claudeSection.container);
        this._popupBox.add_child(separator2);
        this._popupBox.add_child(footerRow);

        menuItem.add_child(this._popupBox);
        this.menu.addMenuItem(menuItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshSignalId = refreshItem.connect('activate', () => {
            void this._scheduler?.refresh();
        });
        this._refreshItem = refreshItem;
        this.menu.addMenuItem(refreshItem);
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
        }));
    }

    render(summary) {
        this._lastSummary = summary;
        this._applyViewModel(buildUsageViewModel(summary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
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
                widgets.dot.style_class = DOT_CLASSES[w.dotColor] ?? 'usage-dot-red';
                widgets.remainingLabel.text = w.remainingText;
                widgets.resetsLabel.text = w.resetsInText;

                const trackWidth = widgets.track.get_width();
                if (trackWidth > 0)
                    widgets.fill.set_width(Math.round(trackWidth * w.remainingPct / 100));
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

        super.destroy();
    }
});

export default class UsageLimitsExtension extends Extension {
    enable() {
        const fetchImpl = fetch;
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

        this._indicator = new UsageIndicator(this._scheduler);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._scheduler.start();
    }

    disable() {
        this._scheduler?.stop();
        this._scheduler = null;
        this._thresholdNotifier = null;

        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
    }
}
