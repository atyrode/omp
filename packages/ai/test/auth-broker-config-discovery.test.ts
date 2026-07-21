import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthAccountAllowlist, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_AUTH_BROKER_ENV = {
	OMP_AUTH_BROKER_URL: undefined,
	OMP_AUTH_BROKER_TOKEN: undefined,
} as const;

const SUPPRESS_ALLOWLIST_ENV = {
	OMP_AUTH_ACCOUNT_ALLOWLIST_FILE: undefined,
} as const;

describe("resolveAuthBrokerConfig config discovery", () => {
	let agentDir = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-broker-config-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
	});

	test("resolves broker URL and token from config.yaml when config.yml is absent", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yaml-broker.example/v1",
				token: "yaml-token",
			});
		});
	});

	test("prefers config.yml over config.yaml when both exist", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://yml-broker.example/v1\nauth.broker.token: yml-token\n",
		);

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yml-broker.example/v1",
				token: "yml-token",
			});
		});
	});
});

describe("resolveAuthAccountAllowlist", () => {
	let agentDir = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-account-allowlist-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
	});

	test("returns undefined only when the policy variable is unset", async () => {
		await withEnv(SUPPRESS_ALLOWLIST_ENV, async () => {
			await expect(resolveAuthAccountAllowlist()).resolves.toBeUndefined();
		});
	});

	test("loads provider identities into exact-match sets", async () => {
		const policyPath = path.join(agentDir, "allowlist.json");
		await Bun.write(
			policyPath,
			JSON.stringify({
				"openai-codex": ["account:allowed"],
				anthropic: [],
			}),
		);

		await withEnv({ OMP_AUTH_ACCOUNT_ALLOWLIST_FILE: policyPath }, async () => {
			const policy = await resolveAuthAccountAllowlist();
			expect([...policy!]).toEqual([
				["openai-codex", new Set(["account:allowed"])],
				["anthropic", new Set()],
			]);
		});
	});

	test.each([
		["an empty path", "", /must name a JSON file/],
		["a missing file", path.join(os.tmpdir(), "definitely-missing-omp-allowlist.json"), /Unable to read/],
		["malformed JSON", "malformed.json", /Invalid JSON/],
		["a top-level array", "array.json", /expected a JSON object/],
		["a scalar provider value", "scalar.json", /must map to a string array/],
		["a mixed provider array", "mixed.json", /must map to a string array/],
	] as const)("fails closed for %s", async (_label, configuredPath, expected) => {
		let policyPath = configuredPath;
		if (configuredPath === "malformed.json") {
			policyPath = path.join(agentDir, configuredPath);
			await Bun.write(policyPath, "{");
		} else if (configuredPath === "array.json") {
			policyPath = path.join(agentDir, configuredPath);
			await Bun.write(policyPath, "[]");
		} else if (configuredPath === "scalar.json") {
			policyPath = path.join(agentDir, configuredPath);
			await Bun.write(policyPath, '{"anthropic":"account:a"}');
		} else if (configuredPath === "mixed.json") {
			policyPath = path.join(agentDir, configuredPath);
			await Bun.write(policyPath, '{"anthropic":["account:a",7]}');
		}

		await withEnv({ OMP_AUTH_ACCOUNT_ALLOWLIST_FILE: policyPath }, async () => {
			await expect(resolveAuthAccountAllowlist()).rejects.toThrow(expected);
		});
	});
});
