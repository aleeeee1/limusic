// App-wide keyboard shortcuts. One window listener: the event is turned into a canonical combo
// (keycombo.ts) and looked up in the editable bindings (keybinds.svelte.ts), so what Settings > the
// shortcuts list shows is exactly what fires. Zoom keeps its own listener (zoom.svelte.ts) because
// it also owns the ctrl+wheel gesture, and the global OS-level hotkeys live in hotkeys.svelte.ts.
import * as api from './api';
import {
	cycleRepeat,
	np,
	nudgeVolume,
	playback,
	refreshView,
	skipBy,
	toggleMute,
	toggleNowPlayingRating,
	ui
} from './player.svelte';
import { keybinds } from './keybinds.svelte';
import { comboFromEvent, isLocalBindable, parseCombo, IS_MAC } from './keycombo';
import { setZoom, stepZoom } from './zoom.svelte';

export { IS_MAC };

/** What a key event means, whatever layout is active. A Latin letter is used as typed (so Dvorak and
 *  AZERTY keep working); a character from another script (й, р, ю, б) falls back to the physical key
 *  from e.code. Everything else (named keys, digits, symbols) is returned as e.key. */
export const keyOf = (e: KeyboardEvent): string => {
	const k = e.key;
	if (k.length === 1 && /[a-z]/i.test(k)) return k.toLowerCase();
	const nonAscii = k.length === 1 && k.charCodeAt(0) > 127;
	if (!nonAscii) return k;
	if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
	if (e.code === 'Period') return '.';
	if (e.code === 'Comma') return ',';
	if (e.code === 'Slash') return '/';
	return k;
};

/** Seconds per ← / → press, the same jump as the global seek hotkeys. */
export const SEEK_SECS = 10;

/** Focused things that use the arrow keys themselves. */
const ARROW_OWNERS =
	'input,textarea,select,[contenteditable],[role=slider],[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tablist],[role=radiogroup]';

/** Percent per press, matching a step of the volume slider's arrow keys. */
const VOLUME_STEP = 5;

const ARROWS: Record<string, () => void> = {
	ArrowLeft: () => skipBy(-SEEK_SECS),
	ArrowRight: () => skipBy(SEEK_SECS),
	ArrowUp: () => nudgeVolume(VOLUME_STEP),
	ArrowDown: () => nudgeVolume(-VOLUME_STEP)
};

/** Somewhere a bare space or `;` is a character, not a command. A slider (seek bar, volume) is an
 *  input but types nothing, so a click on it no longer leaves Space dead (#574). */
export const typing = (t: EventTarget | null) =>
	t instanceof HTMLElement &&
	(t.isContentEditable ||
		['TEXTAREA', 'SELECT'].includes(t.tagName) ||
		(t instanceof HTMLInputElement && t.type !== 'range'));

/** Where focus a click left behind stays put: see `onFocus` below. */
const KEEPS_FOCUS =
	'[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-selected],[data-track-selection]';

/** The mini window renders none of the chrome these toggle, and it has no page to reload, so it
 *  keeps the bindings for everything else but not these. */
const MINI_EXCLUDED: Record<string, true> = {
	// No page to reload.
	refresh: true,
	// None of this chrome exists in the widget.
	search: true,
	now_playing: true,
	show_list: true,
	// The widget is a fixed-size card; it never initializes zoom.
	zoom_in: true,
	zoom_out: true,
	reset_zoom: true
};

export function initShortcuts(mini = false) {
	keybinds.load();
	const onKey = (e: KeyboardEvent) => {
		// Focused controls (including track selection) have already handled this key.
		if (e.defaultPrevented) return;
		// A rebind owns the keyboard. It stops propagation as well; this is belt and braces.
		if (keybinds.recording) return;
		// ← / → seek, 10 s like the global hotkeys (#570), ↑ / ↓ step the volume. Bare arrows are
		// not in the editable list (they are modifiers of "playback in progress", not commands the
		// user rebinds), and they never fire while something focused owns them: a field, a slider
		// (volume, seek bar), a menu, a list, a dialog. With nothing playing, ↑ / ↓ scroll the page.
		if (!e.ctrlKey && !e.metaKey) {
			const arrow = ARROWS[e.key];
			if (arrow) {
				if (!playback.now || typing(e.target) || e.altKey || e.shiftKey) return;
				if (e.target instanceof HTMLElement && e.target.closest(ARROW_OWNERS)) return;
				arrow();
				e.preventDefault();
				return;
			}
		}
		const combo = comboFromEvent(e);
		if (!combo) return;
		const action = keybinds.actionFor(combo);
		if (!action) return;
		if (mini && MINI_EXCLUDED[action]) return;
		// A combo the recorder refuses to save never fires; the shared predicate keeps the two in
		// step (it drops Shift+<bare key> and Ctrl/Super+Alt).
		if (!isLocalBindable(combo)) return;
		const bare = !(e.ctrlKey || e.metaKey || e.altKey);
		// A bare key is a character in a field. F-keys are the exception: nothing types with them,
		// so like a browser's reload, F5 works from a field too.
		if (bare && !/^F\d/.test(parseCombo(combo).key) && typing(e.target)) return;
		switch (action) {
			// Real quit, unlike the window's X which hides to tray.
			case 'quit_app':
				// Holding the keys auto-repeats keydown; one quit request is enough.
				if (!e.repeat) api.quitApp();
				break;
			case 'refresh':
				refreshView();
				break;
			case 'play_pause':
				api.togglePause();
				break;
			// Toggles, so the key that opened the palette also dismisses it.
			case 'search':
				ui.paletteOpen = !ui.paletteOpen;
				break;
			// With nothing playing there is no view to open (the layout renders it behind
			// `playback.now`), and flipping the flag anyway would ambush the next play.
			case 'now_playing':
				if (!playback.now) return;
				np.open = !np.open;
				break;
			// #621. A local file has no YouTube identity to rate, as in the player bar.
			case 'like':
				if (!playback.now || api.isLocalId(playback.now.videoId)) return;
				toggleNowPlayingRating();
				break;
			case 'next':
				api.nextTrack();
				break;
			case 'prev':
				api.prevTrack();
				break;
			case 'shuffle':
				api.toggleShuffle();
				break;
			case 'repeat':
				cycleRepeat();
				break;
			case 'mute':
				toggleMute();
				break;
			case 'volume_up':
				nudgeVolume(VOLUME_STEP);
				break;
			case 'volume_down':
				nudgeVolume(-VOLUME_STEP);
				break;
			case 'show_list':
				ui.shortcutsOpen = !ui.shortcutsOpen;
				break;
			// Zoom is matched here like everything else, but deliberately does not preventDefault:
			// the webview's own ctrl+wheel/zoom polyfill still runs underneath, and `setZoom` is what
			// clamps the level to the app's own ceiling (see zoom.svelte.ts).
			case 'zoom_in':
				stepZoom(1);
				return;
			case 'zoom_out':
				stepZoom(-1);
				return;
			case 'reset_zoom':
				setZoom(1);
				return;
			default:
				return;
		}
		e.preventDefault();
	};
	// A click leaves focus on what it hit (a track row, a tab, the artwork), and every key after it
	// went there: Space replayed the clicked row instead of pausing (#551), Enter clicked the artwork
	// again, and the keypress lit a focus ring. So focus that lands while the pointer is driving is
	// dropped, including a menu handing it back to its trigger on close. Fields keep it, and so do open
	// menus, lists and dialogs, and track select mode (its rows and bar take Space, Escape and Ctrl+A
	// themselves). Tab hands focus back to the keyboard until the next click, so the app can still be
	// walked with a ring.
	let pointer = true;
	const onPointer = () => (pointer = true);
	const onTab = (e: KeyboardEvent) => {
		if (e.key === 'Tab') pointer = false;
	};
	const onFocus = (e: FocusEvent) => {
		const t = e.target;
		if (!pointer || !(t instanceof HTMLElement) || typing(t)) return;
		if (t.closest(KEEPS_FOCUS)) return;
		// On the next tick, not here: WebKit and Chromium count focus moved inside a focus handler
		// as a blocked focus change and swallow the mousedown that caused it, so no drag could start
		// on a track row, a queue row or a card. Unless focus has already gone somewhere else.
		setTimeout(() => document.activeElement === t && t.blur());
	};
	window.addEventListener('keydown', onKey);
	window.addEventListener('pointerdown', onPointer, true);
	window.addEventListener('keydown', onTab, true);
	window.addEventListener('focusin', onFocus);
	return () => {
		window.removeEventListener('keydown', onKey);
		window.removeEventListener('pointerdown', onPointer, true);
		window.removeEventListener('keydown', onTab, true);
		window.removeEventListener('focusin', onFocus);
	};
}
