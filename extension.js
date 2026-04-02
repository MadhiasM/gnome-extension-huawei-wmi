// Huawei WMI controls

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import UPower from 'gi://UPowerGlib';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const Display = global.display;

const BPM_PROFILES = {
	"Home": [40, 70],
	"Work": [70, 90],
	"Travel": [95, 100],
	"Disabled": [0, 100],
};

const NonClosingPopupSwitchMenuItem = GObject.registerClass(
class NonClosingPopupSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {
	activate(event) {
		this.toggle();
	}
});

const HuaweiWmiIndicator = GObject.registerClass(
class HuaweiWmiIndicator extends PanelMenu.Button { // TODO: move to system battery menu?
	_init(path, settings) {
		super._init(0.0, _("Huawei WMI controls"));

		this._battery_watching = false;
		this._topping_off = false;
		this._fn_led = false;

		this._file_sys_str = "/sys/devices/platform/huawei-wmi/charge_control_thresholds";
		this._file_def_str = "/etc/default/huawei-wmi/charge_control_thresholds";

		this._icon_gear = Gio.icon_new_for_string(`${path}/gear-symbolic.svg`);
		this._icon_gear_lock = Gio.icon_new_for_string(`${path}/gear-lock-symbolic.svg`);

		let hbox = this._icon_box = new St.BoxLayout({style_class: 'panel-status-menu-box'}); {
			let icon = this.icon = new St.Icon({
				gicon: this._icon_gear,
				style_class: 'system-status-icon',
			});
			hbox.add_child(icon);
		}; this.add_child(hbox);

		let bpm = this._bpm = new PopupMenu.PopupSubMenuMenuItem(this._BPM = _("Battery protection mode")); {
			for (let name in BPM_PROFILES) {
				let [low, high] = BPM_PROFILES[name];
				let mi = new PopupMenu.PopupMenuItem(`${_(name)} (${low}%-${high}%)`); {
					mi.connect('activate', () => this._set_bpm(low, high));;
				}; bpm.menu.addMenuItem(mi);
			}

			// TODO: Custom
		}; this.menu.addMenuItem(bpm);

		let top_off = this._top_off = new NonClosingPopupSwitchMenuItem(_("Top off battery"), false); {
			top_off.connect('toggled', (item, state) => this._set_top_off(state));
		}; this.menu.addMenuItem(top_off);

		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		let fn_lock = this._fn_lock = new NonClosingPopupSwitchMenuItem(_("Fn-Lock"), false); {
			fn_lock.connect('toggled', (item, state) => this._set_fn_lock(state));
		}; this.menu.addMenuItem(fn_lock);

		let power_unlock = this._power_unlock = new NonClosingPopupSwitchMenuItem(_("Power unlock"), false); {
			power_unlock.connect('toggled', (item, state) => this._set_power_unlock(state));
		}; this.menu.addMenuItem(power_unlock);

		this.connect('enter-event', () => this._update());
		this.connect('button-press-event', () => this._update());
		this.connect('key-press-event', () => this._update());
		this.menu.connect('open-state-changed', () => {
			if (this._bpm.sensitive) this._bpm.activate();
		});

		this._fullscreen_changed_s = Display.connect('in-fullscreen-changed', this._fullscreen_changed.bind(this));

		this._fn_led_timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 250, () => this._update_fn_led() || true);

		this._camera_hint_timeout = null;
		this._camera_warning_icon = null;
		this._camera_monitor_proc = null;
		this._camera_monitor_stream = null;
		this._camera_monitor_cancellable = null;

		this._bind_keys(settings);

		this._start_camera_monitor();
		this._update();
	}

	destroy() {
		this._unbind_keys();

		if (this._fullscreen_changed_s !== null) Display.disconnect(this._fullscreen_changed_s);
		if (this._fn_led_timeout !== null) GLib.Source.remove(this._fn_led_timeout);
		if (this._camera_hint_timeout !== null) GLib.Source.remove(this._camera_hint_timeout);

		if (this._camera_monitor_cancellable !== null) {
			this._camera_monitor_cancellable.cancel();
			this._camera_monitor_cancellable = null;
		}
		if (this._camera_monitor_proc !== null) {
			this._camera_monitor_proc.force_exit();
			this._camera_monitor_proc = null;
		}
		this._camera_monitor_stream = null;

		this._hide_camera_warning();

		super.destroy();
	}

	_bind_keys(settings) {
		Main.wm.addKeybinding('hwmi-config', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this.menu.toggle.bind(this.menu));
		Main.wm.addKeybinding('hwmi-power-unlock', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this._key_power_unlock.bind(this));
		Main.wm.addKeybinding('hwmi-camera-attached', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this._camera_attached.bind(this));
		Main.wm.addKeybinding('hwmi-camera-detached', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this._camera_detached.bind(this));
		Main.wm.addKeybinding('hwmi-camera-ejected', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this._camera_ejected.bind(this));
		Main.wm.addKeybinding('hwmi-camera-inserted', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this._camera_inserted.bind(this));
	}

	_unbind_keys() {
		Main.wm.removeKeybinding('hwmi-config');
		Main.wm.removeKeybinding('hwmi-power-unlock');
		Main.wm.removeKeybinding('hwmi-camera-attached');
		Main.wm.removeKeybinding('hwmi-camera-detached');
		Main.wm.removeKeybinding('hwmi-camera-ejected');
		Main.wm.removeKeybinding('hwmi-camera-inserted');
	}

	_show_osd(icon, text) {
		icon = Gio.icon_new_for_string(icon);

		if (Config.PACKAGE_VERSION >= '49')
			Main.osdWindowManager.showAll(icon, text);
		else
			Main.osdWindowManager.show(-1, icon, text);
	}

	_fullscreen_changed() {
		let file = Gio.File.new_for_path("/sys/devices/platform/huawei-wmi/kbdlight_timeout");

		try {
			if (Main.layoutManager.primaryMonitor.inFullscreen) {
				let t = Number(new TextDecoder().decode(file.load_contents(null)[1]));
				if (t != 1) this._fullscreen_changed_timeout = t;
				file.replace_contents("2", null, false, 0, null);
			} else {
				file.replace_contents(`${this._fullscreen_changed_timeout || 300}`, null, false, 0, null);
			}
		} catch (e) {
			Display.disconnect(this._fullscreen_changed_s);
			this._fullscreen_changed_s = null;
			return;
		}
	}

	_key_power_unlock() {
		let icon, text;

		let old_state = this._power_unlock.state;
		this._set_power_unlock();

		if (!this._power_unlock.visible) return;

		switch (this._power_unlock.state) {
			case old_state: this._show_osd('battery-caution-symbolic', _("Power Unlock\nunavailable on battery")); break;
			case true: this._show_osd('power-profile-performance-symbolic', _("Performance Mode")); break;
			case false: this._show_osd('power-profile-balanced-symbolic', _("Balanced Mode")); break;
		}
	}

	_start_camera_monitor() {
		try {
			this._camera_monitor_cancellable = new Gio.Cancellable();
			this._camera_monitor_proc = Gio.Subprocess.new(
				['udevadm', 'monitor', '--udev', '--subsystem-match=video4linux'],
				Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
			);
			this._camera_monitor_stream = new Gio.DataInputStream({
				base_stream: this._camera_monitor_proc.get_stdout_pipe(),
			});
			this._read_camera_monitor_output();
		} catch (e) {
			// Clean up any partially-initialised state (e.g. Subprocess created
			// before DataInputStream constructor threw).
			if (this._camera_monitor_proc !== null) {
				this._camera_monitor_proc.force_exit();
				this._camera_monitor_proc = null;
			}
			this._camera_monitor_stream = null;
			if (this._camera_monitor_cancellable !== null) {
				this._camera_monitor_cancellable.cancel();
				this._camera_monitor_cancellable = null;
			}
		}
	}

	_read_camera_monitor_output() {
		if (this._camera_monitor_stream === null) return;

		this._camera_monitor_stream.read_line_async(
			GLib.PRIORITY_DEFAULT_IDLE,
			this._camera_monitor_cancellable,
			(stream, result) => {
				try {
					let [line] = stream.read_line_finish_utf8(result);
					if (line !== null) {
						this._process_udev_line(line);
						this._read_camera_monitor_output();
					}
				} catch (e) {
					// Cancelled or I/O error — stop reading
				}
			}
		);
	}

	_process_udev_line(line) {
		// Only handle actual event lines: "UDEV  [timestamp] action   /path (subsystem)"
		if (!line.startsWith('UDEV  [')) return;
		// Only react to USB cameras; built-in camera modules use keybinding events
		if (!line.includes('/usb')) return;

		if (line.includes('] add ')) this._camera_attached();
		else if (line.includes('] remove ')) this._camera_detached();
	}

	_show_camera_warning() {
		if (this._camera_warning_icon !== null) return;

		this._camera_warning_icon = new St.BoxLayout({
			style: 'background-color: #DD2200; border-radius: 4px;',
			style_class: 'panel-status-menu-box',
		});
		this._camera_warning_icon.add_child(new St.Icon({
			icon_name: 'camera-disabled-symbolic',
			style_class: 'system-status-icon',
		}));
		Main.panel._rightBox.insert_child_at_index(this._camera_warning_icon, 0);
	}

	_hide_camera_warning() {
		if (this._camera_warning_icon === null) return;
		Main.panel._rightBox.remove_child(this._camera_warning_icon);
		this._camera_warning_icon.destroy();
		this._camera_warning_icon = null;
	}

	_camera_ejected() {
		this._show_osd('camera-photo-symbolic', _("Camera ejected"));

		if (this._camera_hint_timeout === null) {
			this._camera_hint_timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
				this._camera_hint_timeout = null;
				this._show_camera_warning();
				return GLib.SOURCE_REMOVE;
			});
		}
	}

	_camera_inserted() {
		this._show_osd('camera-photo-symbolic', _("Camera inserted"));

		if (this._camera_hint_timeout !== null) {
			GLib.Source.remove(this._camera_hint_timeout);
			this._camera_hint_timeout = null;
		}

		this._hide_camera_warning();
	}

	_camera_attached() {
		this._show_osd('camera-photo-symbolic', _("Camera attached"));

		if (this._camera_hint_timeout !== null) {
			GLib.Source.remove(this._camera_hint_timeout);
			this._camera_hint_timeout = null;
		}

		this._hide_camera_warning();
	}

	_camera_detached() {
		this._show_osd('camera-hardware-disabled-symbolic', _("Camera detached"));

		if (this._camera_hint_timeout === null) {
			this._camera_hint_timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
				this._camera_hint_timeout = null;
				this._show_camera_warning();
				return GLib.SOURCE_REMOVE;
			});
		}
	}

	_update() {
		this._set_bpm();
		this._set_fn_lock();
		this._set_power_unlock();
		this._update_fn_led();
		this._set_top_off();
	}

	_update_fn_led() {
		let file = Gio.File.new_for_path("/sys/devices/platform/huawei-wmi/leds/huawei::fn_led/brightness");

		let on;
		try {
			on = Number(new TextDecoder().decode(file.load_contents(null)[1]));
		} catch (e) {
			return;
		}

		if (on != this._fn_led) {
			this._fn_led = on;
			this.icon.set_gicon(on?this._icon_gear_lock:this._icon_gear);
			this._show_osd('preferences-desktop-keyboard-shortcuts-symbolic', _(`Fn-Lock ${on?'on':'off'}`));
		}
	}

	_set_bpm(low, high) {
		let _file_sys = Gio.File.new_for_path(this._file_sys_str);
		let _file_def = Gio.File.new_for_path(this._file_def_str);

		if (low || high)
			try {
				_file_sys.replace_contents(`${low} ${high}`, null, false, 0, null);
				_file_def.replace_contents(`${low} ${high}`, null, false, 0, null);
			} catch (e) {}

		try {
			[low, high] = new TextDecoder().decode(_file_sys.load_contents(null)[1]).split(' ').map(Number);
		} catch (e) {
			this._bpm.setSensitive(false);
			this._bpm.label.set_text(this._BPM);
			return;
		}
		this._bpm.setSensitive(true);
		this._bpm.label.set_text(this._BPM + `: ${low}%-${high}%`);
	}

	_update_top_off() {
		this._get_battery(proxy => {
			let is_discharging = (proxy.State === UPower.DeviceState.DISCHARGING)
			let is_fully_charged = (proxy.State === UPower.DeviceState.FULLY_CHARGED)
			if (is_fully_charged) this._stop_top_off();
			else if (is_discharging) this._stop_top_off();
		})
	}

	_start_top_off() {
		let _file_sys = Gio.File.new_for_path(this._file_sys_str);

		this._get_battery(proxy => {  // Connects watcher
			this._battery_watching = proxy.connect('g-properties-changed', this._update_top_off.bind(this));
			try {
				_file_sys.replace_contents("0 100", null, false, 0, null);
				this._topping_off = true;
			} catch (e) {}
		})
	}

	_stop_top_off() {
		let _file_sys = Gio.File.new_for_path(this._file_sys_str);
		let _file_def = Gio.File.new_for_path(this._file_def_str);

		let def_low, def_high;
		this._get_battery(proxy => {  // Disconnects watcher
			proxy.disconnect(this._battery_watching);
			try {  // Reinstates old BPM values
				[def_low, def_high] = new TextDecoder().decode(_file_def.load_contents(null)[1]).split(' ').map(Number);
				_file_sys.replace_contents(`${def_low} ${def_high}`, null, false, 0, null);
				this._topping_off = false;
			} catch (e) {}
		});
	}

	_get_battery(callback) {
		let menu = Main.panel.statusArea.aggregateMenu;
		if (menu && menu._power) {
			callback(menu._power._proxy, menu._power);
		}
	}

	_set_top_off(state) {
		let _file_sys = Gio.File.new_for_path(this._file_sys_str);
		let _file_def = Gio.File.new_for_path(this._file_def_str);

		let sys_low, sys_high, def_low, def_high;
		let is_discharging;
		this._get_battery(proxy => { is_discharging = (proxy.State === UPower.DeviceState.DISCHARGING) });

		// Check if the button to enable battery top-off should be available and
		// set toggle state depending on the actual values set in /sys and /etc
		try {
			[sys_low, sys_high] = new TextDecoder().decode(_file_sys.load_contents(null)[1]).split(' ').map(Number);
			[def_low, def_high] = new TextDecoder().decode(_file_def.load_contents(null)[1]).split(' ').map(Number);

			if (def_low == 0 && def_high == 100) {  // If BPM == off -> Button = Unavailable and Off
				this._top_off.setToggleState(false);
				this._top_off.setSensitive(false);
			} else if ((def_low != 0 || def_high != 100) && !is_discharging) {  // If BPM is on and device is not discharging -> Button = Available
				this._top_off.setSensitive(true);
				// Check if top-off is active -> Button = On
				let top_is_active = ((def_low != 0 && def_high != 100) && (sys_low == 0 && sys_high == 100));
				if (top_is_active) {
					this._top_off.setToggleState(true);
					if (top_is_active && !this._topping_off) this._start_top_off();  // Reconnects watcher if extension has been restarted without reinstating BPM
				} else this._top_off.setToggleState(false);  // If top is not active -> Button = Off
			} else {  // Reinstates old BPM in case of unclean watcher exit and handles edge cases
				if (def_low != sys_low || def_high != sys_high) this._stop_top_off();
				this._top_off.setToggleState(false);
				this._top_off.setSensitive(false);
			}
		} catch (e) {
			log(e)
			this._top_off.setSensitive(false);
			return;
		}

		// Handle state change
		if (state !== undefined)
			try {
				if (state && !this._topping_off) this._start_top_off();  // Top off switch gets switched on
				else if (!state && this._topping_off) this._stop_top_off();  // Top off switch gets switched off
				this._set_top_off();
			} catch (e) {
				log(e)
			}
	}

	_set_fn_lock(state) {
		let file = Gio.File.new_for_path("/sys/devices/platform/huawei-wmi/fn_lock_state");

		if (state !== null)
			try {
				file.replace_contents(Number(state).toString(), null, false, 0, null);
			} catch (e) {}

		try {
			state = Boolean(Number(new TextDecoder().decode(file.load_contents(null)[1])));
		} catch (e) {
			this._fn_lock.setSensitive(false);
			return;
		}
		this._fn_lock.setSensitive(true);
		this._fn_lock.setToggleState(state);
	}

	_set_power_unlock(state) {
		let file = Gio.File.new_for_path("/sys/devices/platform/huawei-wmi/power_unlock");

		if (state !== null)
			try {
				file.replace_contents(Number(state).toString(), null, false, 0, null);
			} catch (e) {}

		try {
			state = Boolean(Number(new TextDecoder().decode(file.load_contents(null)[1])));
		} catch (e) {
			this._power_unlock.setSensitive(false);
			return;
		}
		this._power_unlock.setSensitive(true);
		this._power_unlock.setToggleState(state);
	}
});

export default class HuaweiWmiExtension extends Extension {
	enable() {
		this._indicator = new HuaweiWmiIndicator(this.path, this.getSettings());
		Main.panel.addToStatusArea(this.uuid, this._indicator);
	}

	disable() {
		this._indicator.destroy();
		this._indicator = null;
	}
}

// by Sdore, 2021-26
//   apps.sdore.me
