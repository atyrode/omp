import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function childModels(agent: string, sharedDefault: boolean): Promise<string[]> {
	const root = mkdtempSync(path.join(tmpdir(), "omp-retry-role-"));
	try {
		const home = path.join(root, "home");
		const repo = path.join(root, "repo");
		const configDir = path.join(repo, ".omp");
		mkdirSync(home);
		mkdirSync(path.join(configDir, "extensions"), { recursive: true });
		mkdirSync(path.join(configDir, "agents"));
		const parent = sharedDefault ? "fixture-lead/model" : "fixture-parent/model";
		writeFileSync(
			path.join(configDir, "config.yml"),
			JSON.stringify({
				async: { enabled: false },
				advisor: { enabled: false },
				autolearn: { enabled: false },
				branchSummary: { enabled: false },
				checkpoint: { enabled: false },
				startup: { checkUpdate: false },
				marketplace: { autoUpdate: "off" },
				mcp: { enabled: false },
				disabledProviders: ["ollama", "llama.cpp", "lm-studio"],
				modelRoles: {
					default: parent,
					left: "fixture-lead/model",
					right: "fixture-lead/model",
					solo: "fixture-lead/model",
				},
				retry: {
					enabled: true,
					modelFallback: true,
					usageAwareFallback: false,
					maxRetries: 0,
					baseDelayMs: 0,
					maxDelayMs: 1,
					fallbackChains: {
						default: ["fixture-default/model"],
						left: ["fixture-left/model"],
						right: ["fixture-right/model"],
						solo: [],
					},
				},
				task: { batch: false, maxRuntimeMs: 20000, agentModelOverrides: { [agent]: `@${agent}` } },
			}),
		);
		writeFileSync(
			path.join(configDir, "agents", `${agent}.md`),
			`---\nname: ${agent}\ndescription: Retry role fixture\nmodel: "@default"\ntools: []\n---\nSubmit your result with yield.\n`,
		);
		copyFileSync(
			path.join(import.meta.dir, "fixtures/subagent-retry-role-provider.ts"),
			path.join(configDir, "extensions/provider.ts"),
		);
		const log = path.join(root, "models.txt");
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "../src/cli.ts"),
				"--model",
				parent,
				"--cwd",
				repo,
				"--thinking",
				"off",
				"--no-session",
				"--no-lsp",
				"--no-title",
				"--print",
				"Spawn the fixture child.",
			],
			{
				cwd: repo,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 45000,
				env: {
					HOME: home,
					PATH: process.env.PATH ?? "",
					TERM: "dumb",
					LANG: "C.UTF-8",
					TMPDIR: root,
					XDG_CONFIG_HOME: path.join(home, ".config"),
					XDG_DATA_HOME: path.join(home, ".local/share"),
					XDG_CACHE_HOME: path.join(home, ".cache"),
					XDG_STATE_HOME: path.join(home, ".local/state"),
					RETRY_ROLE_AGENT: agent,
					RETRY_ROLE_LOG: log,
				},
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, `${stdout}\n${stderr}`).toBe(0);
		return readFileSync(log, "utf8").trim().split("\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("child retries keep distinct role chains even when both share the parent model", async () => {
	expect(await childModels("left", true)).toEqual(["fixture-lead/model", "fixture-left/model"]);
	expect(await childModels("right", true)).toEqual(["fixture-lead/model", "fixture-right/model"]);
}, 100000);

test("an empty child role chain cannot borrow the parent's or a sibling's chain", async () => {
	expect(await childModels("solo", true)).toEqual(["fixture-lead/model"]);
	expect(await childModels("solo", false)).toEqual(["fixture-lead/model"]);
}, 100000);
