import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class HuaweiWmiPreferences extends ExtensionPreferences {
	fillPreferencesWindow(window) {
		let settings = this.getSettings();
		let page = new Adw.PreferencesPage({
			title: 'Quick Settings',
			icon_name: 'preferences-system-symbolic',
		});
		let group = new Adw.PreferencesGroup({
			title: 'Huawei WMI controls',
			description: 'Choose which controls are available in Quick Settings.',
		});

		let fnLock = new Adw.SwitchRow({ title: 'Fn-Lock tile' });
		let batteryMode = new Adw.SwitchRow({ title: 'Battery mode tile' });
		let batterySettings = new Adw.SwitchRow({
			title: 'Settings button',
			subtitle: 'Show the settings button in the expanded battery mode view.',
		});

		settings.bind('show-fn-lock-tile', fnLock, 'active', 0);
		settings.bind('show-battery-mode-tile', batteryMode, 'active', 0);
		settings.bind('show-battery-settings', batterySettings, 'active', 0);

		group.add(fnLock);
		group.add(batteryMode);
		group.add(batterySettings);
		page.add(group);
		window.add(page);
	}
}
