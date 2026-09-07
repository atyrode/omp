import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI start listeners", () => {
	it("fires registered hooks on initial start and restart", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		tui.addStartListener(() => {
			starts++;
		});

		expect(starts).toBe(0);

		try {
			tui.start();
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("waits until restart for hooks registered while stopped", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		try {
			tui.start();
			tui.stop();
			tui.addStartListener(() => starts++);
			expect(starts).toBe(0);
			tui.start();
			expect(starts).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("runs a hook registered by another startup hook only once per start", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		const listener = () => starts++;
		tui.addStartListener(() => tui.addStartListener(listener));
		try {
			tui.start();
			expect(starts).toBe(1);
			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});
});
